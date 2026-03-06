import { createLogger } from "@/lib/observability";
import { runJsonAgent } from "../../agents/planner/llm-runner";
import { getCurrentDateTimeContext } from "../../agents/planner/current-datetime-tool";
import { formatObjectiveBlock } from "../../agents/planner/objective";
import {
  getAllowedWidgetTypes,
  getConnectorType,
  getRelationshipSummary,
} from "../../agents/planner/schema-utils";
import { formatCapabilitiesForPrompt } from "../../agents/planner/schema-capabilities";
import {
  buildCapabilityChecklist,
  buildCurrentDateContextBlock,
  buildQueryIntentHints,
  buildEnabledFilterBlock,
} from "./prompting";
import {
  buildDataScientistGuidance,
  buildDatabaseExpertGuidance,
} from "./expert-guidance";
import type {
  PlannerSubagent,
  PlannerSubagentContext,
  FinalPlanInput,
  FinalPlanOutput,
} from "./types";

const log = createLogger("subagents.planner.final-plan");
const HUMAN_PROMPT_BUDGET = 6800;

function clipText(value: string, maxChars: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  if (maxChars <= 20) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 15).trimEnd()}\n[...truncated]`;
}

const SYSTEM_PROMPT = `You are a senior BI dashboard architect and data engineer. Finalize the dashboard plan with production-quality SQL hints and analytically rigorous widget definitions.
Return JSON only. Do not use markdown, code fences, comments, or extra keys.

Respond with exactly one JSON object matching this schema:
{
  "draft": string,
  "plan": {
    "title": string,
    "widgets": [
      {
        "id": string,
        "type": string,
        "title": string,
        "goal": string,
        "requiredTables": string[],
        "primaryTable": string,
        "uses": string,
        "notes": string
      }
    ]
  }
}

Field rules:
- draft: Write a polished business brief.
  Format:
    1) one short title line,
    2) 2-3 sentences describing the decisions this dashboard enables and key business risks monitored,
    3) bullet list of widgets where each bullet states signal + business action.
  Keep it executive-friendly. No SQL syntax in draft text.
- plan.title: short, descriptive dashboard name (e.g. "SaaS Revenue Dashboard", "Support Operations Overview").
- plan.widgets: finalize the widget list (3-6 widgets). Order: KPIs first → trend charts → bar/category charts → specialty (scatter/funnel/cohort/map) → table last.
- id: "w_[type]_[short_snake_case_name]" (e.g. "w_kpi_total_revenue", "w_line_mrr_trend").
- type: MUST be from the allowed types list.
- goal: plain-English business question (same or refined from widget plans).
- requiredTables and primaryTable: MUST be candidate tables only.
- uses: comma-separated table.column references. Use columns from "Metric columns (safe to SUM/AVG)" for measure fields; use categorical/temporal columns for dimensions.
  Include only schema-valid references provided in prompt context.
- notes: one precise, connector-correct SQL data hint. The hint MUST follow these standards:
    • Specify the aggregation function: SUM(col), COUNT(DISTINCT col), AVG(col), not just the column name.
    • For temporal grouping: specify the truncation pattern e.g. "DATE_TRUNC('month', created_at)" or "DATEADD(month, DATEDIFF(month, 0, created_at), 0)" for MSSQL.
    • For rate/ratio metrics: write the formula explicitly e.g. "100.0 * SUM(CASE WHEN status='churned' THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0)".
    • For multi-table widgets: note the join key e.g. "JOIN order_items ON orders.id = order_items.order_id — aggregate order_items before joining to avoid fan-out".
    • For top-N: "ORDER BY metric DESC LIMIT 10" or "TOP 10 ORDER BY metric DESC" for MSSQL.
    • For table widgets: list the 4-6 recommended columns and default sort order.
    • Do not include full SQL queries; provide compact implementation hints only.

Quality policy:
- Each widget must answer a DISTINCT business question — no two widgets should yield the same analytical insight.
- Do not finalize a widget if required columns are not in the schema capability lists.
- Rate/ratio columns (from "Rate/ratio columns" list) must NEVER be SUMmed — the notes field must show the correct formula.
- If a widget uses more than one table, the notes field must specify how to join them safely.
- If a widget cannot be justified as decision-useful, remove it even if technically feasible.
- If evidence is weak, prefer fewer widgets with high confidence over broad but speculative coverage.
- KPI coverage must follow schema support:
    • If "Metric columns (safe to SUM/AVG)" has 0 items: include 0 KPI widgets.
    • If it has 1 item: include exactly 1 KPI widget.
    • If it has 2+ items: include 2-4 KPI widgets.
- Keep the plan lean: 3 high-signal widgets beat 6 mediocre ones.
- Never invent tables, columns, joins, time grains, or KPI formulas that cannot be grounded in prompt evidence.
- Columns marked [no-filter] in the schema summary are disabled for filtering by the user. Never reference them in WHERE, HAVING, or JOIN ON conditions in the notes field. They may only appear in SELECT.
- When "ALLOWED FILTER COLUMNS" are listed in the human prompt, ONLY those columns may appear in WHERE, HAVING, or JOIN ON in the notes field. Any column not in that list is SELECT-only — even if it looks like a useful filter. This is a hard constraint enforced by the user's schema configuration.`;

export const finalPlanSubagent: PlannerSubagent<FinalPlanInput, FinalPlanOutput> = {
  id: "final-plan",

  async run(input: FinalPlanInput, context?: PlannerSubagentContext): Promise<FinalPlanOutput> {
    const {
      query, schema, grounded, meta, widgetPlanner, widgetAgentOutputs, capabilities, validationFeedback, objective,
    } = input;
    const connectorType = getConnectorType(schema);
    const allowedTypes = getAllowedWidgetTypes(schema);
    const now = getCurrentDateTimeContext();
    const schemaRecord = (schema && typeof schema === "object") ? (schema as Record<string, unknown>) : {};
    const mcpEvidence = String(schemaRecord?.mcpEvidenceBlock || "").trim();

    const isRetry = Boolean(validationFeedback);
    log.debug("run_start", { isRetry, widgetCount: widgetPlanner.widgetPlans.length });
    const metricCount = capabilities.metricColumns.length;
    const requiredKpiRule =
      metricCount <= 0
        ? "KPI target: 0 (no safe metric columns available)."
        : metricCount === 1
          ? "KPI target: exactly 1 KPI widget."
          : "KPI target: 2-4 KPI widgets (use distinct safe metric columns).";

    const widgetSummary = widgetPlanner.widgetPlans
      .slice(0, 8)
      .map((w, i) => `${i + 1}. [${w.type}] "${w.title}" — ${w.goal} | uses: ${w.uses || w.primaryTable} | ${w.rationale}`)
      .join("\n");
    const widgetAgentSummary = widgetAgentOutputs
      .slice(0, 12)
      .map((w, i) =>
        `${i + 1}. [${w.widgetType}] applicable=${w.applicable} conf=${w.confidence} table=${w.primaryTable || "none"} uses=${w.uses || "none"}`
      )
      .join("\n");

    const retrySection = validationFeedback
      ? `\n⚠ Quality feedback from previous attempt — fix all issues listed:\n${clipText(validationFeedback, 900)}\n`
      : "";

    const schemaSummaryForPrompt = clipText(
      grounded.schemaSummary.length > 3000
        ? `${grounded.schemaSummary.slice(0, 3000)}\n[...truncated — use capability lists above for column references]`
        : grounded.schemaSummary,
      1400
    );
    const mcpEvidenceForPrompt = clipText(mcpEvidence, 900);
    const relationshipsForPrompt = clipText(getRelationshipSummary(schema) || "none", 650);
    const capabilitiesForPrompt = clipText(formatCapabilitiesForPrompt(capabilities), 1200);
    const widgetSummaryForPrompt = clipText(widgetSummary, 1400);
    const widgetAgentSummaryForPrompt = clipText(widgetAgentSummary || "none", 1000);
    const guidanceForPrompt = clipText(buildDataScientistGuidance(query, capabilities), 650);
    const dbGuidanceForPrompt = clipText(buildDatabaseExpertGuidance(connectorType), 450);
    const enabledFilterBlock = clipText(buildEnabledFilterBlock(schema), 600);

    let human = `Query: ${clipText(query, 500)}
${retrySection}
Domain: ${clipText(meta.domain, 200)}
Domain guidance: ${clipText(meta.domainGuidance || "none", 380)}
Intent: ${clipText(meta.intentLabels.join(", "), 180)}
Primary table: ${clipText(meta.primaryTable, 120)}
Final goal contract: ${clipText(meta.finalGoal || "none", 280)}
Plan goals: ${clipText((meta.planGoals || []).join(" | ") || "none", 520)}
KPI goals: ${clipText((meta.kpiGoals || []).join(" | ") || "none", 520)}
Available KPI columns: ${clipText((meta.availableKpis || []).join(", ") || "none", 350)}
Filter candidates: ${clipText(meta.filterCandidates.join(", ") || "none", 350)}
${enabledFilterBlock ? `\n${enabledFilterBlock}\n` : ""}${buildCurrentDateContextBlock(now)}
Query planning hints:
${clipText(buildQueryIntentHints(query), 450)}
${formatObjectiveBlock(objective)}
${buildCapabilityChecklist({
  hasTemporal: capabilities.temporalColumns.length > 0,
  hasNumeric: capabilities.numericColumns.length > 0,
  hasCategorical: capabilities.categoricalColumns.length > 0,
  hasGeographic: capabilities.geographicColumns.length > 0,
  hasFunnel: capabilities.funnelColumns.length > 0,
})}
Connector: ${getConnectorType(schema)}
${guidanceForPrompt}
${dbGuidanceForPrompt}

Widget plans from Widget Planner:
${widgetSummaryForPrompt}

Widget agent outputs (key signals):
${widgetAgentSummaryForPrompt}

${requiredKpiRule}

Allowed widget types: ${clipText(allowedTypes.join(", "), 220)}
Candidate tables: ${clipText(grounded.candidateTables.join(", "), 400)}

Detected schema capabilities:
${capabilitiesForPrompt}

Relationships:
${relationshipsForPrompt}

Schema (visible columns):
${schemaSummaryForPrompt}
${mcpEvidenceForPrompt ? `\nMCP LIVE TABLE EVIDENCE:\n${mcpEvidenceForPrompt}` : ""}`;

    if (human.length > HUMAN_PROMPT_BUDGET) {
      const reducedSchema = clipText(schemaSummaryForPrompt, 750);
      const reducedMcp = clipText(mcpEvidenceForPrompt, 420);
      // Use index-based replacement to avoid '$' metachar issues in replacement strings
      if (schemaSummaryForPrompt) {
        const idx = human.indexOf(schemaSummaryForPrompt);
        if (idx !== -1) human = human.slice(0, idx) + reducedSchema + human.slice(idx + schemaSummaryForPrompt.length);
      }
      if (mcpEvidenceForPrompt) {
        const idx = human.indexOf(mcpEvidenceForPrompt);
        if (idx !== -1) human = human.slice(0, idx) + reducedMcp + human.slice(idx + mcpEvidenceForPrompt.length);
      }
    }
    if (human.length > HUMAN_PROMPT_BUDGET) {
      human = clipText(human, HUMAN_PROMPT_BUDGET);
    }

    const out = await runJsonAgent<FinalPlanOutput>({
      logPrefix: isRetry ? "[LLM][PLAN_FINAL_RETRY]" : "[LLM][PLAN_FINAL]",
      system: SYSTEM_PROMPT,
      human,
      onToken: context?.onToken,
    });

    const draft = String(out?.draft || "").trim();
    if (!draft) throw new Error("Final Plan subagent returned empty draft.");
    if (!out?.plan || !Array.isArray(out.plan?.widgets))
      throw new Error("Final Plan subagent returned invalid plan structure.");
    if (out.plan.widgets.length === 0)
      throw new Error("Final Plan subagent returned no widgets.");

    log.debug("run_done", { isRetry, widgetCount: out.plan.widgets.length });
    return { draft, plan: out.plan };
  },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLogger } from "@/lib/observability";
import { runJsonAgent } from "../../agents/planner/llm-runner";
import { formatObjectiveBlock } from "../../agents/planner/objective";
import { getCurrentDateTimeContext } from "../../agents/planner/current-datetime-tool";
import { getConnectorType } from "../../agents/planner/schema-utils";
import { formatCapabilitiesForPrompt } from "../../agents/planner/schema-capabilities";
import { ensureNonEmptyStringArray } from "../../agents/planner/plan-utils";
import { buildCurrentDateContextBlock, buildQueryIntentHints, buildEnabledFilterBlock } from "./prompting";
import type {
  PlannerSubagent,
  PlannerSubagentContext,
  InitPlanGoalsInput,
  InitPlanGoalsOutput,
} from "./types";

const log = createLogger("subagents.planner.init-plan-goals");

const SYSTEM_PROMPT = `You are the Init Plan Goals agent for dashboard planning.
Define a strict goal contract for downstream planner agents using only schema evidence and user intent.
Return JSON only. Do not use markdown, code fences, or text outside the JSON object.

Respond with exactly one JSON object matching this schema:
{
  "draft": string,
  "finalGoal": string,
  "planGoals": string[],
  "kpiGoals": string[]
}

Field rules:
- draft: 2-3 concise sentences summarizing what this planning run must achieve.
- finalGoal: one sentence describing the single primary decision outcome this dashboard must enable.
- planGoals: 4-8 concrete goals, prioritized highest to lowest.
  Each goal must be specific and testable (for example: "Show monthly revenue trend by plan tier with safe aggregation.").
  Each goal that involves date/time filtering MUST reference an ALLOWED FILTER COLUMN — never invent a date filter column.
- kpiGoals: 1-6 KPI goals aligned with available schema metrics.
  If no reliable schema KPI exists, return an empty array.

Goal policy:
- Ground every goal in visible schema columns, candidate tables, available KPI columns, and query intent.
- Never invent tables, columns, entities, or KPI formulas not supported by prompt evidence.
- Include metric safety constraints when relevant (do not sum ratios; avoid ID/FK aggregation; enforce join safety on multi-table metrics).
- When ALLOWED FILTER COLUMNS are provided, plan goals must respect those boundaries — only reference filter-enabled columns for time/dimension slicing.
- If a goal requires filtering by a column that is NOT in ALLOWED FILTER COLUMNS, either drop that goal or reframe it using an available allowed column.`;

export const initPlanGoalsSubagent: PlannerSubagent<InitPlanGoalsInput, InitPlanGoalsOutput> = {
  id: "init-plan-goals",

  async run(input: InitPlanGoalsInput, context?: PlannerSubagentContext): Promise<InitPlanGoalsOutput> {
    const { query, schema, grounded, capabilities, objective } = input;
    const now = getCurrentDateTimeContext();
    const schemaRecord = (schema && typeof schema === "object") ? (schema as Record<string, unknown>) : {};
    const mcpEvidence = String(schemaRecord?.mcpEvidenceBlock || "").trim();

    log.debug("run_start", {
      candidateTables: grounded.candidateTables.length,
      metricColumns: capabilities.metricColumns.length,
    });

    const availableKpis = Array.from(
      new Set((capabilities.metricColumns || []).map((x) => String(x).trim()).filter((x) => x.includes(".")))
    ).slice(0, 12);

    const schemaSummaryClipped = grounded.schemaSummary.length > 2400
      ? `${grounded.schemaSummary.slice(0, 2400).trimEnd()}\n[...truncated]`
      : grounded.schemaSummary;
    const mcpEvidenceClipped = mcpEvidence.length > 800
      ? `${mcpEvidence.slice(0, 800).trimEnd()}\n[...truncated]`
      : mcpEvidence;
    const filterBlock = buildEnabledFilterBlock(schema);

    const human = `Query: ${query}

${buildCurrentDateContextBlock(now)}

Connector: ${getConnectorType(schema)}
Query intent hints:
${buildQueryIntentHints(query)}
${formatObjectiveBlock(objective)}

Candidate tables:
${grounded.candidateTables.join(", ") || "none"}

Available KPI columns from schema (safe to aggregate):
${availableKpis.join(", ") || "none"}

Detected schema capabilities:
${formatCapabilitiesForPrompt(capabilities)}

Schema (visible columns per table):
${schemaSummaryClipped}

${filterBlock}
${mcpEvidenceClipped ? `\nMCP LIVE TABLE EVIDENCE:\n${mcpEvidenceClipped}` : ""}`;

    const out = await runJsonAgent<InitPlanGoalsOutput>({
      logPrefix: "[LLM][PLAN_INIT_GOALS]",
      system: SYSTEM_PROMPT,
      human,
      onToken: context?.onToken,
    });

    const draft = String(out?.draft || "").trim();
    const finalGoal = String(out?.finalGoal || "").trim();
    const planGoals = ensureNonEmptyStringArray((out as any)?.planGoals).slice(0, 8);
    const kpiGoals = ensureNonEmptyStringArray((out as any)?.kpiGoals).slice(0, 6);

    if (!draft) throw new Error("InitPlanGoals subagent returned empty draft.");
    if (!finalGoal) throw new Error("InitPlanGoals subagent returned empty finalGoal.");
    if (planGoals.length === 0) throw new Error("InitPlanGoals subagent returned no planGoals.");

    const result: InitPlanGoalsOutput = {
      draft,
      finalGoal,
      planGoals,
      kpiGoals,
      availableKpis,
    };
    log.debug("run_done", {
      planGoals: result.planGoals.length,
      kpiGoals: result.kpiGoals.length,
      availableKpis: result.availableKpis.length,
    });
    return result;
  },
};

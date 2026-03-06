/* eslint-disable @typescript-eslint/no-explicit-any */
import { runSkill } from "@/lib/skills/registry";
import { runJsonAgent } from "../../../agents/planner/llm-runner";
import { formatObjectiveBlock, isAccuracyFirst } from "../../../agents/planner/objective";
import { getCurrentDateTimeContext } from "../../../agents/planner/current-datetime-tool";
import { getConnectorType, getRelationshipSummary } from "../../../agents/planner/schema-utils";
import { formatCapabilitiesForPrompt, type SchemaCapabilities } from "../../../agents/planner/schema-capabilities";
import {
  buildCapabilityChecklist,
  buildCurrentDateContextBlock,
  buildQueryIntentHints,
} from "../prompting";
import {
  buildDataEngineeringGuidance,
  buildDataScientistGuidance,
  buildDatabaseExpertGuidance,
} from "../expert-guidance";
import type { PlannerSubagent, PlannerSubagentContext } from "../types";
import type { WidgetAgentInput, WidgetAgentOutput } from "./types";
import type { WidgetSkillInput, WidgetSkillHint } from "@/lib/skills/planner/widgets";

// ── Shared base system prompt ─────────────────────────────────────────────────

const BASE_SYSTEM = `You are a senior BI dashboard widget designer. Design exactly ONE decision-useful widget of the specified type.
Return JSON only. Do not use markdown, code fences, comments, or any text outside the JSON object.

Respond with exactly one JSON object matching this schema:
{
  "applicable": boolean,
  "widgetType": string,
  "title": string,
  "goal": string,
  "primaryTable": string,
  "requiredTables": string[],
  "uses": string,
  "rationale": string,
  "notes": string,
  "confidence": number
}

Field rules:
- applicable: true if this widget type genuinely answers the query, false if it is a poor fit.
- widgetType: must be the exact widget type specified in the human message.
- title: short, business-friendly label (e.g. "Total Revenue", "Monthly Trend", "Top Products").
- goal: one plain-English sentence — what business question does this widget answer?
- primaryTable: MUST be one of the candidate tables listed below.
- requiredTables: MUST only contain candidate tables.
- uses: comma-separated "table.column" references this widget reads.
  Include only references that exist in the provided schema context.
- rationale: one sentence explaining the decision signal this widget provides and why that signal matters.
- notes: one concise, connector-correct SQL hint with explicit aggregation/join pattern (not generic prose).
  Keep notes implementation-ready but brief; do not output full SQL queries unless explicitly required.
- confidence: integer 0–100. How well does this widget answer the query? If < 50, set applicable: false.

Confidence rubric:
- 90-100: direct schema support + unambiguous metric logic.
- 70-89: schema support with minor assumptions.
- 50-69: weak mapping; use only if no stronger option.
- <50: must set applicable=false.

Decision policy:
- Favor user-intent alignment over stylistic variety.
- Avoid weak/forced mappings when required columns are missing.
- Prefer explicitly recommended columns when they are schema-valid.
- Never invent tables, columns, joins, or business definitions not present in prompt evidence.`;

// ── Factory config ────────────────────────────────────────────────────────────

export interface WidgetSubagentConfig {
  widgetType: string;
  skillId: string;
  /** Return false to skip the LLM call entirely (fast path) */
  feasibilityCheck: (cap: SchemaCapabilities) => boolean;
  /** Type-specific instructions appended to the base system prompt */
  systemPromptCore: string;
}

// ── Not-applicable sentinel ───────────────────────────────────────────────────

function notApplicable(widgetType: string, reason: string): WidgetAgentOutput {
  return {
    applicable: false,
    widgetType,
    title: "",
    goal: "",
    primaryTable: "",
    requiredTables: [],
    uses: "",
    rationale: reason,
    notes: "",
    confidence: 0,
  };
}

function normalizeWidgetRefs(
  uses: string,
  projectedColumnsByTable: Record<string, string[]>
): string[] {
  const allowed = new Set<string>();
  for (const [table, cols] of Object.entries(projectedColumnsByTable || {})) {
    for (const col of cols || []) allowed.add(`${table}.${col}`.toLowerCase());
  }
  return String(uses || "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.includes("."))
    .filter((x) => allowed.has(x.toLowerCase()))
    .slice(0, 12);
}

function isIdLikeRef(ref: string): boolean {
  const col = String(ref || "").split(".").pop() || "";
  return /^id$|_id$|^fk_|^pk_|user_id|order_id|customer_id|product_id|account_id|session_id|transaction_id/i.test(col);
}

function hasRateFormula(notes: string): boolean {
  const n = String(notes || "").toLowerCase();
  return n.includes("/") || n.includes("nullif") || n.includes("case when");
}

function clipPromptBlock(value: string, max = 1200): string {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 15)).trimEnd()}\n[...truncated]`;
}

function takeFirstLines(value: string, maxLines: number): string {
  return String(value || "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, maxLines)
    .join("\n");
}

function buildCompactWidgetSchemaBlock(grounded: WidgetAgentInput["grounded"], primaryTable: string): string {
  const preferred = [primaryTable, ...grounded.candidateTables.filter((t) => t !== primaryTable)]
    .filter(Boolean)
    .slice(0, 4);
  const lines = preferred.map((table) => {
    const cols = Array.isArray(grounded.projectedColumnsByTable?.[table])
      ? grounded.projectedColumnsByTable[table].slice(0, 8)
      : [];
    return `${table}: ${cols.join(", ")}`;
  });
  return lines.filter(Boolean).join("\n");
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createWidgetSubagent(
  config: WidgetSubagentConfig
): PlannerSubagent<WidgetAgentInput, WidgetAgentOutput> {
  return {
    id: `widget-${config.widgetType}`,

    async run(input: WidgetAgentInput, context?: PlannerSubagentContext): Promise<WidgetAgentOutput> {
      const { query, schema, grounded, meta, capabilities, objective } = input;
      const now = getCurrentDateTimeContext();
      const connectorType = getConnectorType(schema);
      const mcpEvidence = String((schema as any)?.mcpEvidenceBlock || "").trim();
      const relationshipSummary = clipPromptBlock(getRelationshipSummary(schema) || "none", 600);
      const compactSchema = buildCompactWidgetSchemaBlock(grounded, meta.primaryTable);
      const compactEvidence = mcpEvidence ? clipPromptBlock(mcpEvidence, 700) : "";
      const compactScientistGuidance = takeFirstLines(buildDataScientistGuidance(query, capabilities), 8);
      const compactEngineeringGuidance = takeFirstLines(buildDataEngineeringGuidance(), 5);
      const compactDatabaseGuidance = takeFirstLines(buildDatabaseExpertGuidance(connectorType), 6);

      // Fast path — schema doesn't support this widget type at all
      if (!config.feasibilityCheck(capabilities)) {
        return notApplicable(config.widgetType, "Schema lacks required column types for this widget.");
      }

      // Rule-based skill hint (no LLM)
      const hint = await runSkill<WidgetSkillInput, WidgetSkillHint>(config.skillId, {
        meta: { domain: meta.domain, intentLabels: meta.intentLabels, domainGuidance: meta.domainGuidance },
        capabilities,
        connectorType,
        query,
      });

      if (!hint.applicable) {
        return notApplicable(config.widgetType, "Skill layer determined this widget type is not applicable.");
      }

      const system = `${BASE_SYSTEM}\n\n${config.systemPromptCore}`;

      const human = `Widget type to design: ${config.widgetType}

Query: ${query}

${buildCurrentDateContextBlock(now)}

Domain: ${meta.domain}
Domain guidance: ${meta.domainGuidance || "none"}
Intent: ${meta.intentLabels.join(", ")}
Final goal: ${meta.finalGoal || "none"}
Plan goals: ${(meta.planGoals || []).join(" | ") || "none"}
KPI goals: ${(meta.kpiGoals || []).join(" | ") || "none"}
Available KPI columns: ${(meta.availableKpis || []).join(", ") || "none"}
Query planning hints:
${buildQueryIntentHints(query)}
${formatObjectiveBlock(objective)}
Primary table: ${meta.primaryTable}
Filter candidates: ${meta.filterCandidates.join(", ") || "none"}
Connector: ${connectorType}

Domain hint: ${hint.domainNote}
Recommended columns: ${hint.recommendedColumns.join(", ") || "none"}
SQL pattern hint: ${hint.sqlPattern}

Detected schema capabilities:
${formatCapabilitiesForPrompt(capabilities)}
${buildCapabilityChecklist({
  hasTemporal: capabilities.temporalColumns.length > 0,
  hasNumeric: capabilities.numericColumns.length > 0,
  hasCategorical: capabilities.categoricalColumns.length > 0,
  hasGeographic: capabilities.geographicColumns.length > 0,
  hasFunnel: capabilities.funnelColumns.length > 0,
})}
${compactScientistGuidance}
${compactEngineeringGuidance}
${compactDatabaseGuidance}

Candidate tables (only use these exact names):
${grounded.candidateTables.slice(0, 8).join(", ")}

Relationships:
${relationshipSummary}

Schema (visible columns per table):
${compactSchema}
${compactEvidence ? `\nMCP LIVE TABLE EVIDENCE (truncated):\n${compactEvidence}` : ""}`;

      const out = await runJsonAgent<any>({
        logPrefix: `[LLM][WIDGET_${config.widgetType.toUpperCase()}]`,
        system,
        human,
        onToken: context?.onToken,
      });

      // If LLM itself flagged it as not applicable, honour that
      if (out?.applicable === false) {
        return notApplicable(config.widgetType, String(out?.rationale || "LLM determined widget is not applicable."));
      }

      const primaryTable = String(out?.primaryTable || "").trim();
      const tablesSet = new Set(grounded.candidateTables.map((t: string) => t.toLowerCase()));

      if (!primaryTable || !tablesSet.has(primaryTable.toLowerCase())) {
        return notApplicable(
          config.widgetType,
          `Returned invalid primaryTable "${primaryTable}" — not in candidate tables.`
        );
      }

      const requiredTablesRaw: string[] = Array.isArray(out?.requiredTables)
        ? out.requiredTables.map((t: unknown) => String(t))
        : [primaryTable];
      const requiredTables = requiredTablesRaw.filter((t) => tablesSet.has(t.toLowerCase()));
      const refs = normalizeWidgetRefs(String(out?.uses || ""), grounded.projectedColumnsByTable);
      if (refs.length === 0) {
        return notApplicable(config.widgetType, "Widget references no schema-valid table.column fields.");
      }

      const confidence = typeof out?.confidence === "number" ? Math.min(100, Math.max(0, out.confidence)) : 50;
      if (confidence < 50) {
        return notApplicable(config.widgetType, "Confidence below 50 per rubric.");
      }
      if (isAccuracyFirst(objective) && confidence < objective.constraints.minConfidence) {
        return notApplicable(
          config.widgetType,
          `Rejected in accuracy_first mode: confidence ${confidence} < ${objective.constraints.minConfidence}.`
        );
      }

      if (config.widgetType === "kpi") {
        if (refs.some((ref) => isIdLikeRef(ref))) {
          return notApplicable(config.widgetType, "KPI uses ID/FK-like columns, which are invalid metrics.");
        }
        const rateSet = new Set((capabilities.rateColumns || []).map((x) => String(x).toLowerCase()));
        const metricSet = new Set((capabilities.metricColumns || []).map((x) => String(x).toLowerCase()));
        const refsLower = refs.map((x) => x.toLowerCase());
        const rateOnly = refsLower.some((ref) => rateSet.has(ref)) && !refsLower.some((ref) => metricSet.has(ref));
        if (rateOnly && !hasRateFormula(String(out?.notes || ""))) {
          return notApplicable(config.widgetType, "Rate/ratio KPI missing explicit numerator/denominator formula.");
        }
      }

      if (isAccuracyFirst(objective) && requiredTables.length > 1) {
        const notes = String(out?.notes || "").toLowerCase();
        if (!notes.includes("join")) {
          return notApplicable(config.widgetType, "Multi-table widget missing join-safety notes in accuracy_first mode.");
        }
      }

      return {
        applicable: true,
        widgetType: config.widgetType,
        title: String(out?.title || `${config.widgetType} Widget`),
        goal: String(out?.goal || ""),
        primaryTable,
        requiredTables: requiredTables.length > 0 ? requiredTables : [primaryTable],
        uses: refs.join(", "),
        rationale: String(out?.rationale || ""),
        notes: String(out?.notes || ""),
        confidence,
      };
    },
  };
}

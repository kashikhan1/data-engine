import { createLogger } from "@/lib/observability";
import { runJsonAgent } from "../../agents/planner/llm-runner";
import { formatObjectiveBlock } from "../../agents/planner/objective";
import { getCurrentDateTimeContext } from "../../agents/planner/current-datetime-tool";
import { getConnectorType } from "../../agents/planner/schema-utils";
import { ensureNonEmptyStringArray, normalizeFilterCandidates } from "../../agents/planner/plan-utils";
import { buildCurrentDateContextBlock, buildQueryIntentHints } from "./prompting";
import type {
  PlannerSubagent,
  PlannerSubagentContext,
  FilterCandidatesInput,
  FilterCandidatesOutput,
} from "./types";

const log = createLogger("subagents.planner.filter-candidates");

const SYSTEM_PROMPT = `You are the Filter Candidate agent for dashboard planning.
Return JSON only. Do not use markdown, code fences, or text outside the JSON object.

Respond with exactly one JSON object matching this schema:
{
  "draft": string,
  "filterCandidates": string[]
}

Field rules:
- draft: 2-3 professional sentences, plain natural language.
  Explain which filters are prioritized, why they improve decision quality, and which weak filters were intentionally excluded.
- filterCandidates: 3-8 items in "table.column" format using only candidate tables and visible columns.
  Output unique values only (no duplicates), ordered by business usefulness.

Filter policy:
- If "Enabled filter columns from schema UI" is non-empty, treat that list as the authoritative allowlist and choose from it.
- Prioritize date/period columns first.
- Include low-cardinality status/type/category fields.
- Add geography or ownership filters when relevant.
- Avoid high-cardinality free-text fields (email, name, description, notes).
- Keep filter selection aligned with the provided finalGoal and planGoals.
- Never include synthetic or inferred columns not explicitly listed in schema context.
- Columns marked [no-filter] in the schema summary are disabled for filtering. Never include them in filterCandidates.
- When "Enabled filter columns from schema UI" is non-empty, that list is the authoritative allowlist — output ONLY items from it. Do not add any column outside that list under any circumstances, even if it seems analytically useful.`;

function rankFilterRef(ref: string): number {
  const lower = String(ref || "").toLowerCase();
  let score = 0;
  if (/date|time|created|updated|timestamp|month|year|week|period/.test(lower)) score += 30;
  if (/status|type|category|segment|tier|stage|step|phase|state/.test(lower)) score += 22;
  if (/country|region|city|state|province|geo|territory/.test(lower)) score += 16;
  if (/owner|assignee|manager|team|department/.test(lower)) score += 12;
  if (/email|name|description|note|comment|text|url/.test(lower)) score -= 20;
  return score;
}

function deterministicFilterPick(enabledFilterRefs: string[], limit = 8): string[] {
  return Array.from(new Set((enabledFilterRefs || []).map((x) => String(x).trim()).filter(Boolean)))
    .sort((a, b) => rankFilterRef(b) - rankFilterRef(a))
    .slice(0, limit);
}

export const filterCandidatesSubagent: PlannerSubagent<FilterCandidatesInput, FilterCandidatesOutput> = {
  id: "filter-candidates",

  async run(input: FilterCandidatesInput, context?: PlannerSubagentContext): Promise<FilterCandidatesOutput> {
    const {
      query, schema, grounded, intentLabels, domain, primaryTable,
      finalGoal, planGoals, kpiGoals, availableKpis, enabledFilterRefs = [], objective,
    } = input;
    const now = getCurrentDateTimeContext();
    const schemaRecord = (schema && typeof schema === "object") ? (schema as Record<string, unknown>) : {};
    const mcpEvidenceRaw = String(schemaRecord?.mcpEvidenceBlock || "").trim();
    const mcpEvidence = mcpEvidenceRaw.length > 600 ? `${mcpEvidenceRaw.slice(0, 600).trimEnd()}\n[...truncated]` : mcpEvidenceRaw;

    log.debug("run_start", { domain, primaryTable, intentLabels });

    const human = `Query: ${query}

${buildCurrentDateContextBlock(now)}

Connector: ${getConnectorType(schema)}
Domain: ${domain}
Intent labels: ${intentLabels.join(", ")}
Primary table: ${primaryTable}
Query intent hints:
${buildQueryIntentHints(query)}
${formatObjectiveBlock(objective)}
Final goal contract: ${finalGoal}
Plan goals: ${planGoals.join(" | ") || "none"}
KPI goals: ${kpiGoals.join(" | ") || "none"}
Available KPI columns: ${availableKpis.join(", ") || "none"}

Candidate tables:
${grounded.candidateTables.join(", ")}

Schema (visible columns per table):
${grounded.schemaSummary.length > 1800 ? `${grounded.schemaSummary.slice(0, 1800).trimEnd()}\n[...truncated]` : grounded.schemaSummary}

Enabled filter columns from schema UI (highest priority, use these when available):
${enabledFilterRefs.length > 0 ? enabledFilterRefs.join(", ") : "none"}
${mcpEvidence ? `\nMCP LIVE TABLE EVIDENCE:\n${mcpEvidence}` : ""}`;

    const out = await runJsonAgent<FilterCandidatesOutput>({
      logPrefix: "[LLM][PLAN_FILTERS]",
      system: SYSTEM_PROMPT,
      human,
      onToken: context?.onToken,
    });

    const draft = String(out?.draft || "").trim();
    if (!draft) throw new Error("FilterCandidates subagent returned empty draft.");

    const normalized = normalizeFilterCandidates(
      ensureNonEmptyStringArray(out?.filterCandidates),
      grounded.candidateTables,
      grounded.projectedColumnsByTable
    );
    const enabledSet = new Set(enabledFilterRefs.map((x) => String(x).toLowerCase()));

    // When the user has explicitly enabled filters, return ALL of them — not just the LLM's subset.
    // The LLM picks 3-8 items, but the user may have enabled more. All enabled refs must be preserved.
    let finalFilterCandidates: string[];
    if (enabledSet.size > 0) {
      // Start with all enabled refs (sorted by business usefulness), then append any LLM picks
      // that happen to be valid enabled refs (preserves LLM ordering signal but keeps all enabled).
      const allEnabled = deterministicFilterPick(enabledFilterRefs, enabledFilterRefs.length);
      finalFilterCandidates = allEnabled;
    } else {
      finalFilterCandidates = normalized.length > 0 ? normalized : deterministicFilterPick(enabledFilterRefs, 8);
    }

    const result: FilterCandidatesOutput = {
      draft,
      filterCandidates: finalFilterCandidates,
    };
    log.debug("run_done", { filters: result.filterCandidates.length });
    return result;
  },
};

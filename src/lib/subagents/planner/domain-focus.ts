/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLogger } from "@/lib/observability";
import { runJsonAgent } from "../../agents/planner/llm-runner";
import { formatObjectiveBlock } from "../../agents/planner/objective";
import { getCurrentDateTimeContext } from "../../agents/planner/current-datetime-tool";
import { getConnectorType, getRelationshipSummary } from "../../agents/planner/schema-utils";
import { buildCurrentDateContextBlock, buildQueryIntentHints, buildEnabledFilterBlock } from "./prompting";
import type {
  PlannerSubagent,
  PlannerSubagentContext,
  DomainFocusInput,
  DomainFocusOutput,
} from "./types";

const log = createLogger("subagents.planner.domain-focus");

const SYSTEM_PROMPT = `You are the Domain Focus agent for dashboard planning.
Your job is to pick the table that best represents the core business process and explain the tradeoff.
Return JSON only. Do not use markdown, code fences, or extra commentary.

Respond with exactly one JSON object matching this schema:
{
  "draft": string,
  "domain": string,
  "primaryTable": string,
  "domainGuidance": string
}

Field rules:
- draft: 2-3 professional sentences, plain natural language.
  Include: selected domain + core table, why this table is the factual source versus alternatives, and the business mistake avoided by this focus choice.
  Ground claims in schema evidence (table roles, relationships, metric ownership).
- domain: one concise domain name (e.g. "SaaS Revenue", "Support Operations", "E-commerce Sales").
- primaryTable: MUST be one of the provided candidate tables.
- domainGuidance: 1-2 sentences with KPI design guidance, metric correctness constraints, and join-safety notes for downstream agents.
  Include one explicit constraint when relevant (for example: "recompute ratios from counts" or "pre-aggregate child rows before joining").

Decision policy:
- Pick the core event/fact table over lookup tables.
- Mention ratio math safety when relevant (recompute rates from counts, do not sum ratios).
- If multi-table analysis is likely, domainGuidance must include explicit join safety direction.
- Keep guidance aligned with the provided finalGoal and planGoals contract.
- Never invent tables/columns or claim relationships that are not provided.
- When ALLOWED FILTER COLUMNS are provided, domainGuidance must specify which of those columns to use for time-based and dimensional filtering — never suggest using a column that is not in the allowed list for WHERE/HAVING.`;

export const domainFocusSubagent: PlannerSubagent<DomainFocusInput, DomainFocusOutput> = {
  id: "domain-focus",

  async run(input: DomainFocusInput, context?: PlannerSubagentContext): Promise<DomainFocusOutput> {
    const { query, schema, grounded, intentLabels, finalGoal, planGoals, kpiGoals, availableKpis, objective } = input;
    const now = getCurrentDateTimeContext();
    const mcpEvidenceRaw = String((schema as any)?.mcpEvidenceBlock || "").trim();
    const mcpEvidence = mcpEvidenceRaw.length > 800 ? `${mcpEvidenceRaw.slice(0, 800).trimEnd()}\n[...truncated]` : mcpEvidenceRaw;

    log.debug("run_start", { tables: grounded.candidateTables.length, intentLabels });

    const human = `Query: ${query}

${buildCurrentDateContextBlock(now)}

Connector: ${getConnectorType(schema)}
Intent labels: ${intentLabels.join(", ")}
Query intent hints:
${buildQueryIntentHints(query)}
${formatObjectiveBlock(objective)}
Final goal contract: ${finalGoal}
Plan goals: ${planGoals.join(" | ") || "none"}
KPI goals: ${kpiGoals.join(" | ") || "none"}
Available KPI columns: ${availableKpis.join(", ") || "none"}
Focus table hint: ${String((schema as any)?.focusTable || "none")}

Candidate tables (MUST use one as primaryTable):
${grounded.candidateTables.join(", ")}

Relationships:
${getRelationshipSummary(schema) || "none"}

Schema (visible columns per table):
${grounded.schemaSummary.length > 2400 ? `${grounded.schemaSummary.slice(0, 2400).trimEnd()}\n[...truncated]` : grounded.schemaSummary}

${buildEnabledFilterBlock(schema)}
${mcpEvidence ? `\nMCP LIVE TABLE EVIDENCE:\n${mcpEvidence}` : ""}`;

    const out = await runJsonAgent<DomainFocusOutput>({
      logPrefix: "[LLM][PLAN_DOMAIN]",
      system: SYSTEM_PROMPT,
      human,
      onToken: context?.onToken,
    });

    const draft = String(out?.draft || "").trim();
    if (!draft) throw new Error("DomainFocus subagent returned empty draft.");

    const primaryTable = String(out?.primaryTable || "").trim();
    if (!grounded.candidateTables.includes(primaryTable))
      throw new Error(`DomainFocus subagent returned invalid primaryTable "${primaryTable}".`);

    const result: DomainFocusOutput = {
      draft,
      domain: String(out?.domain || intentLabels[0] || "General").trim(),
      primaryTable,
      domainGuidance: String(out?.domainGuidance || "").trim(),
    };

    log.debug("run_done", { domain: result.domain, primaryTable: result.primaryTable });
    return result;
  },
};

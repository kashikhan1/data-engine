/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLogger } from "@/lib/observability";
import { runJsonAgent } from "../../agents/planner/llm-runner";
import { formatObjectiveBlock } from "../../agents/planner/objective";
import { getCurrentDateTimeContext } from "../../agents/planner/current-datetime-tool";
import { getConnectorType, inferIntentLabels } from "../../agents/planner/schema-utils";
import { ensureNonEmptyStringArray } from "../../agents/planner/plan-utils";
import { buildCurrentDateContextBlock, buildQueryIntentHints, buildEnabledFilterBlock } from "./prompting";
import type {
  PlannerSubagent,
  PlannerSubagentContext,
  MetaIntentInput,
  MetaIntentOutput,
} from "./types";

const log = createLogger("subagents.planner.meta-intent");

const SYSTEM_PROMPT = `You are the Meta Intent agent for dashboard planning.
Your job is to identify the decision the business must make from this dashboard, not to restate the query.
Return JSON only. Do not use markdown, code fences, or any text outside the JSON object.

Respond with exactly one JSON object matching this schema:
{
  "draft": string,
  "intentLabels": string[]
}

Field rules:
- draft: 2-3 professional sentences, plain natural language.
  Sentence 1: the decision question to answer.
  Sentence 2: why this decision matters now (business risk/opportunity).
  Sentence 3: what action improves if this decision is answered correctly.
  Keep it concrete, domain-specific, and non-generic. No filler or motivational language.
  Do not mention unavailable data or speculative metrics.
- intentLabels: 1-3 labels from ["SaaS", "E-commerce", "Support", "Marketing", "Finance", "HR", "Ops", "General"].
  Prefer the narrowest labels supported by schema evidence.

Accuracy policy:
- Base the intent on schema evidence (candidate tables and available metric/temporal/category fields), not generic assumptions.
- If query scope exceeds schema support, anchor the intent to the closest supported decision question.
- Align the intent with the provided finalGoal and planGoals contract.
- Never invent tables, columns, or business entities not present in the prompt.
- When ALLOWED FILTER COLUMNS are provided, intent labels and the draft must only reference filter-enabled columns for dimension/time context.`;

export const metaIntentSubagent: PlannerSubagent<MetaIntentInput, MetaIntentOutput> = {
  id: "meta-intent",

  async run(input: MetaIntentInput, context?: PlannerSubagentContext): Promise<MetaIntentOutput> {
    const { query, schema, grounded, finalGoal, planGoals, kpiGoals, availableKpis, objective } = input;
    const intentSeed = inferIntentLabels(query);
    const now = getCurrentDateTimeContext();
    const mcpEvidenceRaw = String((schema as any)?.mcpEvidenceBlock || "").trim();
    const mcpEvidence = mcpEvidenceRaw.length > 600 ? `${mcpEvidenceRaw.slice(0, 600).trimEnd()}\n[...truncated]` : mcpEvidenceRaw;

    log.debug("run_start", { tables: grounded.candidateTables.length, intentSeed });

    const human = `Query: ${query}

${buildCurrentDateContextBlock(now)}

Connector: ${getConnectorType(schema)}
Seed intent labels: ${intentSeed.join(", ")}
Query intent hints:
${buildQueryIntentHints(query)}
${formatObjectiveBlock(objective)}
Final goal contract: ${finalGoal}
Plan goals: ${planGoals.join(" | ") || "none"}
KPI goals: ${kpiGoals.join(" | ") || "none"}
Available KPI columns: ${availableKpis.join(", ") || "none"}

Candidate tables:
${grounded.candidateTables.join(", ")}

Project context: ${String((schema as any)?.projectContext || "").slice(0, 400) || "none"}
Domain notes: ${String((schema as any)?.domainSummary || "").slice(0, 400) || "none"}
User notes: ${String((schema as any)?.userSchemaNotes || "").slice(0, 400) || "none"}

${buildEnabledFilterBlock(schema)}
${mcpEvidence ? `\nMCP LIVE TABLE EVIDENCE:\n${mcpEvidence}` : ""}`;

    const out = await runJsonAgent<MetaIntentOutput>({
      logPrefix: "[LLM][PLAN_META_INTENT]",
      system: SYSTEM_PROMPT,
      human,
      onToken: context?.onToken,
    });

    const draft = String(out?.draft || "").trim();
    if (!draft) throw new Error("MetaIntent subagent returned empty draft.");

    const intentLabels = ensureNonEmptyStringArray(out?.intentLabels);
    if (intentLabels.length === 0)
      throw new Error("MetaIntent subagent returned empty intentLabels.");

    const result: MetaIntentOutput = { draft, intentLabels };
    log.debug("run_done", { intents: result.intentLabels });
    return result;
  },
};

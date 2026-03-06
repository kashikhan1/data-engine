import { registerSkill, type SkillDefinition } from "./registry";
import { SystemMessage } from "@langchain/core/messages";
import { invokeModelWithRetry } from "../agents/llm-utils";
import { createDefaultChatModel } from "../llm/model";

type ModelMessage = ConstructorParameters<typeof SystemMessage>[0];

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][SCHEMA_ANALYSIS_SKILL]", timeoutMs: 900000 });
const invokeModel = (messages: ModelMessage[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetry(getModel, messages, maxRetries, delay);

export type SchemaAnalysisSkillInput = {
    simplifiedSchema: string;
    relText: string;
    limitedSampleData: Record<string, unknown>;
    projectContext?: string;
};

export type SchemaAnalysisSkillOutput = {
    analysis: string;
};

export const schemaAnalysisSkill: SkillDefinition<SchemaAnalysisSkillInput, SchemaAnalysisSkillOutput> = {
    id: "schema-analysis",
    description: "Analyzes semantic meaning of a database schema, relationships, and sample data.",
    run: async (input) => {
        const { simplifiedSchema, relText, limitedSampleData, projectContext } = input;

        const projectContextBlock = projectContext ? `PROJECT CONTEXT:\n${projectContext}\n` : "";

        const systemPrompt = `You are a Senior Data Analytics Architect and Profiler.
${projectContextBlock}
SCHEMA:
${simplifiedSchema}

RELATIONSHIPS:
${relText || "None detected"}

SAMPLE DATA:
${JSON.stringify(limitedSampleData)}

TASK: Write a concise 2-3 sentence summary identifying:
1. The main business domain (e.g., e-commerce, SaaS, support)
2. Key fact tables (transactional data with timestamps + numeric measures)
3. Key dimension tables (reference data used for filtering/grouping)
4. Any obvious analytics opportunities (e.g., revenue trends, user funnels)

RULES:
- Only reference tables/columns shown in SCHEMA.
- Do NOT invent topics or domains not evident in the data.
- If schema context is insufficient, say: "Insufficient schema context."
- Be specific: name the tables.`;

        try {
            const response = await invokeModel([new SystemMessage(systemPrompt)]);
            return { analysis: String(response.content || "").trim() };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error("[SCHEMA_LLM_ERROR] Failed to generate semantic analysis:", message);
            // Re-throw to allow caller fallback.
            throw err;
        }
    }
};

let registered = false;
export function registerSchemaAnalysisSkill(): void {
    if (registered) return;
    registerSkill(schemaAnalysisSkill);
    registered = true;
}

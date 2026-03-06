import { registerSkill, type SkillDefinition } from "./registry";
import { SystemMessage } from "@langchain/core/messages";
import { invokeModelWithRetry, extractJSON } from "../agents/llm-utils";
import { createDefaultChatModel } from "../llm/model";

type ModelMessage = ConstructorParameters<typeof SystemMessage>[0];

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][ENHANCER_SKILL]", timeoutMs: 900000 });
const invokeModel = (messages: ModelMessage[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetry(getModel, messages, maxRetries, delay);

export type EnhancerSkillInput = {
    intent: Record<string, unknown>;
    tableInsightsText?: string;
    schemaInfo: Record<string, unknown>;
};

export type EnhancerSkillOutput = {
    enhanced: {
        technical_context?: string;
        suggested_metrics?: string[];
        join_paths?: string[];
    };
};

export const enhancerSkill: SkillDefinition<EnhancerSkillInput, EnhancerSkillOutput> = {
    id: "query-enhancer",
    description: "Deepens intent and contextualizes it with the schema.",
    run: async (input) => {
        const { intent, tableInsightsText, schemaInfo } = input;

        const prompt = `Role: Senior Data Architect. Enhance the raw intent with technical context.
INTENT: ${JSON.stringify(intent)}
${tableInsightsText ? `TABLE_INSIGHTS:\n${tableInsightsText}` : `SCHEMA: ${JSON.stringify(schemaInfo)}`}

Explain the entities involved, suggest metrics to track, and identify potential join paths.
Return JSON: { "technical_context": "...", "suggested_metrics": [], "join_paths": [] }`;

        const response = await invokeModel([new SystemMessage(prompt)]);
        const enhanced = extractJSON(response.content as string) as EnhancerSkillOutput["enhanced"] | null;

        return { enhanced: enhanced || { suggested_metrics: [] } };
    }
};

let registered = false;
export function registerEnhancerSkill(): void {
    if (registered) return;
    registerSkill(enhancerSkill);
    registered = true;
}

import { registerSkill, type SkillDefinition } from "./registry";
import { SystemMessage } from "@langchain/core/messages";
import { invokeModelWithRetry, extractJSON } from "../agents/llm-utils";
import { createDefaultChatModel } from "../llm/model";

type ModelMessage = ConstructorParameters<typeof SystemMessage>[0];

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][INTENT_SKILL]", timeoutMs: 900000 });
const invokeModel = (messages: ModelMessage[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetry(getModel, messages, maxRetries, delay);

export type ParsedIntent = {
    intent: string;
    entities: string[];
    metrics?: string[];
    dimensions?: string[];
    filters?: string[];
};

export type IntentSkillInput = {
    query: string;
    focusTable?: string;
};

export type IntentSkillOutput = {
    intent: ParsedIntent;
};

export const intentSkill: SkillDefinition<IntentSkillInput, IntentSkillOutput> = {
    id: "intent-parser",
    description: "Extracts user goals, entities, metrics, and filters from natural language query.",
    run: async (input) => {
        const { query, focusTable } = input;

        const prompt = `You are an Intent Parsing Agent (Senior Analyst). Extract user goals into JSON.
FIELDS: intent (short string), entities (tables involved), metrics (requested values), dimensions (grouping), filters (where clause ideas).
${focusTable ? `CONTEXT: The user is currently inspecting the '${focusTable}' table. Prioritize this entity.` : ''}
QUERY: "${query}"`;

        const response = await invokeModel([new SystemMessage(prompt)]);
        const parsed = extractJSON(response.content as string) as Partial<ParsedIntent> | null;

        const fallback: ParsedIntent = {
            intent: focusTable ? `Focus on ${focusTable}` : "overview",
            entities: focusTable ? [focusTable] : [],
        };

        const raw = parsed ?? fallback;

        const entities = Array.isArray(raw.entities)
            ? (raw.entities as unknown[]).filter((e): e is string => typeof e === 'string' && e !== 'null')
            : [];

        return {
            intent: {
                intent: String(raw.intent || fallback.intent),
                entities,
                metrics: Array.isArray(raw.metrics) ? raw.metrics : undefined,
                dimensions: Array.isArray(raw.dimensions) ? raw.dimensions : undefined,
                filters: Array.isArray(raw.filters) ? raw.filters : undefined,
            }
        };
    }
};

let registered = false;
export function registerIntentSkill(): void {
    if (registered) return;
    registerSkill(intentSkill);
    registered = true;
}

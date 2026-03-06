import { registerSkill, type SkillDefinition } from "./registry";
import { SystemMessage } from "@langchain/core/messages";
import { invokeModelWithRetry, extractJSON } from "../agents/llm-utils";
import { createDefaultChatModel } from "../llm/model";

type ModelMessage = ConstructorParameters<typeof SystemMessage>[0];

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][ANALYTICS_SKILL]", timeoutMs: 900000 });
const invokeModel = (messages: ModelMessage[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetry(getModel, messages, maxRetries, delay);

export type AnalyticsSkillInput = {
    results: Array<{ widgetTitle?: string; data?: unknown[] }>;
};

export type AnalyticsSkillOutput = {
    analysis: { insights: string[]; anomalies?: string[] };
};

export const analyticsSkill: SkillDefinition<AnalyticsSkillInput, AnalyticsSkillOutput> = {
    id: "analytics",
    description: "Analyzes result datasets to provide insights and anomalies.",
    run: async (input) => {
        const { results } = input;

        const prompt = `Role: Senior Data Scientist. Analyze these results collectively.
RESULTS: ${JSON.stringify(results.map((r) => ({ title: r.widgetTitle, sample: r.data?.slice(0, 3) })))}

Return JSON: { "insights": ["..."], "anomalies": ["..."] }`;

        const response = await invokeModel([new SystemMessage(prompt)]);
        const analysis = extractJSON(response.content as string) as AnalyticsSkillOutput["analysis"] | null;

        return { analysis: analysis || { insights: ["Data patterns analyzed."] } };
    }
};

let registered = false;
export function registerAnalyticsSkill(): void {
    if (registered) return;
    registerSkill(analyticsSkill);
    registered = true;
}

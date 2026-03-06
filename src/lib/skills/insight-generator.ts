import { registerSkill, type SkillDefinition } from "./registry";
import { SystemMessage } from "@langchain/core/messages";
import { invokeModelWithRetry } from "../agents/llm-utils";
import { createDefaultChatModel } from "../llm/model";

type ModelMessage = ConstructorParameters<typeof SystemMessage>[0];

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][INSIGHT_GENERATOR_SKILL]", timeoutMs: 900000 });
const invokeModel = (messages: ModelMessage[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetry(getModel, messages, maxRetries, delay);

export type InsightGeneratorSkillInput = {
    dashboardName?: string;
    insights: string[];
};

export type InsightGeneratorSkillOutput = {
    summary: string[];
};

export const insightGeneratorSkill: SkillDefinition<InsightGeneratorSkillInput, InsightGeneratorSkillOutput> = {
    id: "insight-generator",
    description: "Summarizes executive findings.",
    run: async (input) => {
        const { dashboardName, insights } = input;

        const prompt = `Role: Senior Strategic Executive Analyst.
Dashboard: ${dashboardName || "AI Dashboard"}
Insights: ${JSON.stringify(insights)}

Summarize findings in 3 bulleted sentences. Focus on action and value.`;

        const response = await invokeModel([new SystemMessage(prompt)]);
        const summary = (response.content as string).split('\n').filter((s: string) => s.trim().length > 10);

        return { summary };
    }
};

let registered = false;
export function registerInsightGeneratorSkill(): void {
    if (registered) return;
    registerSkill(insightGeneratorSkill);
    registered = true;
}

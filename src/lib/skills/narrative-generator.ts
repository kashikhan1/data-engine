import { registerSkill, type SkillDefinition } from "./registry";
import { SystemMessage } from "@langchain/core/messages";
import { invokeModelWithRetry, extractJSON } from "../agents/llm-utils";
import { createDefaultChatModel } from "../llm/model";

type ModelMessage = ConstructorParameters<typeof SystemMessage>[0];

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][NARRATIVE_SKILL]", timeoutMs: 900000 });
const invokeModel = (messages: ModelMessage[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetry(getModel, messages, maxRetries, delay);

export type NarrativeResultItem = {
    title?: string;
    data?: unknown[];
};

export type NarrativeGeneratorSkillInput = {
    resultsList: NarrativeResultItem[];
};

export type NarrativeGeneratorSkillOutput = {
    narrative: string[];
};

export const narrativeGeneratorSkill: SkillDefinition<NarrativeGeneratorSkillInput, NarrativeGeneratorSkillOutput> = {
    id: "narrative-generator",
    description: "Analyzes result datasets to provide narrative insights.",
    run: async (input) => {
        const { resultsList } = input;

        const prompt = `Role: Senior Strategic Executive Analyst.
RESULTS: ${JSON.stringify(resultsList.map((r) => ({ title: r.title, sample: r.data?.slice(0, 3) })))}

TASK: Provide 3-4 professional, one-sentence bulleted insights based on this data.
Return JSON: { "insights": ["..."] }`;

        const response = await invokeModel([new SystemMessage(prompt)]);
        const data = extractJSON(response.content as string) as { insights?: string[] } | null;

        return { narrative: data?.insights || ["Data retrieval successful. Full analysis ready."] };
    }
};

let registered = false;
export function registerNarrativeGeneratorSkill(): void {
    if (registered) return;
    registerSkill(narrativeGeneratorSkill);
    registered = true;
}

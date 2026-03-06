import { registerSkill, type SkillDefinition } from "./registry";
import { SystemMessage } from "@langchain/core/messages";
import { invokeModelWithRetry, extractJSON } from "../agents/llm-utils";
import { createDefaultChatModel } from "../llm/model";

type ModelMessage = ConstructorParameters<typeof SystemMessage>[0];

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][CHART_DESIGN_SKILL]", timeoutMs: 900000 });
const invokeModel = (messages: ModelMessage[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetry(getModel, messages, maxRetries, delay);

export type ChartDesignSkillInput = {
    widgetTitle: string;
    type: string;
    columns: string[];
    sampleData: Record<string, unknown>[];
};

export type ChartDesignSkillOutput = {
    vegaSpec: Record<string, unknown> | null;
};

export const chartDesignSkill: SkillDefinition<ChartDesignSkillInput, ChartDesignSkillOutput> = {
    id: "chart-design",
    description: "Generates Vega-Lite specifications for dashboard charts based on data structure.",
    run: async (input) => {
        const { widgetTitle, type, columns, sampleData } = input;

        const vizPrompt = `Generate Vega-Lite for:
TITLE: ${widgetTitle}
TYPE: ${type}
COLUMNS: ${JSON.stringify(columns)}
SAMPLE: ${JSON.stringify(sampleData)}
Return ONLY JSON. Use "table" for data source.`;

        const response = await invokeModel([new SystemMessage(vizPrompt)]);
        const vegaSpec = extractJSON(response.content as string) as Record<string, unknown> | null;

        return { vegaSpec };
    }
};

let registered = false;
export function registerChartDesignSkill(): void {
    if (registered) return;
    registerSkill(chartDesignSkill);
    registered = true;
}

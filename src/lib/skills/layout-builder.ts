import { registerSkill, type SkillDefinition } from "./registry";
import { SystemMessage } from "@langchain/core/messages";
import { invokeModelWithRetry, extractJSON } from "../agents/llm-utils";
import { createDefaultChatModel } from "../llm/model";

type ModelMessage = ConstructorParameters<typeof SystemMessage>[0];

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][LAYOUT_BUILDER_SKILL]", timeoutMs: 900000 });
const invokeModel = (messages: ModelMessage[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetry(getModel, messages, maxRetries, delay);

export type WidgetRef = {
    widgetId: string;
    type: string;
    widgetTitle?: string;
};

export type LayoutItem = {
    i: string;
    x: number;
    y: number;
    w: number;
    h: number;
};

export type LayoutBuilderSkillInput = {
    widgets: WidgetRef[];
};

export type LayoutBuilderSkillOutput = {
    layout: LayoutItem[];
};

export const layoutBuilderSkill: SkillDefinition<LayoutBuilderSkillInput, LayoutBuilderSkillOutput> = {
    id: "layout-builder",
    description: "Arranges dashboard widgets into an optimized grid layout.",
    run: async (input) => {
        const { widgets } = input;

        const prompt = `Role: Senior UX/UI Engineer. 
TASK: Arrange ${widgets.length} components into a high-density, professional board.
WIDGETS: ${JSON.stringify(widgets.map((w) => ({ id: w.widgetId, type: w.type, title: w.widgetTitle })))}

GEOMETRY RULES:
1. TOP ROW: All 'kpi' type widgets must be in the first row. Width: 3 (4 per row). Height: 2.
2. MIDDLE SECTION: 'line', 'bar', 'donut', 'pie' charts. Width: 6 (2 per row) or 12 (1 per row). Height: 4.
3. BOTTOM SECTION: 'table' widgets. Width: 12. Height: 6.
4. ALIGNMENT: Ensure 'x' increments correctly (0, 3, 6, 9 for KPIs; 0, 6 for charts) and 'y' reflects clear row sections.

Return JSON Map: { "widget_id": { "x": number, "y": number, "w": number, "h": number } }`;

        const response = await invokeModel([new SystemMessage(prompt)]);
        const layoutMap = extractJSON(response.content as string) as Record<string, { x: number; y: number; w: number; h: number }> | null;

        const layout: LayoutItem[] = Object.entries(layoutMap ?? {}).map(([id, pos]) => ({
            i: id,
            ...pos,
        }));

        return { layout };
    }
};

let registered = false;
export function registerLayoutBuilderSkill(): void {
    if (registered) return;
    registerSkill(layoutBuilderSkill);
    registered = true;
}

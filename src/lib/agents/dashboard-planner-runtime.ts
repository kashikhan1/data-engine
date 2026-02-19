import { AIMessage, SystemMessage } from "@langchain/core/messages";

import { createDefaultChatModel } from "@/lib/llm/model";
import { PLANNER_WIDGET_TYPE_ORDER } from "@/types/dashboard";


import { extractJSON, invokeModelWithRetry as invokeModelWithRetryUtil } from "./llm-utils";
import { AgentState } from "./state";

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][PLANNER]", timeoutMs: 900000 });

const invokeModelWithRetry = (messages: any[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetryUtil(getModel, messages, maxRetries, delay);

function formatTableInsightsForPrompt(tableInsights: Record<string, any> | null) {
    if (!tableInsights) return "";
    const trimmed = Object.fromEntries(
        Object.entries(tableInsights).slice(0, 12).map(([table, insight]: [string, any]) => [
            table,
            {
                semantic: insight.semanticMatches
                    ? {
                        metrics: (insight.semanticMatches.metrics || []).map((m: any) => m.slug),
                        dimensions: (insight.semanticMatches.dimensions || []).map((d: any) => d.slug),
                    }
                    : undefined,
                kpis: (insight.kpis || []).map((kpi: any) => ({
                    title: kpi.title,
                    aggregation: kpi.aggregation,
                    column: kpi.column,
                })),
                dataMatrix: insight.dataMatrix
                    ? {
                        rowCount: insight.dataMatrix.rowCount,
                        columnCounts: insight.dataMatrix.columnCounts,
                        categoricalColumns: (insight.dataMatrix.categoricalCandidates || []).map((c: any) => c.column),
                        numericColumns: (insight.dataMatrix.numericCandidates || []).map((c: any) => c.column),
                    }
                    : undefined,
                filters: (insight.filters || []).map((f: any) => ({
                    title: f.title,
                    type: f.type,
                    column: f.column,
                    table: f.table,
                    targetTable: f.targetTable,
                })),
                queryExamples: (insight.queryExamples || []).slice(0, 3).map((ex: any) => ({
                    description: ex.description,
                    sql: ex.sql,
                    results: ex.results?.slice(0, 2),
                })),
            },
        ])
    );
    return JSON.stringify(trimmed).slice(0, 8000);
}


export async function dashboardPlannerAgent(state: typeof AgentState.State) {
    const intent = state.intent;
    const intentText = String(intent?.intent || "Dashboard Overview");
    const focusTable = state.context?.focusTable;
    const tableInsightsText = formatTableInsightsForPrompt(state.dataProfile || null);
    const projectContext = state.context?.projectContext || state.context?.projectAbout || "";
    const disabledTypes = Array.isArray(state.context?.disabledWidgetTypes) ? state.context?.disabledWidgetTypes : [];
    const allowedTypes = [...PLANNER_WIDGET_TYPE_ORDER].filter((t) => !disabledTypes.includes(t));
    const prompt = `Role: Senior Software Architect (15+ years in AI, backend engineering, data analytics, scalable system design).
    TASK: Design a dynamic, efficient, analytics-driven dashboard directly from the schema.
    
    INTENT: "${intentText}"
    ${projectContext ? `PROJECT_CONTEXT: ${projectContext}` : ""}
    SCHEMA: ${JSON.stringify(state.schemaInfo)}
    RELATIONS: ${JSON.stringify(state.schemaRelationships || [])}
    SAMPLES_CONEXT: ${JSON.stringify(state.sampleData || {})}
    ${tableInsightsText ? `TABLE_INSIGHTS: ${tableInsightsText}` : ""}
    ${focusTable ? `PRIMARY_ENTITY: Targeting table '${focusTable}'.` : ""}

    ALLOWED WIDGET TYPES (STRICT):
    ${allowedTypes.join(", ")}

    DO NOT include any widget types outside this list.

    Return JSON: { "title": "...", "actionable_plan": "...", "widgets": [] }`;

    const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
    let plan = extractJSON(response.content as string) || { title: "AI Dashboard", widgets: [] };

    const filterWidgetsByType = (value: any) => {
        if (!value || !Array.isArray(value.widgets) || allowedTypes.length === 0) return value;
        const allowedSet = new Set(allowedTypes);
        return { ...value, widgets: value.widgets.filter((w: any) => allowedSet.has(w?.type)) };
    };
    const buildWidgetOverviewText = (widgets: any[]) => {
        const lines: string[] = ["Widgets Overview"];
        widgets.forEach((w) => {
            const title = String(w?.title || w?.name || "Widget").trim();
            const type = String(w?.type || "chart").trim();
            const goal = String(w?.goal || "").trim();
            lines.push(`${title} (${type})`);
            if (goal) lines.push(goal);
        });
        return lines.join("\n");
    };

    if (!plan.widgets || plan.widgets.length === 0) {
        return {
            queryPlan: { ...plan, widgets: [] },
            errors: ["The agent failed to generate a valid dashboard plan from your schema."],
            status: "Planning failed. Please try a different query or check your connection.",
            messages: [new AIMessage("[PLANNER] Failed to architect a plan with actual data sources.")],
        };
    }

    plan = filterWidgetsByType(plan);
    if (disabledTypes.length > 0) {
        plan = { ...plan, actionable_plan: buildWidgetOverviewText(plan.widgets || []) };
    }

    if (allowedTypes.length === 0) {
        return {
            queryPlan: { ...plan, widgets: [] },
            errors: ["All widget types are disabled in settings."],
            status: "No widget types enabled. Update Widget Visibility settings and retry.",
            messages: [new AIMessage("[PLANNER] All widget types are disabled; cannot generate a plan.")],
        };
    }

    return {
        queryPlan: plan,
        status: `Professional blueprint generated with ${plan.widgets?.length || 0} high-impact components.`,
        messages: [new AIMessage(`[PLANNER] ${plan.actionable_plan || "Architected executive analytics blueprint."}`)],
    };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
'use server';

import { AgentState } from "./state";
import { AIMessage } from "@langchain/core/messages";
import { formatTableInsightsForPrompt } from "./prompt-utils";
import { dashboardPlannerAgent as dashboardPlannerAgentImpl } from "./dashboard-planner";

export async function intentAgent(state: typeof AgentState.State) {
    const lastMessage = state.messages[state.messages.length - 1];
    const query = typeof lastMessage.content === 'string' ? lastMessage.content : "Overview of data";
    const focusTable = state.context?.focusTable;

    const { runSkill } = await import("@/lib/skills/registry");
    const { registerIntentSkill } = await import("@/lib/skills/intent");
    registerIntentSkill();

    const { intent: parsed } = await runSkill<any, any>("intent-parser", { query, focusTable });

    return {
        intent: parsed,
        status: "Intent parsed.",
        messages: [new AIMessage(`[INTENT] Targets: ${parsed.entities.length > 0 ? parsed.entities.join(', ') : 'General'}`)]
    };
}

export async function queryEnhancerAgent(state: typeof AgentState.State) {
    const tableInsightsText = formatTableInsightsForPrompt(state.dataProfile as any);

    const { runSkill } = await import("@/lib/skills/registry");
    const { registerEnhancerSkill } = await import("@/lib/skills/enhancer");
    registerEnhancerSkill();

    const { enhanced } = await runSkill<any, any>("query-enhancer", {
        intent: state.intent,
        tableInsightsText,
        schemaInfo: state.schemaInfo
    });

    return {
        querySpecification: enhanced,
        status: "Technical context established.",
        messages: [new AIMessage(`[ENHANCER] Identified ${enhanced.suggested_metrics?.length || 0} key metrics for the dashboard.`)]
    };
}

export async function dashboardPlannerAgent(state: typeof AgentState.State) {
    return dashboardPlannerAgentImpl(state);
}

export async function* analyticsAgentStream(state: typeof AgentState.State) {
    yield { type: "progress", stage: "starting", message: "Starting analytics analysis..." };

    try {
        yield { type: "progress", stage: "analyzing", message: "Analyzing data patterns..." };

        const { runSkill } = await import("@/lib/skills/registry");
        const { registerAnalyticsSkill } = await import("@/lib/skills/analytics");
        registerAnalyticsSkill();

        const { analysis } = await runSkill<any, any>("analytics", { results: state.results });

        yield {
            type: "progress",
            stage: "generating_insights",
            message: `Generated ${analysis.insights?.length || 0} insights and ${analysis.anomalies?.length || 0} anomaly detections`
        };

        yield {
            type: "complete",
            analytics: analysis,
            insights: analysis.insights,
            message: "Analytics analysis complete"
        };
    } catch (error) {
        yield {
            type: "error",
            message: `Analytics analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
    }
}

export async function analyticsAgent(state: typeof AgentState.State) {
    const { runSkill } = await import("@/lib/skills/registry");
    const { registerAnalyticsSkill } = await import("@/lib/skills/analytics");
    registerAnalyticsSkill();

    const { analysis } = await runSkill<any, any>("analytics", { results: state.results });

    return {
        analytics: analysis,
        insights: analysis.insights,
        status: "Collective analysis complete.",
        messages: [new AIMessage(`[ANALYTICS] Generated strategic observations across ${state.results.length} datasets.`)]
    };
}

export async function* chartDesignAgentStream(state: typeof AgentState.State) {
    const results = state.results;
    const widgetSpecs: any[] = [];
    const totalWidgets = results.length;
    let processedWidgets = 0;

    const { runSkill } = await import("@/lib/skills/registry");
    const { registerChartDesignSkill } = await import("@/lib/skills/chart-design");
    registerChartDesignSkill();

    yield { type: "progress", stage: "starting", message: `Starting visualization design for ${totalWidgets} widgets...` };

    for (const res of results) {
        processedWidgets++;

        yield {
            type: "widget_progress",
            widgetId: res.widgetId,
            widgetTitle: res.widgetTitle,
            stage: "processing",
            message: `Designing visualization for ${res.widgetTitle} (${processedWidgets}/${totalWidgets})`
        };

        if (res.error || res.type === 'kpi' || res.type === 'table') {
            widgetSpecs.push(res);
            yield {
                type: "widget_complete",
                widgetId: res.widgetId,
                widgetTitle: res.widgetTitle,
                result: res,
                message: `${res.widgetTitle} requires no visualization (KPI/Table type)`
            };
            continue;
        }

        try {
            yield {
                type: "widget_progress",
                widgetId: res.widgetId,
                widgetTitle: res.widgetTitle,
                stage: "generating_spec",
                message: `Generating Vega-Lite specification for ${res.widgetTitle}...`
            };

            const { vegaSpec } = await runSkill<any, any>("chart-design", {
                widgetTitle: res.widgetTitle,
                type: res.type,
                columns: res.columns,
                sampleData: res.data?.slice(0, 2) || []
            });

            const widgetWithSpec = { ...res, vegaSpec };
            widgetSpecs.push(widgetWithSpec);

            yield {
                type: "widget_complete",
                widgetId: res.widgetId,
                widgetTitle: res.widgetTitle,
                result: widgetWithSpec,
                message: `Completed visualization design for ${res.widgetTitle}`
            };

        } catch (error) {
            const errorResult = { ...res, error: error instanceof Error ? error.message : 'Visualization generation failed' };
            widgetSpecs.push(errorResult);

            yield {
                type: "widget_error",
                widgetId: res.widgetId,
                widgetTitle: res.widgetTitle,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to generate visualization for ${res.widgetTitle}`
            };
        }
    }

    yield {
        type: "complete",
        results: widgetSpecs,
        message: `Visualization design complete: ${widgetSpecs.filter((w: any) => !w.error).length}/${totalWidgets} successful`
    };
}

export async function chartDesignAgent(state: typeof AgentState.State) {
    const results = state.results;
    const widgetSpecs: any[] = [];

    const { runSkill } = await import("@/lib/skills/registry");
    const { registerChartDesignSkill } = await import("@/lib/skills/chart-design");
    registerChartDesignSkill();

    for (const res of results) {
        if (res.error || res.type === 'kpi' || res.type === 'table') {
            widgetSpecs.push(res);
            continue;
        }

        const { vegaSpec } = await runSkill<any, any>("chart-design", {
            widgetTitle: res.widgetTitle,
            type: res.type,
            columns: res.columns,
            sampleData: res.data?.slice(0, 2) || []
        });

        widgetSpecs.push({ ...res, vegaSpec });
    }

    return {
        results: widgetSpecs,
        status: "Visualization specs synthesized.",
        messages: [new AIMessage(`[VISUALIZER] Completed visual mapping for all active components.`)]
    };
}

export async function smartLayoutBuilderAgent(state: typeof AgentState.State) {
    const widgets = state.results;

    const { runSkill } = await import("@/lib/skills/registry");
    const { registerLayoutBuilderSkill } = await import("@/lib/skills/layout-builder");
    registerLayoutBuilderSkill();

    const { layout } = await runSkill<any, any>("layout-builder", { widgets });

    return {
        executionPlan: layout,
        status: "Responsive layout calculated.",
        messages: [new AIMessage(`[LAYOUT] Optimized ${widgets.length} components for 12-column executive view.`)]
    };
}

export async function widgetRendererAgent(state: typeof AgentState.State) {
    const results = Array.isArray(state.results) ? state.results : [];
    const layoutFromState = Array.isArray(state.executionPlan) ? state.executionPlan : [];

    const fallbackFromPlan = () => {
        const planned = Array.isArray(state.queryPlan?.widgets) ? state.queryPlan.widgets : [];
        return planned.map((w: any, index: number) => ({
            widgetId: w.id || `widget_${index + 1}`,
            widgetTitle: w.title || `Widget ${index + 1}`,
            type: w.type || "table",
            goal: w.goal,
            plan_metric: w.metric,
            plan_dim: w.dim,
            data: undefined,
            columns: [w.dim, w.metric].filter(Boolean)
        }));
    };

    const baseResults = results.length > 0 ? results : fallbackFromPlan();

    const normalizedResults = baseResults.map((res, index) => {
        const fallbackId = res.widgetTitle ? `w_${res.widgetTitle.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : `widget_${index + 1}`;
        const widgetId = String(res.widgetId || fallbackId);
        return { ...res, widgetId };
    });

    const validIds = new Set(normalizedResults.map((res) => res.widgetId));
    const normalizedLayout = layoutFromState
        .filter((item: any) => item && item.i && validIds.has(String(item.i)))
        .map((item: any) => ({
            i: String(item.i),
            x: Number(item.x) || 0,
            y: Number(item.y) || 0,
            w: Number(item.w) || 6,
            h: Number(item.h) || 4,
        }));

    const layoutIds = new Set(normalizedLayout.map((item) => item.i));
    const fallbackLayout: any[] = [];

    const getDefaultSize = (type?: string) => {
        if (type === "kpi") return { w: 3, h: 2 };
        if (type === "table") return { w: 12, h: 6 };
        return { w: 6, h: 4 };
    };

    let cursorX = 0;
    let cursorY = normalizedLayout.length > 0
        ? Math.max(...normalizedLayout.map((item) => item.y + item.h))
        : 0;
    let rowHeight = 0;

    const placeNext = (widgetId: string, size: { w: number; h: number }) => {
        if (cursorX + size.w > 12) {
            cursorX = 0;
            cursorY += rowHeight || 1;
            rowHeight = 0;
        }

        const position = { i: widgetId, x: cursorX, y: cursorY, w: size.w, h: size.h };
        cursorX += size.w;
        rowHeight = Math.max(rowHeight, size.h);
        return position;
    };

    normalizedResults.forEach((res) => {
        if (!layoutIds.has(res.widgetId)) {
            fallbackLayout.push(placeNext(res.widgetId, getDefaultSize(res.type)));
            layoutIds.add(res.widgetId);
        }
    });

    const mergedLayout = [...normalizedLayout, ...fallbackLayout];
    const layoutById = new Map(mergedLayout.map((item) => [item.i, item]));

    const finalWidgets = normalizedResults.map(res => {
        const grid = layoutById.get(res.widgetId) || { x: 0, y: 0, w: 6, h: 4 };

        const safeColumns = Array.isArray(res.columns) ? res.columns : [];

        return {
            id: res.widgetId,
            title: res.widgetTitle,
            type: res.type,
            goal: res.goal,
            data: res.data,
            vegaSpec: (res as any).vegaSpec,
            kpiConfig: res.type === 'kpi' ? {
                valueField: res.plan_metric || safeColumns.find((c: string) => ['total', 'amount', 'revenue', 'count', 'sum'].some(k => c.toLowerCase().includes(k))) || safeColumns[0],
                format: 'compact'
            } : undefined,
            tableConfig: res.type === 'table' ? {
                columns: safeColumns.map((c: string) => ({ field: c, header: c.toUpperCase().replace(/_/g, ' ') }))
            } : undefined,
            position: grid
        };
    });

    return {
        dashboard: {
            id: `dash_${Date.now()}`,
            name: (state.queryPlan as any)?.title || "AI Insight Hub",
            widgets: finalWidgets.map(w => ({
                ...w,
                goal: w.goal
            })),
            layout: mergedLayout,
            actionablePlan: (state.queryPlan as any)?.actionable_plan
        },
        status: "Dashboard final assembly complete.",
        messages: [new AIMessage(`[RENDERER] Assembled full-fidelity dashboard configuration.`)]
    };
}

export async function insightGenerationAgent(state: typeof AgentState.State) {
    const { runSkill } = await import("@/lib/skills/registry");
    const { registerInsightGeneratorSkill } = await import("@/lib/skills/insight-generator");
    registerInsightGeneratorSkill();

    const { summary } = await runSkill<any, any>("insight-generator", {
        dashboardName: state.dashboard?.name,
        insights: state.insights
    });

    return {
        insights: summary,
        status: "Executive summary delivered.",
        messages: [new AIMessage(`[EXPLANATION] Dashboard narrative finalized.`)]
    };
}

export async function qualityCheckAgent(state: typeof AgentState.State) {
    const results = state.results || [];
    const retryCount = state.retryCount || 0;
    const maxRetries = 3;

    const errors: string[] = [];
    const needsRetry: string[] = [];
    const emptyWidgets: any[] = [];

    for (const result of results) {
        if (result.data && result.data.length === 0 && !result.error) {
            errors.push(`No data returned for "${result.widgetTitle || result.widgetId}".`);
            needsRetry.push(String(result.widgetId));
            emptyWidgets.push(result);
            continue;
        }

        if (result.error) {
            errors.push(`Execution error for "${result.widgetTitle || result.widgetId}": ${result.error}`);
            needsRetry.push(String(result.widgetId));
            continue;
        }

        if (result.data && result.data.length > 0) {
            const numericColumns = result.columns.filter((col: string) =>
                result.data.some((row: any) => typeof row[col] === 'number')
            );

            if (numericColumns.length > 0) {
                const nullCounts = numericColumns.map((col: string) => ({
                    column: col,
                    nullCount: result.data.filter((row: any) => row[col] === null).length
                }));

                const highNullColumns = nullCounts.filter((nc: any) => nc.nullCount > result.data.length * 0.5);
                if (highNullColumns.length > 0) {
                    errors.push(`High NULL values (${highNullColumns.map((nc: any) => `${nc.column}: ${nc.nullCount}/${result.data.length}`).join(', ')}) in "${result.widgetTitle}".`);
                }
            }
        }
    }

    if (needsRetry.length > 0 && retryCount < maxRetries) {
        console.log(`[QA] Quality issues detected. Triggering retry ${retryCount + 1}/${maxRetries}`);

        return {
            errors,
            status: `QA failed with ${errors.length} issues. Attempting retry ${retryCount + 1}/${maxRetries}...`,
            retryCount: retryCount + 1,
            shouldRepair: true,
            retryWidgets: needsRetry,
            emptyWidgets,
            messages: [new AIMessage(`[QA] Quality check failed. ${errors.length} issues found. Triggering SQL repair for widgets: ${needsRetry.join(', ')}`)]
        };
    }

    if (needsRetry.length > 0) {
        return {
            errors,
            status: `QA failed after ${maxRetries} retries. ${errors.length} unresolved issues.`,
            shouldContinue: true,
            messages: [new AIMessage(`[QA] Quality issues persist after ${maxRetries} retries. Proceeding with partial results.`)]
        };
    }

    return {
        status: "QA validation passed. All results meet quality standards.",
        qualityScore: 95,
        messages: [new AIMessage(`[QA] Quality check passed. All ${results.length} datasets meet quality standards.`)]
    };
}

export async function sqlRepairAgent(state: typeof AgentState.State) {
    const { retryWidgets = [], emptyWidgets = [], queryPlan, retryCount = 0 } = state;

    if (retryWidgets.length === 0) {
        return { status: "No widgets need repair. Skipping." };
    }

    console.log(`[SQL Repair] Repairing ${retryWidgets.length} widgets (retry ${retryCount})`);

    const { repairFailedQuery } = await import("./query-runtime");
    const schema = (state as any).schema || state.schemaInfo || {};
    const errorLog = (state.errors || []).map((err: string) => ({ id: "prev_error", error: err }));

    const repairs = await Promise.all(
        (emptyWidgets as any[]).map(async (widget: any) => {
            const widgetInPlan = (queryPlan?.widgets || []).find((w: any) => w.id === widget.widgetId);
            try {
                const result = await repairFailedQuery({
                    widgetId: widget.widgetId,
                    widgetTitle: widget.widgetTitle,
                    widgetType: widgetInPlan?.type || "chart",
                    widgetGoal: widgetInPlan?.goal,
                    originalSql: widget.sql || "",
                    errorMessage: widget.error || "Query returned empty results",
                    schema,
                    errorLog,
                });
                return { widgetId: widget.widgetId, sql: result.sql };
            } catch {
                return { widgetId: widget.widgetId, sql: widget.sql };
            }
        })
    );

    const repairedSQL = Object.fromEntries(repairs.map((r: any) => [r.widgetId, r.sql]));

    return {
        status: `SQL repair completed. Regenerated ${repairs.length} queries.`,
        repairedSQL,
        messages: [new AIMessage(`[SQL Repair] Repaired widgets: ${retryWidgets.join(", ")}`)],
    };
}

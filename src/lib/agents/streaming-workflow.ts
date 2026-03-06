/* eslint-disable @typescript-eslint/no-explicit-any */
// This file orchestrates streaming generators from nodes.ts which yield
// dynamically-shaped events. The `any` usages here are intentional runtime
// orchestration — all public-facing types remain strongly typed below.

import { AgentState } from "./state";
import { mcpCallingAgentStream } from "./executor-core";
import {
    analyticsAgentStream,
    chartDesignAgentStream
} from "./pipeline-support-agents";

/** Strongly typed StreamEvent used by consumers of this workflow. */
export interface StreamEvent {
    type: "progress" | "query_progress" | "query_complete" | "query_error" |
    "widget_progress" | "widget_complete" | "widget_error" |
    "analytics_progress" | "analytics_complete" |
    "viz_progress" | "viz_complete" | "viz_error" | "complete" | "error";
    stage?: string;
    message: string;
    widgetId?: string;
    widgetTitle?: string;
    result?: Record<string, unknown>;
    error?: string;
    completed?: number;
    total?: number;
    successCount?: number;
    totalCount?: number;
    results?: Record<string, unknown>[];
    analytics?: Record<string, unknown>;
    insights?: string[];
}

/**
 * Main streaming workflow that combines query execution, analytics, and dashboard building.
 * Shows parallel progress in a unified view.
 */
export async function* streamingSqlEngineerWorkflow(state: typeof AgentState.State): AsyncGenerator<Partial<StreamEvent>> {
    try {
        yield {
            type: "progress",
            stage: "starting",
            message: "🚀 Starting SQL Engineer workflow..."
        };

        // Phase 1: Query Execution with parallel tracking
        yield {
            type: "progress",
            stage: "query_execution",
            message: "📊 Phase 1: Executing SQL queries..."
        };

        const queryExecutor = mcpCallingAgentStream(state);

        for await (const event of queryExecutor) {
            const e = event as any;
            if (e.type === "query_progress") {
                yield {
                    ...e,
                    type: "query_progress" as const,
                    message: `🔍 ${e.message}`
                };
            } else if (e.type === "query_complete") {
                yield {
                    ...e,
                    type: "query_complete" as const,
                    message: `✅ ${e.message}`
                };
            } else if (e.type === "query_error") {
                yield {
                    ...e,
                    type: "query_error" as const,
                    message: `❌ ${e.message}`
                };
            } else if (e.type === "complete") {
                yield {
                    type: "progress",
                    stage: "query_complete_phase",
                    message: `✅ Query execution complete: ${e.successCount}/${e.totalCount} successful`
                };
                state.results = e.results || [];
                break;
            } else if (e.type === "error") {
                yield { type: "error", message: e.message || "Query execution error" };
                return;
            }
        }

        // Phase 2: Analytics Processing (parallel with next phase start)
        yield {
            type: "progress",
            stage: "analytics_start",
            message: "🧠 Phase 2: Running analytics analysis..."
        };

        const analyticsProcessor = analyticsAgentStream(state);
        const analyticsEvents: any[] = [];

        // Start analytics in background
        const analyticsPromise = (async () => {
            for await (const event of analyticsProcessor) {
                const e = event as any;
                analyticsEvents.push(e);
                if (e.type === "complete") {
                    state.analytics = e.analytics;
                    state.insights = e.insights;
                    return e;
                }
            }
            return null;
        })();

        // Phase 3: Dashboard Building (start in parallel with analytics)
        yield {
            type: "progress",
            stage: "dashboard_building",
            message: "🎨 Phase 3: Building dashboard visualizations..."
        };

        const visualizer = chartDesignAgentStream(state);

        for await (const event of visualizer) {
            const e = event as any;
            if (e.type === "widget_progress") {
                yield {
                    ...e,
                    type: "viz_progress" as const,
                    widgetId: String(e.widgetId ?? ""),
                    message: `🎨 ${e.message}`
                };
            } else if (e.type === "widget_complete") {
                yield {
                    ...e,
                    type: "viz_complete" as const,
                    widgetId: String(e.widgetId ?? ""),
                    message: `✨ ${e.message}`
                };
            } else if (e.type === "widget_error") {
                yield {
                    ...e,
                    type: "viz_error" as const,
                    widgetId: String(e.widgetId ?? ""),
                    message: `⚠️ ${e.message}`
                };
            } else if (e.type === "complete") {
                const widgetResults = (e.results || []) as Record<string, unknown>[];
                yield {
                    type: "progress",
                    stage: "dashboard_complete",
                    message: `🎉 Dashboard building complete: ${widgetResults.filter(r => !r.error).length}/${widgetResults.length} widgets ready`
                };
                state.results = e.results || [];
                break;
            }
        }

        // Wait for analytics to complete
        const analyticsResult = await analyticsPromise;
        if (analyticsResult) {
            for (const e of analyticsEvents) {
                if (e.type === "progress") {
                    yield {
                        ...e,
                        type: "analytics_progress" as const,
                        message: `🧠 ${e.message}`
                    };
                } else if (e.type === "complete") {
                    yield {
                        ...e,
                        type: "analytics_complete" as const,
                        message: `🎯 Analytics complete: ${(e.insights as string[] | undefined)?.length || 0} insights generated`
                    };
                }
            }
        }

        // Final completion
        yield {
            type: "complete",
            stage: "workflow_complete",
            results: (state.results || []) as Record<string, unknown>[],
            analytics: state.analytics as Record<string, unknown> | undefined,
            insights: (state.insights || []) as string[],
            message: "🚀 SQL Engineer workflow complete! Dashboard ready with queries, analytics, and visualizations."
        };

    } catch (error) {
        yield {
            type: "error",
            message: `Workflow failed: ${error instanceof Error ? error.message : "Unknown error"}`
        };
    }
}

/**
 * Backward compatibility: Export individual stream functions
 */
export { mcpCallingAgentStream, analyticsAgentStream, chartDesignAgentStream };

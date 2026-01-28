import { AgentState } from "./state";
import { 
    mcpCallingAgentStream,
    analyticsAgentStream, 
    chartDesignAgentStream 
} from "./nodes";

export interface StreamEvent {
    type: "progress" | "query_progress" | "query_complete" | "query_error" | 
          "widget_progress" | "widget_complete" | "widget_error" |
          "analytics_progress" | "analytics_complete" | 
          "viz_progress" | "viz_complete" | "complete" | "error";
    stage?: string;
    message: string;
    widgetId?: string;
    widgetTitle?: string;
    result?: any;
    error?: string;
    completed?: number;
    total?: number;
    successCount?: number;
    totalCount?: number;
    results?: any[];
    analytics?: any;
    insights?: string[];
}

/**
 * Main streaming workflow that combines query execution, analytics, and dashboard building
 * Shows parallel progress in a unified view
 */
export async function* streamingSqlEngineerWorkflow(state: typeof AgentState.State) {
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
        const queryResults: any[] = [];

        for await (const event of queryExecutor) {
            // Pass through all query events with enhanced context
            if (event.type === "query_progress") {
                yield { 
                    ...event, 
                    type: "query_progress" as const,
                    message: `🔍 ${event.message}`
                };
            } else if (event.type === "query_complete") {
                queryResults.push(event.result);
                yield { 
                    ...event, 
                    type: "query_complete" as const,
                    message: `✅ ${event.message}`
                };
            } else if (event.type === "query_error") {
                queryResults.push({ error: event.error, widgetId: event.widgetId });
                yield { 
                    ...event, 
                    type: "query_error" as const,
                    message: `❌ ${event.message}`
                };
            } else if (event.type === "complete") {
                yield { 
                    type: "progress", 
                    stage: "query_complete_phase", 
                    message: `✅ Query execution complete: ${event.successCount}/${event.totalCount} successful`
                };
                
                // Update state with query results for next phase
                state.results = event.results || [];
                break;
            } else if (event.type === "error") {
                yield event;
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
        let analyticsComplete = false;
        const analyticsEvents: any[] = [];

        // Start analytics in background
        const analyticsPromise = (async () => {
            for await (const event of analyticsProcessor) {
                analyticsEvents.push(event);
                if (event.type === "complete") {
                    state.analytics = event.analytics;
                    state.insights = event.insights;
                    return event;
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
            if (event.type === "widget_progress") {
                yield { 
                    ...event, 
                    type: "viz_progress" as const,
                    message: `🎨 ${event.message}`
                };
            } else if (event.type === "widget_complete") {
                yield { 
                    ...event, 
                    type: "viz_complete" as const,
                    message: `✨ ${event.message}`
                };
            } else if (event.type === "widget_error") {
                yield { 
                    ...event, 
                    type: "viz_error" as const,
                    message: `⚠️ ${event.message}`
                };
            } else if (event.type === "complete") {
                const widgetResults = event.results || [];
                yield { 
                    type: "progress", 
                    stage: "dashboard_complete", 
                    message: `🎉 Dashboard building complete: ${widgetResults.filter(r => !r.error).length}/${widgetResults.length} widgets ready`
                };
                
                // Update state with visualization results
                state.results = widgetResults;
                break;
            }
        }

        // Wait for analytics to complete
        const analyticsResult = await analyticsPromise;
        if (analyticsResult) {
            for (const event of analyticsEvents) {
                if (event.type === "progress") {
                    yield { 
                        ...event, 
                        type: "analytics_progress" as const,
                        message: `🧠 ${event.message}`
                    };
                } else if (event.type === "complete") {
                    yield { 
                        ...event, 
                        type: "analytics_complete" as const,
                        message: `🎯 Analytics complete: ${event.insights?.length || 0} insights generated`
                    };
                }
            }
        }

        // Final completion
        yield { 
            type: "complete", 
            stage: "workflow_complete",
            results: state.results || [],
            analytics: state.analytics,
            insights: state.insights || [],
            message: "🚀 SQL Engineer workflow complete! Dashboard ready with queries, analytics, and visualizations."
        };

    } catch (error) {
        yield { 
            type: "error", 
            message: `Workflow failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
        };
    }
}

/**
 * Backward compatibility: Export individual stream functions
 */
export { mcpCallingAgentStream, analyticsAgentStream, chartDesignAgentStream };
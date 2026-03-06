import { NextRequest } from "next/server";
import { graph } from "@/modules/runtime/agent";
import { HumanMessage } from "@langchain/core/messages";
import { serializeForClient } from "@/utils/serialization";
import { runRegistry } from "@/modules/runtime/agent";
import { AgentStep } from "@/types/dashboard";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ runId: string }> }
) {
    const { runId } = await params;
    const runParams = runRegistry.get(runId);

    if (!runParams) {
        return new Response("Run not found", { status: 404 });
    }

    const stream = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder();
            let isClosed = false;

            const closeStream = () => {
                if (isClosed) return;
                isClosed = true;
                try {
                    controller.close();
                } catch {
                    // noop – controller might already be closed
                }
            };

            // If the client disconnects, stop trying to push events.
            request.signal.addEventListener("abort", closeStream);

            const sendEvent = (event: any) => {
                if (isClosed) return;
                try {
                    const data = `data: ${JSON.stringify(serializeForClient(event))}\n\n`;
                    controller.enqueue(encoder.encode(data));
                } catch {
                    // Ignore errors if controller is closed
                    isClosed = true;
                }
            };

            try {
                const initialState = {
                    messages: [new HumanMessage(runParams.query)],
                    intent: null,
                    executionPlan: null,
                    queryPlan: null,
                    schemaInfo: null,
                    sampleData: null,
                    securityClearance: null,
                    sqlQueries: [],
                    results: [],
                    qualityReport: null,
                    transformedData: null,
                    dashboard: null,
                    insights: [],
                    errors: [],
                    status: "Analyzing request...",
                    retryCount: 0,
                    runId,
                    ...runParams.options,
                };

                const startedAt = new Date().toISOString();
                let currentState = initialState;

                // Stream the graph
                for await (const update of await (graph.stream(initialState, {
                    streamMode: "updates",
                    recursionLimit: 200 // Increased recursionLimit from 100 to 200
                }) as any)) {
                    const nodeName = Object.keys(update)[0];
                    const data = update[nodeName];
                    console.log(`[STREAM][${runId}] Node completed: ${nodeName}. Data keys: ${Object.keys(data).join(', ')}`);

                    // Merge delta into current state
                    currentState = { ...currentState, ...data };

                    // Map node names to AgentStep for the UI (12-agent "Smart Dashboard" Pipeline)
                    let agentStep: AgentStep = "plan";
                    if (nodeName === "intent_understanding") agentStep = "plan";
                    else if (nodeName === "schema_agent") agentStep = "plan";
                    else if (nodeName === "query_enhancer") agentStep = "plan";
                    else if (nodeName === "dashboard_planner") agentStep = "plan";
                    else if (nodeName === "reporting_agent") agentStep = "plan";
                    else if (nodeName === "multi_query_orchestrator") agentStep = "sql";
                    else if (nodeName === "sql_generator") agentStep = "sql"; // Legacy support
                    else if (nodeName === "security_check") agentStep = "policy";
                    else if (nodeName === "query_execution") agentStep = "execute";
                    else if (nodeName === "analytics_agent") agentStep = "qa";
                    else if (nodeName === "visualization_agent") agentStep = "viz";
                    else if (nodeName === "smart_layout_builder") agentStep = "viz";
                    else if (nodeName === "widget_renderer") agentStep = "viz";
                    else if (nodeName === "explanation_agent") agentStep = "narrative";
                    else if (nodeName === "error_recovery") agentStep = "plan";
                    else {
                        console.warn(`[STREAM][${runId}] Unknown node name: ${nodeName}, defaulting to plan`);
                        agentStep = "plan";
                    }

                    // Send step completion event
                    const hasError = data.errors && data.errors.length > 0;
                    console.log(`[STREAM][${runId}] Sending step event: ${agentStep} status: ${hasError ? "fail" : "done"}`);
                    sendEvent({
                        type: "step",
                        step: agentStep,
                        status: hasError ? "fail" : "done",
                        message: data.status,
                        ts: new Date().toISOString(),
                    });

                    // If node emitted messages (logs), pass them through as LogEvents
                    if (data.messages && data.messages.length > 0) {
                        for (const msg of data.messages) {
                            if (msg instanceof Object && 'content' in msg) {
                                console.log(`[STREAM][${runId}] Sending log: ${msg.content}`);
                                sendEvent({
                                    type: "log",
                                    message: msg.content as string,
                                    level: "info",
                                    step: agentStep,
                                    ts: new Date().toISOString(),
                                });
                            }
                        }
                    }

                    // If partial results are available
                    if (data.results && data.results.length > 0) {
                        for (const result of data.results) {
                            sendEvent({
                                type: "partial_results",
                                queryId: result.widgetId || result.widgetTitle,
                                rowsPreview: result.data,
                                ts: new Date().toISOString(),
                            });
                        }
                    }

                    // If partial dashboard is available
                    if (data.dashboard) {
                        sendEvent({
                            type: "partial_dashboard",
                            dashboard: data.dashboard,
                            ts: new Date().toISOString(),
                        });
                    }

                    // Explicitly send schema updates if available
                    if (data.schemaInfo) {
                        sendEvent({
                            type: "schema_update",
                            schemaInfo: data.schemaInfo,
                            sampleData: data.sampleData,
                            schemaRelationships: data.schemaRelationships,
                            ts: new Date().toISOString(),
                        });
                    }
                }

                // Final event
                sendEvent({
                    type: "final",
                    envelope: {
                        runId,
                        status: currentState.errors.length > 0 ? "failed" : "completed",
                        dashboard: currentState.dashboard,
                        startedAt,
                        completedAt: new Date().toISOString(),
                        error: currentState.errors.join(", "),
                    },
                    ts: new Date().toISOString(),
                });

            } catch (error: any) {
                console.error(`[STREAM] Error in run ${runId}:`, error);
                sendEvent({
                    type: "error",
                    message: error.message || "Internal execution error",
                    ts: new Date().toISOString(),
                });
            } finally {
                runRegistry.delete(runId);
                closeStream();
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        },
    });
}

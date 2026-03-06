import { NextRequest, NextResponse } from "next/server";
import { graph } from "@/modules/runtime/agent";
import { HumanMessage } from "@langchain/core/messages";

export async function POST(req: NextRequest) {
    try {
        const { message } = await req.json();

        if (!message) {
            return NextResponse.json({ error: "No message provided" }, { status: 400 });
        }

        // Initialize the state
        const initialState = {
            messages: [new HumanMessage(message)],
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
            status: "Starting analysis...",
            retryCount: 0,
        };

        // Run the graph
        // We'll use stream to send progress events
        const stream = await graph.stream(initialState, {
            streamMode: "updates",
            recursionLimit: 200
        });

        const encoder = new TextEncoder();
        const readableStream = new ReadableStream({
            async start(controller) {
                try {
                    for await (const chunk of stream) {
                        // Identify which node produced the update
                        const nodeName = Object.keys(chunk)[0];
                        const update = (chunk as any)[nodeName];

                        if (update.status) {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "status", content: update.status })}\n\n`));
                        }

                        if (update.dashboard) {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "dashboard", content: update.dashboard })}\n\n`));
                        }

                        if (update.messages && update.messages.length > 0) {
                            const lastMsg = update.messages[update.messages.length - 1];
                            if (lastMsg._getType() === "ai") {
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "message", content: lastMsg.content })}\n\n`));
                            }
                        }
                    }
                } catch (error: any) {
                    const message = error?.message || "Chat stream failed";
                    console.error("Chat API Stream Error:", error);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", content: message })}\n\n`));
                } finally {
                    controller.close();
                }
            },
        });

        return new Response(readableStream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });

    } catch (error: any) {
        console.error("Chat API Error:", error);
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}

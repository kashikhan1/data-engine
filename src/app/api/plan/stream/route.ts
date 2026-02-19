import { NextRequest } from "next/server";
import { runDashboardPlannerStream } from "@/lib/agents/dashboard-planner";

export const maxDuration = 900; // 15 minutes

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { query, schema } = body;

        if (!query || !schema) {
            return new Response("Missing query or schema", { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                const { signal } = request;
                let closed = false;

                const close = () => {
                    if (closed) return;
                    closed = true;
                    try { controller.close(); } catch (_) { /* noop */ }
                };

                const enqueue = (data: string) => {
                    if (closed || signal.aborted) return;
                    try {
                        controller.enqueue(encoder.encode(data));
                    } catch (err) {
                        // If controller is already closed/errored, ignore further enqueues
                        closed = true;
                    }
                };

                const abortHandler = () => {
                    close();
                };

                if (signal) {
                    signal.addEventListener("abort", abortHandler);
                }

                try {
                    // Send an immediate "start" event to keep the connection alive
                    enqueue(`data: ${JSON.stringify({ kind: "chunk", chunk: "" })}\n\n`);

                    for await (const item of runDashboardPlannerStream(query, schema)) {
                        if (signal?.aborted) break;
                        enqueue(`data: ${JSON.stringify(item)}\n\n`);
                    }
                    close();
                } catch (err: any) {
                    console.error("[API_PLAN_STREAM] Inner error:", err);
                    if (!closed) {
                        try { controller.error(err); } catch (_) { /* noop */ }
                    }
                } finally {
                    if (signal) {
                        signal.removeEventListener("abort", abortHandler);
                    }
                }
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });
    } catch (error: any) {
        console.error("[API_PLAN_STREAM] Outer error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}

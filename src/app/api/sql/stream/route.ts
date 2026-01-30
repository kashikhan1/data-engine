import { NextRequest } from "next/server";
import { runQueryGenerator } from "@/lib/agents/nodes";

export const maxDuration = 900; // 15 minutes

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { plan, schema, filters, errorLog, applyFilters, connectorInstructions, connectorType, connectionString } = body;

        if (!plan || !schema) {
            return new Response("Missing plan or schema", { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // Initial ping to keep connection alive
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "started" })}\n\n`));

                    // Run generator
                    const schemaForPrompt = {
                        ...schema,
                        connectorInstructions: connectorInstructions || schema?.connectorInstructions,
                        connectorType: connectorType || schema?.connectorType,
                        connectionString: schema?.connectionString || connectionString || schema?.dbUrl || schema?.postgresUrl || schema?.mssqlUrl
                    };
                    const queries = await runQueryGenerator(plan, schemaForPrompt, filters || {}, errorLog || [], Boolean(applyFilters));

                    const entries = Object.entries(queries || {});
                    if (entries.length > 0) {
                        entries.forEach(([id, sql], index) => {
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "query", id, sql, index: index + 1, total: entries.length })}\n\n`));
                        });
                    }

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "completed", queries })}\n\n`));
                    controller.close();
                } catch (err: any) {
                    console.error("[API_SQL_STREAM] Inner error:", err);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "error", message: err.message || 'Unknown error' })}\n\n`));
                    controller.close();
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
        console.error("[API_SQL_STREAM] Outer error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}

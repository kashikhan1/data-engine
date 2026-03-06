import { NextRequest } from "next/server";
import { runQueryGenerator } from "@/modules/sql/agent";

export const maxDuration = 900; // 15 minutes

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { plan, schema, query, filters, errorLog, applyFilters, connectorInstructions, connectorType, connectionString } = body;

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
                        connectionString: schema?.connectionString || connectionString || schema?.dbUrl || schema?.postgresUrl || schema?.mssqlUrl,
                        userQuery: query || schema?.userQuery || plan?.query || plan?.originalQuery || ""
                    };
                    const tables = Object.keys(schemaForPrompt?.schemaInfo || {});
                    const columnCount = tables.reduce((sum, table) => sum + (Array.isArray(schemaForPrompt?.schemaInfo?.[table]?.columns) ? schemaForPrompt.schemaInfo[table].columns.length : 0), 0);
                    const hasVisibleMap = Boolean(schemaForPrompt?.visibleColumns && typeof schemaForPrompt.visibleColumns === "object");
                    const visibleCount = hasVisibleMap
                        ? tables.reduce((sum, table) => sum + (Array.isArray(schemaForPrompt?.visibleColumns?.[table]) ? schemaForPrompt.visibleColumns[table].length : 0), 0)
                        : columnCount;
                    const hiddenCount = Math.max(0, columnCount - visibleCount);
                    const relationships = Array.isArray(schemaForPrompt?.relationships) ? schemaForPrompt.relationships.length : 0;
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                        status: "log",
                        stage: "sql",
                        message: `Schema scoped for SQL: ${tables.length} tables, ${columnCount} columns (${visibleCount} visible, ${hiddenCount} hidden), ${relationships} relationships`
                    })}\n\n`));
                    const queries = await runQueryGenerator(
                        plan,
                        schemaForPrompt,
                        filters || {},
                        errorLog || [],
                        Boolean(applyFilters),
                        (id, sql, index, total, path) => {
                            const widget = Array.isArray(plan?.widgets) ? plan.widgets.find((w: any) => w?.id === id) : null;
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                                status: "widget_ready",
                                id,
                                sql,
                                index,
                                total,
                                path: path || "full",
                                widgetType: widget?.type || "unknown",
                                widgetGoal: widget?.goal || "",
                                primaryTable: widget?.primaryTable || "",
                                uses: widget?.uses || "",
                                notes: widget?.notes || "",
                            })}\n\n`));
                        }
                    );

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "completed", queries })}\n\n`));
                    controller.close();
                } catch (err: unknown) {
                    const message = err instanceof Error ? err.message : "Unknown error";
                    console.error("[API_SQL_STREAM] Inner error:", err);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "error", message })}\n\n`));
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
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Unknown error";
        console.error("[API_SQL_STREAM] Outer error:", error);
        return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}

import { NextRequest } from "next/server";
import { createDefaultChatModel } from "@/lib/llm/model";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { executeQuery } from "@/app/actions/mcp";
import { getCurrentDateTimeContext } from "@/lib/agents/planner/current-datetime-tool";

export const maxDuration = 300; // 5 minutes

async function buildNarrative(model: any, question: string, columns: string[], rows: any[]): Promise<string> {
    if (rows.length === 0) return "The query returned no results.";
    const preview = rows.slice(0, 10).map(row => {
        const entry = columns.map(c => `${c}: ${row[c] != null ? row[c] : "—"}`).join(", ");
        return `• ${entry}`;
    }).join("\n");
    const truncated = rows.length > 10 ? `\n(${rows.length - 10} more rows not shown)` : "";
    try {
        const resp = await model.invoke([
            new SystemMessage("You are a helpful data analyst. Given a user question and query results, write a concise 1-3 sentence human-readable answer. Be direct and specific — mention actual numbers, names, or dates from the data. Do not mention SQL."),
            new HumanMessage(`Question: ${question}\n\nResults (${rows.length} rows):\n${preview}${truncated}`)
        ]);
        const text = typeof resp.content === "string" ? resp.content.trim() : String(resp.content).trim();
        return text || `Found ${rows.length} result${rows.length !== 1 ? "s" : ""}.`;
    } catch {
        return `Found ${rows.length} result${rows.length !== 1 ? "s" : ""}.`;
    }
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { question, schema, connectorInstructions, connectorType, connectionString } = body;

        if (!question || !schema) {
            return new Response("Missing question or schema", { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                const send = (data: any) => {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
                };

                try {
                    send({ status: "started", message: "Analyzing your question..." });

                    // Build COMPACT schema context (budget-aware for small context models)
                    const MAX_COLS_PER_TABLE = 20;
                    const SCHEMA_CHAR_BUDGET = 6000;

                    const tables = schema.tables || Object.keys(schema.schemaInfo || {});
                    const schemaLines: string[] = [];
                    let totalChars = 0;

                    for (const table of tables) {
                        const info = schema.schemaInfo?.[table];
                        if (!info) continue;

                        // Respect visibleColumns set by SchemaDiscovery column toggles
                        const visibleSet: Set<string> | null = Array.isArray(schema.visibleColumns?.[table])
                            ? new Set((schema.visibleColumns[table] as string[]).map((c: string) => c.toLowerCase()))
                            : null;

                        const allCols = (info.columns || []).filter((c: any) => {
                            if (!visibleSet) return true;
                            const name = (c?.name || c?.column_name || "").toLowerCase();
                            return name && visibleSet.has(name);
                        });

                        // Skip table entirely if all columns were hidden
                        if (visibleSet && allCols.length === 0) continue;

                        const disabledSet: Set<string> | null = Array.isArray(schema.disabledFilterColumns?.[table])
                            ? new Set((schema.disabledFilterColumns[table] as string[]).map((c: string) => c.toLowerCase()))
                            : null;

                        const shown = allCols.slice(0, MAX_COLS_PER_TABLE);
                        const colStr = shown.map((c: any) => {
                            const name = c?.name || c?.column_name || "";
                            const type = c?.type || c?.data_type || "";
                            const noFilter = disabledSet !== null && disabledSet.has(name.toLowerCase());
                            return noFilter ? `${name}(${type})[no-filter]` : `${name}(${type})`;
                        }).join(", ");
                        const overflow = allCols.length > MAX_COLS_PER_TABLE ? ` +${allCols.length - MAX_COLS_PER_TABLE} more` : "";

                        let line = `${table}: ${colStr}${overflow}`;
                        // Compact PKs
                        if (info.primaryKeys?.length) {
                            line += ` | PK: ${info.primaryKeys.join(",")}`;
                        }
                        // Compact FKs (single line)
                        if (info.foreignKeys?.length) {
                            const fks = info.foreignKeys.map((fk: any) => `${fk.column_name}->${fk.foreign_table_name}.${fk.foreign_column_name}`).join(", ");
                            line += ` | FK: ${fks}`;
                        }

                        if (totalChars + line.length > SCHEMA_CHAR_BUDGET) {
                            schemaLines.push(`... and ${tables.length - schemaLines.length} more tables (truncated)`);
                            break;
                        }
                        schemaLines.push(line);
                        totalChars += line.length;
                    }

                    const connLower = (connectionString || "").toLowerCase();
                    const typeLower = (connectorType || "").toLowerCase();
                    const isMssql = typeLower.includes("mssql") ||
                        typeLower.includes("sqlserver") ||
                        typeLower.includes("sql server") ||
                        (connectorInstructions || "").toLowerCase().includes("mssql") ||
                        connLower.startsWith("mssql://") ||
                        connLower.startsWith("sqlserver://") ||
                        connLower.includes("server=") ||
                        connLower.includes("data source=");

                    const dialect = isMssql ? "T-SQL (MS SQL Server)" : "PostgreSQL";
                    const dateCtx = getCurrentDateTimeContext();

                    // Build ENABLED filter columns (whitelist) from filterableColumns
                    const enabledFilterCols: Record<string, string[]> = schema.filterableColumns || {};
                    const enabledLines = Object.entries(enabledFilterCols)
                        .filter(([, cols]) => Array.isArray(cols) && cols.length > 0)
                        .map(([table, cols]) => `  ${table}: ${cols.join(", ")}`);
                    const filterWhitelistBlock = enabledLines.length > 0
                        ? `\nALLOWED FILTER COLUMNS — ONLY these columns may appear in WHERE, HAVING, or JOIN ON conditions:\n${enabledLines.join("\n")}\nAll other columns are SELECT-only. Do NOT filter on any column not listed above.`
                        : "";

                    const systemPrompt = `You are a SQL expert. Generate a single ${dialect} query answering the user's question.

TODAY: ${dateCtx.todayDate} (${dateCtx.currentTimeZone}) — use this for any relative date expressions like "today", "this week", "last month", "this year", etc.

SCHEMA (all visible columns for SELECT):
${schemaLines.join("\n")}
${connectorInstructions ? `\nNOTES: ${connectorInstructions}` : ""}${filterWhitelistBlock}

RULES:
- Return ONLY raw SQL. No markdown, no explanation, no code fences. Limit to 100 rows.
- SELECT: Include all relevant columns from the schema that help answer the question — do not return just one column.
- WHERE / HAVING: You may ONLY filter on columns listed under ALLOWED FILTER COLUMNS. If the user's question requires a date/time filter, use the nearest enabled date column (e.g. created_at, updated_at).
- FILTER VALUES: If the user mentions a specific value (name, status, country, category, ID, amount, etc.), embed it as a literal. Never use placeholders like ?, :param, or $1.
- CASE: Use case-insensitive matching (${isMssql ? "LIKE or LOWER()" : "ILIKE or LOWER()"}) when filtering text fields.`;

                    send({ status: "generating_sql", message: "Generating SQL query..." });

                    const model = await createDefaultChatModel();
                    const response = await model.invoke([
                        new SystemMessage(systemPrompt),
                        new HumanMessage(question)
                    ]);

                    let sql = typeof response.content === "string"
                        ? response.content
                        : String(response.content);

                    // Clean up the SQL
                    sql = sql.replace(/```sql\s*/gi, "").replace(/```\s*/g, "").trim();
                    if (sql.toLowerCase().startsWith("sql\n")) {
                        sql = sql.substring(4).trim();
                    }

                    send({ status: "sql_ready", sql, message: "SQL generated, executing..." });

                    // Execute the query — prefer body-level connectionString (live selection) over schema.connectionString (may be stale)
                    const connStr = connectionString || schema?.connectionString;

                    if (!connStr) {
                        throw new Error("No connection string available to execute query.");
                    }

                    send({ status: "executing", message: "Running query on database..." });

                    const result = await executeQuery(sql, connStr) as any;

                    if (result.error) {
                        // Try to repair the query once
                        send({ status: "repairing", message: `Query error: ${result.error}. Attempting repair...` });

                        const repairPrompt = `The following SQL query failed with an error. Fix ONLY the syntax/schema error — preserve all WHERE clause filter values exactly as they are.

Original SQL:
${sql}

Error:
${result.error}

Database schema:
${schemaLines.slice(0, 20).join("\n")}

IMPORTANT: Keep all hardcoded filter values (names, statuses, countries, IDs, etc.) from the original query. Do not replace them with placeholders.
Return ONLY the corrected SQL query, no explanation, no markdown.`;

                        const repairResponse = await model.invoke([
                            new SystemMessage(`You are a ${dialect} repair expert. Fix the broken ${dialect} SQL while preserving all filter values. Return ONLY the corrected SQL.`),
                            new HumanMessage(repairPrompt)
                        ]);

                        let repairedSql = typeof repairResponse.content === "string"
                            ? repairResponse.content
                            : String(repairResponse.content);
                        repairedSql = repairedSql.replace(/```sql\s*/gi, "").replace(/```\s*/g, "").trim();

                        send({ status: "sql_repaired", sql: repairedSql, message: "Retrying with repaired SQL..." });

                        const retryResult = await executeQuery(repairedSql, connStr) as any;

                        if (retryResult.error) {
                            send({
                                status: "error",
                                message: `Query failed: ${retryResult.error}`,
                                sql: repairedSql,
                                originalError: result.error
                            });
                        } else {
                            const retryRows = retryResult.rows || retryResult.data || retryResult;
                            const retryArr = Array.isArray(retryRows) ? retryRows : [];
                            const retryCols = (retryResult.columns || (retryArr[0] ? Object.keys(retryArr[0]) : []))
                                .filter((c: string) => c !== "__rowKey");
                            send({ status: "summarizing", message: "Summarizing results..." });
                            const narrative = await buildNarrative(model, question, retryCols, retryArr);
                            send({
                                status: "completed",
                                data: retryArr,
                                columns: retryCols,
                                rowCount: retryResult.rowCount || retryArr.length,
                                sql: repairedSql,
                                repaired: true,
                                narrative,
                                message: narrative
                            });
                        }
                    } else {
                        const rows = result.rows || result.data || result;
                        const dataArr = Array.isArray(rows) ? rows : [];
                        const cols = (result.columns || (dataArr[0] ? Object.keys(dataArr[0]) : []))
                            .filter((c: string) => c !== "__rowKey");
                        send({ status: "summarizing", message: "Summarizing results..." });
                        const narrative = await buildNarrative(model, question, cols, dataArr);
                        send({
                            status: "completed",
                            data: dataArr,
                            columns: cols,
                            rowCount: result.rowCount || dataArr.length,
                            sql,
                            narrative,
                            message: narrative
                        });
                    }
                } catch (err: any) {
                    console.error("[CHAT_QA_API] Error:", err);
                    send({
                        status: "error",
                        message: err.message || "Chat Q&A failed"
                    });
                } finally {
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
        console.error("[CHAT_QA_API] Outer error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}

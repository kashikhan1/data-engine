import { NextRequest } from "next/server";
import { createDefaultChatModel } from "@/lib/llm/model";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { executeQuery } from "@/app/actions/mcp";

export const maxDuration = 300; // 5 minutes

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

                    // Get today's date
                    const today = new Date();
                    const todayStr = today.toISOString().split('T')[0];
                    const todayFormatted = today.toLocaleDateString('en-US', { 
                        weekday: 'long', 
                        year: 'numeric', 
                        month: 'long', 
                        day: 'numeric' 
                    });

                    // Build COMPACT schema context (budget-aware for small context models)
                    const MAX_COLS_PER_TABLE = 20;
                    const SCHEMA_CHAR_BUDGET = 6000;

                    const tables = schema.tables || Object.keys(schema.schemaInfo || {});
                    const schemaLines: string[] = [];
                    let totalChars = 0;

                    for (const table of tables) {
                        const info = schema.schemaInfo?.[table];
                        if (!info) continue;
                        const allCols = info.columns || [];
                        const shown = allCols.slice(0, MAX_COLS_PER_TABLE);
                        const colStr = shown.map((c: any) => `${c.name}(${c.type})`).join(", ");
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

                    // Validate if question is related to schema
                    const questionLower = question.toLowerCase();
                    const schemaKeywords = [
                        ...tables,
                        ...tables.flatMap((t: string) => {
                            const info = schema.schemaInfo?.[t];
                            return info?.columns?.map((c: any) => c.name || c.column_name) || [];
                        }),
                        'order', 'customer', 'product', 'sale', 'revenue', 'date', 'count', 'sum', 
                        'average', 'total', 'revenue', 'sales', 'users', 'items', 'transaction',
                        'show', 'get', 'find', 'what', 'how many', 'list', 'top', 'bottom'
                    ].map((k: string) => k.toLowerCase());
                    
                    const isRelatedToSchema = schemaKeywords.some((keyword: string) => 
                        questionLower.includes(keyword)
                    ) || questionLower.match(/\b(where|when|which|who|what|how many|show|get|find|list)\b/);

                    if (!isRelatedToSchema) {
                        send({
                            status: "error",
                            message: "I don't have context about that topic. I can only answer questions about your database schema. Please ask about your data, tables, or specific business metrics."
                        });
                        controller.close();
                        return;
                    }

                    const isMssql = (connectorType || "").toLowerCase().includes("mssql") ||
                        (connectorInstructions || "").toLowerCase().includes("mssql") ||
                        (connectionString || "").toLowerCase().includes("mssql");

                    const dialect = isMssql ? "T-SQL (MS SQL Server)" : "PostgreSQL";

                    const helperFunctions = isMssql ? `
**MSSQL Helper Functions:**
- Today's date: CAST(GETDATE() AS DATE)
- Add/subtract days: DATEADD(day, N, date_col) or DATEADD(day, -N, date_col)
- Date difference: DATEDIFF(day, start, end)
- Truncate to month: DATEADD(month, DATEDIFF(month, 0, date_col), 0)
- Case-insensitive search: col LIKE '%term%'
- Pagination: OFFSET N ROWS FETCH NEXT M ROWS ONLY or TOP N
- Safe division: numerator / NULLIF(denominator, 0)
- Handle NULL: ISNULL(col, 0) or COALESCE(col, 0)
- String concat: col1 + ' ' + col2
- Row number: ROW_NUMBER() OVER (ORDER BY col)` : `
**PostgreSQL Helper Functions:**
- Today's date: CURRENT_DATE
- Add/subtract days: date_col + INTERVAL 'N days' or date_col - INTERVAL 'N days'
- Date difference: (end_date::date - start_date::date)
- Truncate to month: DATE_TRUNC('month', date_col)
- Case-insensitive search: col ILIKE '%term%'
- Pagination: LIMIT N OFFSET M
- Safe division: numerator / NULLIF(denominator, 0)
- Handle NULL: COALESCE(col, 0)
- String concat: col1 || ' ' || col2 or CONCAT(col1, ' ', col2)
- Row number: ROW_NUMBER() OVER (ORDER BY col)
- Conditional count: COUNT(*) FILTER (WHERE condition)`;

                    const systemPrompt = `You are a SQL expert. Generate a single ${dialect} query answering the user's question.

DATABASE TYPE: ${dialect}
TODAY'S DATE: ${todayFormatted} (${todayStr})
Use this date when processing relative date queries like "today", "this week", "last month", etc.

${helperFunctions}

SCHEMA:
${schemaLines.join("\n")}
${connectorInstructions ? `\nNOTES: ${connectorInstructions}` : ""}

7. **COALESCE TYPE SAFETY** - Postgres errors on \`COALESCE(interval, 0)\`. If calculating age/days (\`A - B\`) involving timestamps, cast to date FIRST (\`A::date - B::date\`) or use \`EXTRACT(DAY FROM (A - B))::integer\`.
RULES: Return ONLY raw SQL. No markdown, no explanation, no code fences. Limit to 100 rows.`;

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

                    // Execute the query
                    const connStr = connectionString || schema?.connectionString;

                    if (!connStr) {
                        throw new Error("No connection string available to execute query.");
                    }

                    send({ status: "executing", message: "Running query on database..." });

                    const result = await executeQuery(sql, connStr) as any;

                    if (result.error) {
                        // Try to repair the query once
                        send({ status: "repairing", message: `Query error: ${result.error}. Attempting repair...` });

                        const repairPrompt = `The following SQL query failed with an error. Fix the query.

Original SQL:
${sql}

Error:
${result.error}

Database schema:
${schemaLines.slice(0, 20).join("\n")}

Return ONLY the corrected SQL query, no explanation, no markdown. 
NOTE: If the error is "COALESCE types interval and integer cannot be matched", ensure \`COALESCE\` arguments match (e.g., cast timestamps to dates before subtraction or use EXTRACT).`;

                        const repairResponse = await model.invoke([
                            new SystemMessage("You are a SQL repair expert. Fix the broken SQL. Return ONLY the corrected SQL."),
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
                            send({
                                status: "completed",
                                data: retryResult.rows || retryResult.data || retryResult,
                                columns: retryResult.columns || (retryResult.rows?.[0] ? Object.keys(retryResult.rows[0]) : []),
                                rowCount: retryResult.rowCount || (retryResult.rows || retryResult.data || []).length,
                                sql: repairedSql,
                                repaired: true,
                                message: "Query completed successfully (after repair)"
                            });
                        }
                    } else {
                        const rows = result.rows || result.data || result;
                        const dataArr = Array.isArray(rows) ? rows : [];
                        
                        // Generate human-readable summary
                        send({ status: "analyzing", message: "Analyzing results..." });
                        
                        const summaryPrompt = `You are a helpful data analyst. Summarize these query results in a conversational, human-friendly way.

User Question: "${question}"

Query Results (${dataArr.length} rows):
${JSON.stringify(dataArr.slice(0, 10), null, 2)}

Columns: ${(result.columns || (dataArr[0] ? Object.keys(dataArr[0]) : [])).join(', ')}

Provide:
1. A brief, conversational answer (2-3 sentences)
2. 2-3 key insights or observations
3. Format numbers nicely (e.g., "1,234" instead of "1234", "$1.2M" for large numbers)
4. If dates are present, mention trends over time
5. If comparing data, highlight the most significant finding

Keep it friendly and easy to understand. Use bullet points for insights.

Response format:
ANSWER: [Your conversational answer]

KEY INSIGHTS:
• [Insight 1]
• [Insight 2]
• [Insight 3]`;

                        let humanReadableSummary = "";
                        try {
                            const summaryResponse = await model.invoke([
                                new SystemMessage("You are a friendly data analyst who explains results clearly."),
                                new HumanMessage(summaryPrompt)
                            ]);
                            humanReadableSummary = typeof summaryResponse.content === "string" 
                                ? summaryResponse.content 
                                : String(summaryResponse.content);
                        } catch (summaryErr) {
                            console.error("[CHAT_QA_API] Summary generation failed:", summaryErr);
                            humanReadableSummary = `Found ${dataArr.length} results for your query.`;
                        }
                        
                        send({
                            status: "completed",
                            data: dataArr,
                            columns: result.columns || (dataArr[0] ? Object.keys(dataArr[0]) : []),
                            rowCount: result.rowCount || dataArr.length,
                            sql,
                            humanReadableSummary,
                            message: `Query returned ${dataArr.length} rows`
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

import { NextRequest } from "next/server";
import { createDefaultChatModel } from "@/lib/llm/model";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { executeQuery } from "@/app/actions/mcp";

export const maxDuration = 600; // 10 minutes

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
                    send({ status: "started", message: "Preparing report..." });

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
                        if (info.primaryKeys?.length) {
                            line += ` | PK: ${info.primaryKeys.join(",")}`;
                        }
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

                    const isMssql = (connectorType || "").toLowerCase().includes("mssql") ||
                        (connectorInstructions || "").toLowerCase().includes("mssql") ||
                        (connectionString || "").toLowerCase().includes("mssql");

                    const dialect = isMssql ? "T-SQL (MS SQL Server)" : "PostgreSQL";

                    // Step 1: Generate multiple queries for the report
                    send({ status: "planning", message: "Planning report structure..." });

                    const planPrompt = `You are a data analyst. Plan 2-5 ${dialect} SQL queries for a report answering: "${question}"

SCHEMA:
${schemaLines.join("\n")}
${connectorInstructions ? `\nNOTES: ${connectorInstructions}` : ""}

Return a JSON array: [{"id":"section_1","title":"...","description":"...","sql":"SELECT ..."}]
Include summary/aggregate AND detail queries. Limit each to 50 rows. Return ONLY valid JSON.`;

                    const model = await createDefaultChatModel();
                    const planResponse = await model.invoke([
                        new SystemMessage("You are an expert data analyst. Return ONLY valid JSON arrays. No markdown, no explanation."),
                        new HumanMessage(planPrompt)
                    ]);

                    let planText = typeof planResponse.content === "string"
                        ? planResponse.content
                        : String(planResponse.content);

                    // Clean up
                    planText = planText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

                    let sections: Array<{ id: string; title: string; description: string; sql: string }> = [];
                    try {
                        sections = JSON.parse(planText);
                        if (!Array.isArray(sections)) throw new Error("Not an array");
                    } catch {
                        // Try to extract JSON array from the response
                        const match = planText.match(/\[[\s\S]*\]/);
                        if (match) {
                            try {
                                sections = JSON.parse(match[0]);
                            } catch {
                                // Fallback: single query
                                sections = [{
                                    id: "section_1",
                                    title: "Query Results",
                                    description: question,
                                    sql: planText
                                }];
                            }
                        } else {
                            sections = [{
                                id: "section_1",
                                title: "Query Results",
                                description: question,
                                sql: planText
                            }];
                        }
                    }

                    send({
                        status: "plan_ready",
                        sections: sections.map(s => ({ id: s.id, title: s.title, description: s.description })),
                        message: `Report plan: ${sections.length} sections`
                    });

                    // Step 2: Execute each query
                    const connStr = connectionString || schema?.connectionString;

                    if (!connStr) {
                        throw new Error("No connection string available to execute queries.");
                    }

                    const reportSections: Array<{
                        id: string;
                        title: string;
                        description: string;
                        sql: string;
                        data: any[];
                        columns: string[];
                        rowCount: number;
                        error?: string;
                    }> = [];

                    for (let i = 0; i < sections.length; i++) {
                        const section = sections[i];
                        send({
                            status: "executing_section",
                            sectionId: section.id,
                            sectionIndex: i,
                            total: sections.length,
                            message: `Executing: ${section.title}`
                        });

                        try {
                            let sql = section.sql?.replace(/```sql\s*/gi, "").replace(/```\s*/g, "").trim();
                            if (!sql) {
                                reportSections.push({
                                    ...section,
                                    data: [],
                                    columns: [],
                                    rowCount: 0,
                                    error: "No SQL generated for this section"
                                });
                                continue;
                            }

                            const result = await executeQuery(sql, connStr) as any;

                            if (result.error) {
                                // Try repair
                                const repairResponse = await model.invoke([
                                    new SystemMessage(`Fix this ${dialect} SQL query. Return ONLY the corrected SQL.`),
                                    new HumanMessage(`SQL: ${sql}\nError: ${result.error}\nSchema: ${schemaLines.slice(0, 15).join("\n")}`)
                                ]);
                                let repairedSql = typeof repairResponse.content === "string"
                                    ? repairResponse.content
                                    : String(repairResponse.content);
                                repairedSql = repairedSql.replace(/```sql\s*/gi, "").replace(/```\s*/g, "").trim();

                                const retryResult = await executeQuery(repairedSql, connStr) as any;
                                if (retryResult.error) {
                                    reportSections.push({
                                        ...section,
                                        sql: repairedSql,
                                        data: [],
                                        columns: [],
                                        rowCount: 0,
                                        error: retryResult.error
                                    });
                                } else {
                                    const rows = retryResult.rows || retryResult.data || retryResult;
                                    const dataArr = Array.isArray(rows) ? rows : [];
                                    reportSections.push({
                                        ...section,
                                        sql: repairedSql,
                                        data: dataArr,
                                        columns: retryResult.columns || (dataArr[0] ? Object.keys(dataArr[0]) : []),
                                        rowCount: dataArr.length
                                    });
                                }
                            } else {
                                const rows = result.rows || result.data || result;
                                const dataArr = Array.isArray(rows) ? rows : [];
                                reportSections.push({
                                    ...section,
                                    data: dataArr,
                                    columns: result.columns || (dataArr[0] ? Object.keys(dataArr[0]) : []),
                                    rowCount: dataArr.length
                                });
                            }

                            send({
                                status: "section_complete",
                                sectionId: section.id,
                                sectionIndex: i,
                                rowCount: reportSections[reportSections.length - 1].rowCount,
                                hasError: !!reportSections[reportSections.length - 1].error,
                                message: `${section.title}: ${reportSections[reportSections.length - 1].rowCount} rows`
                            });
                        } catch (err: any) {
                            reportSections.push({
                                ...section,
                                data: [],
                                columns: [],
                                rowCount: 0,
                                error: err.message || "Execution failed"
                            });
                        }
                    }

                    // Step 3: Generate narrative/insights
                    send({ status: "generating_narrative", message: "Generating report narrative..." });

                    const dataContext = reportSections
                        .filter(s => s.data.length > 0)
                        .map(s => {
                            const sampleJson = JSON.stringify(s.data.slice(0, 2));
                            const truncated = sampleJson.length > 500 ? sampleJson.slice(0, 500) + "..." : sampleJson;
                            return `${s.title} (${s.rowCount} rows): ${truncated}`;
                        }).join("\n");

                    const narrativePrompt = `Analyze these query results and write a report for: "${question}"

DATA:
${dataContext}

Return JSON: {"title":"...","summary":"2-3 sentence executive summary","insights":["insight1","insight2",...],"recommendation":"next steps"}
Return ONLY valid JSON.`;

                    let narrative = { title: question, summary: "", insights: [] as string[], recommendation: "" };
                    try {
                        const narrativeResponse = await model.invoke([
                            new SystemMessage("You are a business analyst. Return ONLY valid JSON."),
                            new HumanMessage(narrativePrompt)
                        ]);
                        let narrativeText = typeof narrativeResponse.content === "string"
                            ? narrativeResponse.content
                            : String(narrativeResponse.content);
                        narrativeText = narrativeText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
                        narrative = JSON.parse(narrativeText);
                    } catch {
                        narrative = {
                            title: question,
                            summary: "Report generated from data analysis.",
                            insights: reportSections.map(s => `${s.title}: ${s.rowCount} records found`),
                            recommendation: "Review the detailed data sections below for more information."
                        };
                    }

                    send({
                        status: "completed",
                        report: {
                            ...narrative,
                            sections: reportSections,
                            generatedAt: new Date().toISOString(),
                            question
                        },
                        message: "Report generated successfully"
                    });
                } catch (err: any) {
                    console.error("[REPORT_API] Error:", err);
                    send({
                        status: "error",
                        message: err.message || "Report generation failed"
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
        console.error("[REPORT_API] Outer error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}

import { NextRequest } from "next/server";
import { createDefaultChatModel } from "@/lib/llm/model";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { executeQuery } from "@/app/actions/mcp";
import { getCurrentDateTimeContext } from "@/lib/agents/planner/current-datetime-tool";

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
                    const dateNote = `TODAY: ${dateCtx.todayDate} (${dateCtx.currentTimeZone})`;

                    // Build ENABLED filter columns (whitelist) from filterableColumns
                    const enabledFilterCols: Record<string, string[]> = schema.filterableColumns || {};
                    const enabledLines = Object.entries(enabledFilterCols)
                        .filter(([, cols]) => Array.isArray(cols) && cols.length > 0)
                        .map(([table, cols]) => `  ${table}: ${cols.join(", ")}`);
                    const filterWhitelistBlock = enabledLines.length > 0
                        ? `\nALLOWED FILTER COLUMNS — ONLY these columns may appear in WHERE, HAVING, or JOIN ON across ALL sections:\n${enabledLines.join("\n")}\nAll other columns are SELECT-only. Never filter on any column not listed here.`
                        : "";

                    // Step 1: Plan report sections
                    send({ status: "planning", message: "Planning report structure..." });

                    const planPrompt = `You are a senior data analyst. Plan 3-5 ${dialect} SQL queries for a comprehensive report answering: "${question}"

${dateNote} — use this for all relative date references (today, this week, last month, this year, etc.)

SCHEMA (all visible columns for SELECT):
${schemaLines.join("\n")}
${connectorInstructions ? `\nNOTES: ${connectorInstructions}` : ""}${filterWhitelistBlock}

Design sections that together tell a complete story:
- Start with a high-level KPI/summary section (totals, counts, key metrics)
- Include trend or time-series sections when date columns exist using ALLOWED FILTER COLUMNS date fields
- Add breakdown/segmentation sections (by category, region, status, etc.) using ALLOWED FILTER COLUMNS
- End with a detail/top-N section for drill-down

CRITICAL — FILTER VALUES:
- If the question mentions ANY specific value (name, status, country, category, ID, amount, date range, etc.), EVERY section's SQL MUST include it as a hardcoded WHERE clause literal.
- NEVER use placeholders like ?, :param, $1, or {{value}}. Embed values directly: WHERE country = 'Germany', WHERE status = 'active', WHERE amount > 1000.
- Use ILIKE or LOWER() for case-insensitive text matching.
- Do NOT drop filter conditions — all sections must respect the same filters from the question.
- WHERE COLUMNS: You may ONLY use ALLOWED FILTER COLUMNS in WHERE/HAVING. If a date filter is needed, use the closest enabled date column (e.g. created_at, updated_at).

Return a JSON array:
[
  {"id":"section_1","title":"Executive KPIs","description":"Key headline metrics","sql":"SELECT ..."},
  {"id":"section_2","title":"Trend Over Time","description":"Month-by-month breakdown","sql":"SELECT ..."}
]
Limit each query to 50 rows. Return ONLY valid JSON. No markdown.`;

                    const model = await createDefaultChatModel();
                    const planResponse = await model.invoke([
                        new SystemMessage("You are an expert data analyst. Return ONLY valid JSON arrays. No markdown, no explanation."),
                        new HumanMessage(planPrompt)
                    ]);

                    let planText = typeof planResponse.content === "string"
                        ? planResponse.content
                        : String(planResponse.content);

                    planText = planText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

                    let sections: Array<{ id: string; title: string; description: string; sql: string }> = [];
                    try {
                        sections = JSON.parse(planText);
                        if (!Array.isArray(sections)) throw new Error("Not an array");
                    } catch {
                        const match = planText.match(/\[[\s\S]*\]/);
                        if (match) {
                            try {
                                sections = JSON.parse(match[0]);
                            } catch {
                                sections = [{ id: "section_1", title: "Query Results", description: question, sql: planText }];
                            }
                        } else {
                            sections = [{ id: "section_1", title: "Query Results", description: question, sql: planText }];
                        }
                    }

                    send({
                        status: "plan_ready",
                        sections: sections.map(s => ({ id: s.id, title: s.title, description: s.description })),
                        message: `Report plan ready: ${sections.length} sections`
                    });

                    // Step 2: Execute each section query — prefer body-level connectionString (live selection) over schema.connectionString (may be stale)
                    const connStr = connectionString || schema?.connectionString;
                    if (!connStr) throw new Error("No connection string available to execute queries.");

                    const reportSections: Array<{
                        id: string;
                        title: string;
                        description: string;
                        sql: string;
                        data: any[];
                        columns: string[];
                        rowCount: number;
                        error?: string;
                        narrative?: string;
                    }> = [];

                    for (let i = 0; i < sections.length; i++) {
                        const section = sections[i];
                        send({
                            status: "executing_section",
                            sectionId: section.id,
                            sectionIndex: i,
                            total: sections.length,
                            message: `Running: ${section.title} (${i + 1}/${sections.length})`
                        });

                        try {
                            let sql = section.sql?.replace(/```sql\s*/gi, "").replace(/```\s*/g, "").trim();
                            if (!sql) {
                                reportSections.push({ ...section, data: [], columns: [], rowCount: 0, error: "No SQL generated" });
                                continue;
                            }

                            const result = await executeQuery(sql, connStr) as any;

                            if (result.error) {
                                // Auto-repair
                                const repairResponse = await model.invoke([
                                    new SystemMessage(`Fix this ${dialect} SQL query. Preserve all hardcoded filter values (names, statuses, countries, IDs, etc.) — do not replace them with placeholders. Return ONLY the corrected SQL. No markdown.`),
                                    new HumanMessage(`SQL: ${sql}\nError: ${result.error}\nSchema: ${schemaLines.slice(0, 15).join("\n")}\n${dateNote}\nOriginal question: ${question}`)
                                ]);
                                let repairedSql = typeof repairResponse.content === "string"
                                    ? repairResponse.content : String(repairResponse.content);
                                repairedSql = repairedSql.replace(/```sql\s*/gi, "").replace(/```\s*/g, "").trim();

                                const retryResult = await executeQuery(repairedSql, connStr) as any;
                                if (retryResult.error) {
                                    reportSections.push({ ...section, sql: repairedSql, data: [], columns: [], rowCount: 0, error: retryResult.error });
                                } else {
                                    const rows = retryResult.rows || retryResult.data || retryResult;
                                    const dataArr = Array.isArray(rows) ? rows : [];
                                    const cols = (retryResult.columns || (dataArr[0] ? Object.keys(dataArr[0]) : []))
                                        .filter((c: string) => c !== "__rowKey");
                                    reportSections.push({ ...section, sql: repairedSql, data: dataArr, columns: cols, rowCount: dataArr.length });
                                }
                            } else {
                                const rows = result.rows || result.data || result;
                                const dataArr = Array.isArray(rows) ? rows : [];
                                const cols = (result.columns || (dataArr[0] ? Object.keys(dataArr[0]) : []))
                                    .filter((c: string) => c !== "__rowKey");
                                reportSections.push({ ...section, data: dataArr, columns: cols, rowCount: dataArr.length });
                            }

                            const last = reportSections[reportSections.length - 1];
                            send({
                                status: "section_complete",
                                sectionId: section.id,
                                sectionIndex: i,
                                rowCount: last.rowCount,
                                hasError: !!last.error,
                                message: last.error
                                    ? `${section.title}: failed`
                                    : `${section.title}: ${last.rowCount.toLocaleString()} rows`
                            });
                        } catch (err: any) {
                            reportSections.push({ ...section, data: [], columns: [], rowCount: 0, error: err.message || "Execution failed" });
                        }
                    }

                    // Step 3: Generate smart narrative + per-section insights
                    send({ status: "generating_narrative", message: "Analyzing data and writing report..." });

                    const dataContext = reportSections
                        .filter(s => s.data.length > 0)
                        .map(s => {
                            const preview = s.data.slice(0, 5).map(row =>
                                s.columns.map(c => `${c}=${row[c] != null ? row[c] : "null"}`).join(", ")
                            ).join(" | ");
                            return `[${s.id}] ${s.title} (${s.rowCount} rows): ${preview}`;
                        }).join("\n");

                    const narrativePrompt = `You are a senior business analyst. Analyze the following report data and write an intelligent, data-driven analysis for: "${question}"

${dateNote}

SECTION DATA:
${dataContext}

Write a sharp, insightful analysis. Reference specific numbers, percentages, names, and dates from the data.

Return ONLY this JSON (no markdown):
{
  "title": "A specific, descriptive report title",
  "summary": "2-3 sentence executive summary that mentions the most important findings with actual numbers",
  "insights": [
    "Specific insight with a number or percentage from the data",
    "Trend or comparison insight",
    "Anomaly, opportunity, or risk observation",
    "Actionable finding"
  ],
  "recommendation": "1-2 concrete, specific next steps based on the data",
  "sectionInsights": {
    "section_id": "1-2 sentence interpretation of this section's data with specific numbers"
  }
}`;

                    let narrative = {
                        title: question,
                        summary: "",
                        insights: [] as string[],
                        recommendation: "",
                        sectionInsights: {} as Record<string, string>
                    };

                    try {
                        const narrativeResponse = await model.invoke([
                            new SystemMessage("You are a senior business analyst. Return ONLY valid JSON. No markdown, no extra text."),
                            new HumanMessage(narrativePrompt)
                        ]);
                        let narrativeText = typeof narrativeResponse.content === "string"
                            ? narrativeResponse.content : String(narrativeResponse.content);
                        narrativeText = narrativeText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
                        const parsed = JSON.parse(narrativeText);
                        narrative = {
                            title: parsed.title || question,
                            summary: parsed.summary || "",
                            insights: Array.isArray(parsed.insights) ? parsed.insights : [],
                            recommendation: parsed.recommendation || "",
                            sectionInsights: parsed.sectionInsights || {}
                        };
                    } catch {
                        narrative = {
                            title: question,
                            summary: `Report covers ${reportSections.filter(s => !s.error).length} data sections with ${reportSections.reduce((a, s) => a + s.rowCount, 0).toLocaleString()} total records.`,
                            insights: reportSections.filter(s => !s.error).map(s => `${s.title}: ${s.rowCount.toLocaleString()} records`),
                            recommendation: "Review each section below for detailed findings.",
                            sectionInsights: {}
                        };
                    }

                    // Attach per-section narratives
                    const sectionsWithNarrative = reportSections.map(s => ({
                        ...s,
                        narrative: narrative.sectionInsights[s.id] || ""
                    }));

                    send({
                        status: "completed",
                        report: {
                            title: narrative.title,
                            summary: narrative.summary,
                            insights: narrative.insights,
                            recommendation: narrative.recommendation,
                            sections: sectionsWithNarrative,
                            generatedAt: new Date().toISOString(),
                            question
                        },
                        message: "Report ready"
                    });
                } catch (err: any) {
                    console.error("[REPORT_API] Error:", err);
                    send({ status: "error", message: err.message || "Report generation failed" });
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

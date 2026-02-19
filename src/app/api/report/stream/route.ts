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
                        'report', 'analysis', 'show', 'get', 'find', 'what', 'how many', 'list', 'top', 'bottom'
                    ].map((k: string) => k.toLowerCase());
                    
                    const isRelatedToSchema = schemaKeywords.some((keyword: string) => 
                        questionLower.includes(keyword)
                    ) || questionLower.match(/\b(where|when|which|who|what|how many|show|get|find|list|report|analysis)\b/);

                    if (!isRelatedToSchema) {
                        send({
                            status: "error",
                            message: "I don't have context about that topic. I can only generate reports about your database schema. Please ask about your data, tables, or specific business metrics."
                        });
                        controller.close();
                        return;
                    }

                    const isMssql = (connectorType || "").toLowerCase().includes("mssql") ||
                        (connectorInstructions || "").toLowerCase().includes("mssql") ||
                        (connectionString || "").toLowerCase().includes("mssql");

                    const dialect = isMssql ? "T-SQL (MS SQL Server)" : "PostgreSQL";

                    // Step 1: Generate multiple queries for the report
                    send({ status: "planning", message: "Planning report structure..." });

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

                    const planPrompt = `You are a data analyst. Plan 2-5 ${dialect} SQL queries for a report answering: "${question}"

DATABASE TYPE: ${dialect}
TODAY'S DATE: ${todayFormatted} (${todayStr})
Use this date when processing relative date queries like "today", "this week", "last month", etc.

${helperFunctions}

SCHEMA:
${schemaLines.join("\n")}
${connectorInstructions ? `\nNOTES: ${connectorInstructions}` : ""}

Return a JSON array: [{"id":"section_1","title":"...","description":"...","sql":"SELECT ..."}]
Include summary/aggregate AND detail queries. Limit each to 50 rows. Return ONLY valid JSON.
NOTE: For PostgreSQL, avoid \`COALESCE(interval, 0)\`. Cast timestamps to date before subtraction or use \`EXTRACT(DAY FROM (A - B))::integer\`.`;

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
                                    new SystemMessage(`Fix this ${dialect} SQL query. Return ONLY the corrected SQL. 
NOTE: If the error is "COALESCE types interval and integer cannot be matched", ensure \`COALESCE\` arguments match (e.g., cast timestamps to dates before subtraction or use EXTRACT).`),
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

                    // Step 3: Advanced ML/AI Analysis
                    send({ status: "analyzing", message: "Performing advanced data analysis..." });

                    // Calculate statistical summaries for each section
                    const analysisResults = reportSections.map(section => {
                        if (section.data.length === 0) return null;
                        
                        const stats: any = {
                            rowCount: section.rowCount,
                            numericColumns: {},
                            dateRange: null,
                            categories: {}
                        };
                        
                        // Analyze first row to detect column types
                        const sampleRow = section.data[0];
                        section.columns.forEach(col => {
                            const values = section.data.map((row: any) => row[col]).filter(v => v !== null && v !== undefined);
                            
                            // Check if numeric
                            if (values.length > 0 && typeof values[0] === 'number') {
                                const nums = values as number[];
                                stats.numericColumns[col] = {
                                    min: Math.min(...nums),
                                    max: Math.max(...nums),
                                    avg: nums.reduce((a, b) => a + b, 0) / nums.length,
                                    sum: nums.reduce((a, b) => a + b, 0)
                                };
                            }
                            
                            // Check if date
                            if (values.length > 0 && !isNaN(Date.parse(values[0]))) {
                                const dates = values.map(v => new Date(v)).sort((a, b) => a.getTime() - b.getTime());
                                stats.dateRange = {
                                    earliest: dates[0].toISOString(),
                                    latest: dates[dates.length - 1].toISOString()
                                };
                            }
                            
                            // Check if categorical (low cardinality)
                            if (values.length > 0) {
                                const unique = [...new Set(values)];
                                if (unique.length <= 10 && unique.length > 1) {
                                    stats.categories[col] = unique.length;
                                }
                            }
                        });
                        
                        return {
                            title: section.title,
                            stats
                        };
                    }).filter(Boolean);

                    // Detect trends and anomalies
                    const trends: Array<{ section: string; metric: string; change: string; direction: string }> = [];
                    const anomalies: string[] = [];
                    
                    reportSections.forEach(section => {
                        if (section.data.length < 2) return;
                        
                        // Look for time-based trends
                        const dateCol = section.columns.find(col => {
                            const val = section.data[0]?.[col];
                            return val && !isNaN(Date.parse(val));
                        });
                        
                        if (dateCol) {
                            const sorted = [...section.data].sort((a: any, b: any) => 
                                new Date(a[dateCol]).getTime() - new Date(b[dateCol]).getTime()
                            );
                            
                            // Simple trend detection
                            const first = sorted[0];
                            const last = sorted[sorted.length - 1];
                            const numericCols = section.columns.filter(col => typeof first[col] === 'number');
                            
                            numericCols.forEach(col => {
                                const change = ((last[col] - first[col]) / Math.abs(first[col] || 1)) * 100;
                                if (Math.abs(change) > 10) {
                                    trends.push({
                                        section: section.title,
                                        metric: col,
                                        change: change.toFixed(1),
                                        direction: change > 0 ? 'increasing' : 'decreasing'
                                    });
                                }
                            });
                        }
                    });

                    send({ status: "generating_narrative", message: "Generating AI insights..." });

                    const dataContext = reportSections
                        .filter(s => s.data.length > 0)
                        .map((s, idx) => {
                            const analysis = analysisResults[idx];
                            const sampleJson = JSON.stringify(s.data.slice(0, 3));
                            const truncated = sampleJson.length > 400 ? sampleJson.slice(0, 400) + "..." : sampleJson;
                            return `${s.title} (${s.rowCount} rows)
Stats: ${JSON.stringify(analysis?.stats || {})}
Sample: ${truncated}`;
                        }).join("\n\n");

                    const trendsContext = trends.length > 0 
                        ? `\n\nDETECTED TRENDS:\n${trends.map(t => `- ${t.section} - ${t.metric}: ${t.change}% ${t.direction}`).join("\n")}`
                        : "";

                    const narrativePrompt = `You are an expert ML/AI Data Analyst. Analyze this data comprehensively for: "${question}"

${dataContext}
${trendsContext}

Provide a comprehensive analysis including:
1. Executive Summary (key findings in 2-3 sentences)
2. Statistical Insights (min, max, averages, totals where relevant)
3. Trends & Patterns (direction, magnitude, significance)
4. Anomalies & Outliers (anything unusual)
5. Correlations (relationships between variables)
6. Actionable Recommendations (specific next steps)
7. Risk Assessment (potential issues or concerns)

Return JSON:
{
  "title": "Descriptive report title",
  "summary": "Executive summary",
  "keyMetrics": [{"name": "", "value": "", "context": ""}],
  "insights": ["insight 1", "insight 2"],
  "trends": [{"description": "", "significance": "high/medium/low"}],
  "anomalies": ["anomaly 1"],
  "recommendations": ["action 1", "action 2"],
  "risks": ["risk 1"]
}

Return ONLY valid JSON. Be specific and data-driven in your analysis.`;

                    let narrative: {
                        title: string;
                        summary: string;
                        keyMetrics: Array<{ name: string; value: string; context: string }>;
                        insights: string[];
                        trends: any[];
                        anomalies: string[];
                        recommendations: string[];
                        risks: string[];
                    } = {
                        title: question,
                        summary: "",
                        keyMetrics: [],
                        insights: [],
                        trends: [],
                        anomalies: [],
                        recommendations: [],
                        risks: []
                    };

                    try {
                        const narrativeResponse = await model.invoke([
                            new SystemMessage("You are a senior data scientist and business analyst. Provide specific, actionable insights backed by data."),
                            new HumanMessage(narrativePrompt)
                        ]);
                        let narrativeText = typeof narrativeResponse.content === "string"
                            ? narrativeResponse.content
                            : String(narrativeResponse.content);
                        narrativeText = narrativeText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
                        
                        const parsed = JSON.parse(narrativeText);
                        narrative = {
                            title: parsed.title || question,
                            summary: parsed.summary || "Analysis completed.",
                            keyMetrics: parsed.keyMetrics || [],
                            insights: parsed.insights || [],
                            trends: parsed.trends || [],
                            anomalies: parsed.anomalies || [],
                            recommendations: parsed.recommendations || [],
                            risks: parsed.risks || []
                        };
                    } catch (err) {
                        console.error("[REPORT_API] Narrative parsing failed:", err);
                        narrative = {
                            title: question,
                            summary: `Analysis of ${reportSections.reduce((acc, s) => acc + s.rowCount, 0)} total records across ${reportSections.length} sections.`,
                            keyMetrics: reportSections.map(s => ({
                                name: s.title,
                                value: `${s.rowCount} rows`,
                                context: "Record count"
                            })),
                            insights: reportSections.map(s => `${s.title}: ${s.rowCount} records analyzed`),
                            trends: trends,
                            anomalies: [],
                            recommendations: ["Review detailed sections below for specific findings."],
                            risks: []
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

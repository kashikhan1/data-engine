import { NextRequest, NextResponse } from "next/server";
import { runQueryGenerator, runQueryExecutor, repairFailedQuery } from "@/lib/agents/nodes";

const extractInstructionRules = (instructions: string) => {
    const bans = new Set<string>();
    const requires = new Set<string>();
    if (!instructions) return { bans, requires };
    const normalized = instructions
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/[^\w\s().\[\]]+/g, " ")
        .toLowerCase();
    const banPatterns = [/(:?do not use|don't use|avoid|never use|no)\s+([a-z0-9_().\[\]]+)/gi];
    const requirePatterns = [/(:?must use|always use|required)\s+([a-z0-9_().\[\]]+)/gi];
    let match: RegExpExecArray | null;
    for (const pattern of banPatterns) {
        while ((match = pattern.exec(normalized)) !== null) {
            if (match?.[2]) bans.add(match[2].toLowerCase());
        }
    }
    for (const pattern of requirePatterns) {
        while ((match = pattern.exec(normalized)) !== null) {
            if (match?.[2]) requires.add(match[2].toLowerCase());
        }
    }
    if (normalized.includes("never use limit") || normalized.includes("do not use limit")) {
        bans.add("limit");
    }
    if (normalized.includes("never generate current_date") || normalized.includes("no current_date")) {
        bans.add("current_date");
    }
    if (normalized.includes("never generate date_trunc") || normalized.includes("no date_trunc")) {
        bans.add("date_trunc");
    }
    return { bans, requires };
};

const normalizeSqlForValidation = (sql: string) => {
    let text = String(sql || "");
    if (!text) return "";
    text = text.replace(/^\uFEFF/, "");
    text = text.replace(/```/g, "");
    text = text.replace(/^\s*sql\s*:/i, "");
    text = text.trimStart();
    while (text.startsWith("--") || text.startsWith("#") || text.startsWith("/*")) {
        if (text.startsWith("--") || text.startsWith("#")) {
            text = text.replace(/^(--|#)[^\n]*\n?/, "").trimStart();
            continue;
        }
        if (text.startsWith("/*")) {
            text = text.replace(/^\/\*[\s\S]*?\*\//, "").trimStart();
            continue;
        }
        break;
    }
    return text.trim();
};

const validateSql = (sql: string, connectionString?: string, connectorInstructions?: string) => {
    const trimmed = normalizeSqlForValidation(sql);
    if (!trimmed.toLowerCase().startsWith("select")) {
        return { ok: false, error: "Validation failed: SQL must start with SELECT." };
    }
    const blocked = ["drop", "delete", "truncate", "update", "insert", "alter"];
    if (blocked.some((kw) => trimmed.toLowerCase().includes(kw))) {
        return { ok: false, error: "Validation failed: unsafe SQL detected." };
    }
    const lower = String(connectionString || "").toLowerCase();
    const isMssql = lower.startsWith("mssql://") || lower.startsWith("sqlserver://") || lower.includes("server=") || lower.includes("data source=");
    if (isMssql && /\blimit\s+\d+/i.test(trimmed)) {
        return { ok: false, error: "Validation failed: MSSQL does not support LIMIT. Use TOP or OFFSET/FETCH." };
    }
    if (!isMssql && /\btop\s+\d+/i.test(trimmed)) {
        return { ok: false, error: "Validation failed: PostgreSQL does not support TOP. Use LIMIT." };
    }
    const { bans, requires } = extractInstructionRules(connectorInstructions || "");
    for (const banned of bans) {
        const pattern = new RegExp(`\\b${banned.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
        if (pattern.test(trimmed)) {
            return { ok: false, error: `Validation failed: SQL violates connector instruction (avoid "${banned}").` };
        }
    }
    for (const required of requires) {
        const pattern = new RegExp(`\\b${required.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
        if (!pattern.test(trimmed)) {
            return { ok: false, error: `Validation failed: SQL must include "${required}".` };
        }
    }
    return { ok: true };
};

const formatResultForWidget = (widget: any, result: any) => {
    const data = Array.isArray(result?.data) ? result.data : [];
    if (widget?.type === "kpi") {
        let value = 0;
        if (data.length > 0) {
            const row = data[0] || {};
            const firstNumeric = Object.values(row).find((v) => typeof v === "number");
            if (typeof firstNumeric === "number") value = firstNumeric;
        }
        return {
            ...result,
            data: [{ value }],
            columns: ["value"]
        };
    }
    return result;
};

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { plan, schema, filters, applyFilters, errorLog, connectorType, connectorInstructions, connectionString: bodyConnectionString } = body || {};

        if (!plan || !schema) {
            return new Response("Missing plan or schema", { status: 400 });
        }

        const rawConnectionString =
            schema?.connectionString || schema?.dbUrl || schema?.postgresUrl || schema?.mssqlUrl || "";
        const connectorLower = String(connectorType || "").toLowerCase();
        const connectionString =
            !rawConnectionString && connectorLower.includes("mssql")
                ? "mssql://"
                : !rawConnectionString && connectorLower.includes("postgres")
                    ? "postgresql://"
                    : rawConnectionString;
        const widgets = Array.isArray(plan.widgets) ? plan.widgets : [];
        const schemaForPrompt = {
            ...schema,
            connectorInstructions: connectorInstructions || schema?.connectorInstructions,
            connectorType: connectorType || schema?.connectorType,
            connectionString: schema?.connectionString || bodyConnectionString || connectionString || undefined
        };

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "started" })}\n\n`));

                    const tasks = widgets.map(async (widget: any) => {
                        const widgetId = widget.id;
                        const send = (payload: any) =>
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ widgetId, ...payload })}\n\n`));

                        send({ status: "sql_builder_running", widgetTitle: widget.title });
                        const singlePlan = { ...plan, widgets: [widget] };
                        const sqlMap = await runQueryGenerator(singlePlan, schemaForPrompt, filters || {}, errorLog || [], Boolean(applyFilters));
                        let sql = sqlMap[widgetId];
                        send({ status: "sql_builder_done", sql });

                        let attempt = 0;
                        let lastError = "";
                        let finalResult: any = null;

                        while (attempt < 3) {
                            attempt += 1;
                            send({ status: "sql_validator_running", attempt });
                            const validation = validateSql(sql, connectionString, connectorInstructions);
                            if (!validation.ok) {
                                lastError = validation.error || "Validation failed";
                                const repair = await repairFailedQuery({
                                    widgetId,
                                    widgetTitle: widget.title || widgetId,
                                    widgetType: widget.type || "unknown",
                                    widgetGoal: widget.goal,
                                    originalSql: sql,
                                    errorMessage: lastError,
                                    schema: schemaForPrompt,
                                    errorLog,
                                    connectionString
                                });
                                sql = repair.sql;
                                send({ status: "sql_validator_fixed", sql, explanation: repair.explanation, attempt });
                            } else {
                                send({ status: "sql_validator_done", attempt });
                            }

                            send({ status: "execution_running", sql, attempt });
                            const exec = await runQueryExecutor({ [widgetId]: sql }, connectionString || undefined, {
                                connectorInstructions: connectorInstructions || "",
                                connectorType: connectorType || ""
                            });
                            const result = exec[widgetId];
                            if (result?.status === "error") {
                                lastError = result.error || "Execution failed";
                                const repair = await repairFailedQuery({
                                    widgetId,
                                    widgetTitle: widget.title || widgetId,
                                    widgetType: widget.type || "unknown",
                                    widgetGoal: widget.goal,
                                    originalSql: sql,
                                    errorMessage: lastError,
                                    schema: schemaForPrompt,
                                    errorLog,
                                    connectionString
                                });
                                sql = repair.sql;
                                send({ status: "execution_retry", sql, explanation: repair.explanation, attempt });
                                continue;
                            }

                            finalResult = result;
                            break;
                        }

                        if (!finalResult) {
                            send({
                                status: "manual_required",
                                sql,
                                error: lastError || "Auto-repair failed after 3 attempts.",
                                attempt: 3
                            });
                            return;
                        }

                        send({ status: "execution_done", result: finalResult, sql });
                        const formatted = formatResultForWidget(widget, finalResult);
                        send({ status: "formatter_done", result: formatted, sql });
                    });

                    await Promise.all(tasks);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "completed" })}\n\n`));
                    controller.close();
                } catch (err: any) {
                    controller.enqueue(
                        encoder.encode(`data: ${JSON.stringify({ status: "error", message: err?.message || "Unknown error" })}\n\n`)
                    );
                    controller.close();
                }
            }
        });

        return new NextResponse(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive"
            }
        });
    } catch (error: any) {
        return NextResponse.json({ error: error?.message || "Failed to start widget pipeline" }, { status: 500 });
    }
}

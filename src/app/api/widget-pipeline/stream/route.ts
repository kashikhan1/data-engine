import { NextRequest, NextResponse } from "next/server";
import { runQueryGenerator, runQueryExecutor, repairFailedQuery, validateSqlWithInstructions } from "@/modules/sql/agent";
import { applyAgentTodoUpdates } from "@/lib/agents/todo-list-updater";
import { buildTodoSummary, normalizeTodoScopeId, type TodoItem, type TodoListState } from "@/lib/agents/todo-types";

const formatResultForWidget = (widget: any, result: any) => {
    const data = Array.isArray(result?.data) ? result.data : [];
    const type = String(widget?.type || "").toLowerCase();

    if (type === "kpi") {
        let value: number | string = 0;
        let label: string | undefined;
        if (data.length > 0) {
            const row = data[0] || {};
            const entries = Object.entries(row);
            // prefer first numeric value
            const numEntry = entries.find(([, v]) => typeof v === "number");
            if (numEntry) {
                value = numEntry[1] as number;
                label = String(numEntry[0]);
            } else if (entries.length > 0) {
                const [k, v] = entries[0];
                value = v as any;
                label = String(k);
            }
        }
        return { ...result, data: [{ value, label }], columns: ["value", "label"] };
    }

    // For charts: ensure there's at least an empty array so widgets don't crash
    if (["line", "bar", "area", "scatter", "pie", "donut", "funnel", "cohort", "map"].includes(type)) {
        return { ...result, data };
    }

    return result;
};

const parseFiniteNumber = (value: any) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const buildPaginationConfig = (filters: Record<string, any>, widgetId: string) => {
    const readNumeric = (keys: string[]) => {
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(filters || {}, key)) continue;
            const num = parseFiniteNumber(filters[key]);
            if (num !== null) return num;
        }
        return null;
    };

    const page = readNumeric([`__page:${widgetId}`, `storePage:${widgetId}`, `page:${widgetId}`, "storePage", "page"]);
    const pageSize = readNumeric([
        `__pageSize:${widgetId}`,
        `storeSize:${widgetId}`,
        `rowsOnPage:${widgetId}`,
        `size:${widgetId}`,
        `pageSize:${widgetId}`,
        `page_size:${widgetId}`,
        "storeSize",
        "rowsOnPage",
        "size",
        "pageSize",
        "page_size"
    ]);
    const offset = readNumeric([`__offset:${widgetId}`, `offset:${widgetId}`, "offset"]);
    const normalizedPage = page !== null && page >= 0 ? Math.floor(page) : 0;
    const normalizedPageSize = pageSize !== null && pageSize > 0 ? Math.min(100, Math.floor(pageSize)) : 25;
    const normalizedOffset = offset !== null && offset >= 0
        ? Math.floor(offset)
        : normalizedPage * normalizedPageSize;
    return {
        page: normalizedPage,
        pageSize: normalizedPageSize,
        offset: normalizedOffset,
        includeTotal: true
    };
};

/** Build runtime filter params from the filters object and schema filterableColumns.
 *  Accepts an optional widgetId to extract widget-scoped sort/search keys.
 *  This ensures only enabled columns are injected and merges plan defaults. */
const buildRuntimeParams = (
    planFilters: any[],
    activeFilters: Record<string, any>,
    filterableColumns: Record<string, string[]>,
    widgetId?: string
): Record<string, any> => {
    // Start with plan-level defaults (dimension -> value)
    const base: Record<string, any> = {};
    (planFilters || []).forEach((f: any) => {
        if (!f?.dimension) return;
        base[f.dimension] = f.value;
    });

    // Overlay active runtime filter values
    const merged: Record<string, any> = { ...base, ...(activeFilters || {}) };

    // If filterableColumns are defined, only keep filter params that match enabled columns
    const enabledKeys = new Set<string>();
    Object.entries(filterableColumns || {}).forEach(([table, cols]) => {
        (cols || []).forEach((col) => {
            enabledKeys.add(`${table}.${col}`);
            enabledKeys.add(col);
            // Also allow dot-suffixed variants for date range filters
            enabledKeys.add(`${table}.${col}.from`);
            enabledKeys.add(`${table}.${col}.to`);
        });
    });

    // Keep pagination + sort + search params always; filter params only if enabled
    const filtered: Record<string, any> = {};
    Object.entries(merged).forEach(([key, val]) => {
        const isPagination = key.startsWith("__page:") || key.startsWith("__pageSize:") ||
            key.startsWith("__offset:") || key === "page" || key === "size" ||
            key === "pageSize" || key === "page_size" || key === "storePage" ||
            key === "storeSize" || key === "rowsOnPage" || key === "offset" ||
            key.startsWith("page:") || key.startsWith("size:") || key.startsWith("pageSize:") ||
            key.startsWith("page_size:") || key.startsWith("storePage:") ||
            key.startsWith("storeSize:") || key.startsWith("rowsOnPage:") || key.startsWith("offset:");
        const isSortKey = key.startsWith("__sort_col:") || key.startsWith("__sort_dir:");
        const isSearchKey = key === "__search" || key.startsWith("__search") || key === "searchDimension";
        if (isPagination || isSortKey || isSearchKey || enabledKeys.size === 0 || enabledKeys.has(key)) {
            filtered[key] = val;
        }
    });

    // Extract widget-scoped sort keys and normalize to template token names
    if (widgetId) {
        const sortCol = merged[`__sort_col:${widgetId}`];
        const sortDir = merged[`__sort_dir:${widgetId}`];
        if (sortCol != null && String(sortCol).trim()) filtered["sort_col"] = String(sortCol).trim();
        if (sortDir != null) filtered["sort_dir"] = String(sortDir).toUpperCase() === "DESC" ? "DESC" : "ASC";
    }

    return filtered;
};

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const {
            plan, schema, filters, applyFilters, errorLog,
            connectorType, connectorInstructions,
            connectionString: bodyConnectionString,
            todoListState: incomingTodoListState,
            /** When true: generate + validate SQL only, skip execution. Used for HITL SQL review. */
            generateOnly = false,
            /** Pre-built SQL map (widgetId → sql). When provided, skips SQL generation and uses this SQL directly. */
            prebuiltSqlMap = {} as Record<string, string>,
        } = body || {};

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
            // bodyConnectionString is the live selection from the client; prefer it over
            // schema.connectionString which may be stale (old URL or wrong DB type).
            connectionString: bodyConnectionString || schema?.connectionString || connectionString || undefined
        };

        // Extract enabled filter columns from schema (source of truth, not from persisted plan)
        const filterableColumns: Record<string, string[]> = (schema?.filterableColumns && typeof schema.filterableColumns === "object")
            ? schema.filterableColumns
            : {};

        const encoder = new TextEncoder();
        const cloneTodoList = (state: TodoListState): TodoListState => ({
            runId: String(state?.runId || `sql_${Date.now()}`),
            items: Array.isArray(state?.items) ? state.items.map((item) => ({ ...item })) : [],
            summary: state?.summary || buildTodoSummary([]),
            agentUpdateLedger: Object.fromEntries(
                Object.entries(state?.agentUpdateLedger || {}).map(([k, v]) => [k, Array.isArray(v) ? [...v] : []])
            )
        });
        const makeTodoItem = (
            id: string,
            domain: TodoItem["domain"],
            scopeId: string,
            title: string,
            priority: TodoItem["priority"] = "medium",
            status: TodoItem["status"] = "pending",
            ownerAgent?: string
        ): TodoItem => {
            const ts = new Date().toISOString();
            return {
                id,
                domain,
                scopeId: normalizeTodoScopeId(scopeId),
                title,
                status,
                priority,
                ownerAgent,
                source: "rule",
                createdAt: ts,
                updatedAt: ts,
            };
        };
        const ensureTodoItem = (state: TodoListState, item: TodoItem) => {
            const idx = state.items.findIndex((x) => x.id === item.id);
            if (idx === -1) state.items.push(item);
        };
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    let todoListState: TodoListState = incomingTodoListState
                        ? cloneTodoList(incomingTodoListState)
                        : {
                            runId: `sql_${Date.now()}`,
                            items: [],
                            summary: buildTodoSummary([]),
                            agentUpdateLedger: {},
                        };
                    ensureTodoItem(
                        todoListState,
                        makeTodoItem("todo:agent:sql engineer", "agent", "SQL Engineer", "Run SQL Engineer", "medium", "pending", "SQL Engineer")
                    );
                    for (let i = 0; i < widgets.length; i += 1) {
                        const widget = widgets[i];
                        const widgetId = String(widget?.id || `w${i + 1}`);
                        const title = String(widget?.title || widgetId);
                        ensureTodoItem(
                            todoListState,
                            makeTodoItem(`todo:sql:${normalizeTodoScopeId(widgetId)}`, "sql", widgetId, `Build SQL for ${title}`, "medium", "pending", "SQL Engineer")
                        );
                    }
                    todoListState.summary = buildTodoSummary(todoListState.items);

                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "started" })}\n\n`));
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "todo_sql_started", todoList: todoListState })}\n\n`));

                    const tasks = widgets.map(async (widget: any, index: number) => {
                        const widgetId = String(widget?.id || `w${index + 1}`);
                        const widgetType = String(widget?.type || "unknown").toLowerCase();
                        const widgetWithId = { ...widget, id: widgetId };
                        const isTableWidget = widgetType === "table";
                        const send = (payload: any) =>
                            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ widgetId, ...payload })}\n\n`));

                        send({ status: "sql_builder_running", widgetTitle: widgetWithId.title, widgetType });

                        // HITL: If caller provided pre-built SQL for this widget, skip generation
                        let sql: string;
                        if (prebuiltSqlMap && Object.prototype.hasOwnProperty.call(prebuiltSqlMap, widgetId)) {
                            sql = String(prebuiltSqlMap[widgetId] || "SELECT 1 AS value;");
                            send({ status: "sql_generation_path", path: "prebuilt" });
                        } else {
                            const singlePlan = { ...plan, widgets: [widgetWithId] };
                            const generationPathByWidget: Record<string, string> = {};
                            const sqlMap = await runQueryGenerator(
                                singlePlan,
                                schemaForPrompt,
                                filters || {},
                                errorLog || [],
                                Boolean(applyFilters),
                                (id, _sql, _index, _total, path) => {
                                    if (!id) return;
                                    generationPathByWidget[id] = String(path || "full");
                                }
                            );
                            sql = sqlMap[widgetId] || "SELECT 1 AS value;";
                            send({ status: "sql_generation_path", path: generationPathByWidget[widgetId] || "full" });
                        }
                        send({ status: "sql_builder_done", sql });

                        // Build runtime params using schema filterableColumns as the source of truth
                        // Pass widgetId so widget-scoped sort_col/sort_dir keys are normalized
                        const runtimeParams = buildRuntimeParams(
                            plan?.filters || [],
                            filters || {},
                            filterableColumns,
                            widgetId
                        );

                        // Pagination only for table widgets; charts/KPIs use full SQL
                        const pagination = isTableWidget ? buildPaginationConfig(filters || {}, widgetId) : undefined;

                        let attempt = 0;
                        let lastError = "";
                        let finalResult: any = null;

                        while (attempt < 3) {
                            attempt += 1;
                            send({ status: "sql_validator_running", attempt });
                            const validation = validateSqlWithInstructions(sql, connectionString, connectorInstructions, connectorType);
                            if (!validation.ok) {
                                lastError = validation.error || "Validation failed";
                                send({ status: "sql_validator_error", error: lastError, attempt });
                                const repair = await repairFailedQuery({
                                    widgetId,
                                    widgetTitle: widgetWithId.title || widgetId,
                                    widgetType: widgetWithId.type || "unknown",
                                    widgetGoal: widgetWithId.goal,
                                    widgetUses: widgetWithId.uses,
                                    widgetNotes: widgetWithId.notes,
                                    primaryTable: widgetWithId.primaryTable,
                                    filterableColumns,
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

                            // HITL: generateOnly — stop here, let user review SQL before execution
                            if (generateOnly) {
                                send({ status: "sql_review_ready", sql });
                                return; // skip execution for this widget
                            }

                            send({ status: "execution_running", sql, attempt });
                            const exec = await runQueryExecutor(
                                { [widgetId]: sql },
                                connectionString || undefined,
                                {
                                    connectorInstructions: connectorInstructions || "",
                                    connectorType: connectorType || "",
                                    widgetTypes: { [widgetId]: widgetType },
                                    ...(pagination ? { tablePagination: { [widgetId]: pagination } } : {}),
                                    runtimeParams
                                }
                            );
                            const result = exec[widgetId];
                            if (result?.status === "error") {
                                lastError = result.error || "Execution failed";
                                send({ status: "execution_error", error: lastError, sql, attempt });
                                const repair = await repairFailedQuery({
                                    widgetId,
                                    widgetTitle: widgetWithId.title || widgetId,
                                    widgetType: widgetWithId.type || "unknown",
                                    widgetGoal: widgetWithId.goal,
                                    widgetUses: widgetWithId.uses,
                                    widgetNotes: widgetWithId.notes,
                                    primaryTable: widgetWithId.primaryTable,
                                    filterableColumns,
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
                            todoListState = applyAgentTodoUpdates(todoListState, `SQL Engineer:${widgetId}:final`, [
                                {
                                    todoId: `todo:sql:${normalizeTodoScopeId(widgetId)}`,
                                    status: "failed",
                                    ownerAgent: "SQL Engineer",
                                    reason: lastError || "SQL generation and auto-repair failed.",
                                    suggestedFix: "Inspect generated SQL and repair join/filter logic for this widget."
                                }
                            ]);
                            const failedItem = todoListState.items.find((x) => x.id === `todo:sql:${normalizeTodoScopeId(widgetId)}`);
                            if (failedItem) {
                                send({ status: "todo_sql_widget_update", item: failedItem });
                            }
                            send({
                                status: "manual_required",
                                sql,
                                error: lastError || "Auto-repair failed after 3 attempts.",
                                attempt: 3
                            });
                            return;
                        }

                        todoListState = applyAgentTodoUpdates(todoListState, `SQL Engineer:${widgetId}:final`, [
                            {
                                todoId: `todo:sql:${normalizeTodoScopeId(widgetId)}`,
                                status: "done",
                                ownerAgent: "SQL Engineer",
                                reason: "SQL generated, validated, and executed successfully."
                            }
                        ]);
                        const doneItem = todoListState.items.find((x) => x.id === `todo:sql:${normalizeTodoScopeId(widgetId)}`);
                        if (doneItem) {
                            send({ status: "todo_sql_widget_update", item: doneItem });
                        }

                        const rowCount = Array.isArray(finalResult?.data) ? finalResult.data.length : 0;
                        send({
                            status: "execution_done",
                            result: finalResult,
                            sql,
                            rowCount,
                            totalRows: finalResult?.totalRows ?? null,
                            executionTime: finalResult?.executionTime || null,
                            page: finalResult?.page ?? null,
                            pageSize: finalResult?.pageSize ?? null
                        });
                        const formatted = formatResultForWidget(widgetWithId, finalResult);
                        send({ status: "formatter_done", result: formatted, sql, rowCount });
                    });

                    await Promise.all(tasks);
                    const hasSqlFailures = todoListState.items.some((item) =>
                        item.domain === "sql" && (item.status === "failed" || item.status === "blocked")
                    );
                    todoListState = applyAgentTodoUpdates(todoListState, "SQL Engineer", [
                        {
                            todoId: "todo:agent:sql engineer",
                            status: hasSqlFailures ? "blocked" : "done",
                            ownerAgent: "SQL Engineer",
                            reason: hasSqlFailures
                                ? "One or more widget SQL tasks failed and need manual repair."
                                : "Processed SQL generation for all widgets."
                        }
                    ]);
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify({ status: "todo_sql_summary", summary: todoListState.summary })}\n\n`));
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

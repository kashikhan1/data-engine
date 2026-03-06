/* eslint-disable @typescript-eslint/no-explicit-any */
'use server';

import { AgentState } from "./state";
import { AIMessage } from "@langchain/core/messages";
import { dbGateway } from "../mcp/server";
import {
    isPlaceholderSqlQuery,
    renderDynamicSqlTemplate,
    applyRuntimePaginationToSql,
    resolveTablePaginationForId,
    derivePaginationFromRuntimeParams,
    repairFailedQuery as repairFailedQueryImpl,
} from "./query-runtime";
import {
    resolveConnectorContextFromSchema,
    validateSqlAgainstConnectorSkill,
} from "./connector-policy";

export async function securityCheckAgent(state: typeof AgentState.State) {
    const sqlMap = state.queryValidation;
    const blocked = ["DROP", "DELETE", "TRUNCATE", "UPDATE", "INSERT", "GRANT", "REVOKE", "ALTER"];

    for (const [id, sql] of Object.entries(sqlMap)) {
        if (blocked.some(b => (sql as string).toUpperCase().includes(b))) {
            return { errors: [`Security Breach in ${id}: Non - read query detected.`], messages: [new AIMessage(`[SECURITY] Blocked dangerous query in component ${id}.`)] };
        }
    }

    return {
        securityClearance: { approved: true },
        status: "Security cleared.",
        messages: [new AIMessage(`[SECURITY] All queries approved for read - only execution.`)]
    };
}

export async function* mcpCallingAgentStream(state: typeof AgentState.State) {
    if (!state.securityClearance?.approved) {
        yield { type: "error", message: "Execution blocked: Security clearance not granted." };
        return;
    }

    const sqlMap = state.queryValidation;
    const connector = resolveConnectorContextFromSchema(
        { ...(state.schema || {}), ...(state.context || {}) },
        {
            connectionString:
                state.context?.connectionString ||
                state.context?.dbUrl ||
                state.schema?.connectionString ||
                state.schema?.dbUrl,
            connectorType: (state.schema as any)?.connectorType || (state.context as any)?.connectorType,
            connectorInstructions: (state.schema as any)?.connectorInstructions || (state.context as any)?.connectorInstructions
        }
    );
    const connectionString = connector.connectionString || undefined;
    const connectorInstructions = connector.connectorInstructions;
    const connectorType = connector.connectorType;
    const totalQueries = Object.keys(sqlMap).length;
    let completedQueries = 0;

    yield { type: "progress", stage: "starting", message: `Preparing to execute ${totalQueries} queries...` };

    const results: any[] = [];

    for (const [id, sql] of Object.entries(sqlMap)) {
        const wInfo = state.queryPlan?.widgets?.find((w: any) => w.id === id);

        try {
            yield {
                type: "query_progress",
                widgetId: id,
                widgetTitle: wInfo?.title || "Metric",
                stage: "executing",
                message: `Executing query for ${wInfo?.title || id}...`,
                sql: sql
            };

            let currentSql = sql as string;
            let validation = await validateSqlAgainstConnectorSkill(
                currentSql,
                connectionString,
                connectorInstructions,
                connectorType,
                state.schema,
                wInfo
            );
            let attempts = 0;
            while (!validation.ok && attempts < 2) {
                attempts += 1;
                try {
                    const repair = await repairFailedQueryImpl({
                        widgetId: id,
                        widgetTitle: wInfo?.title || "Metric",
                        widgetType: wInfo?.type || "table",
                        widgetGoal: (wInfo as any)?.goal,
                        originalSql: currentSql,
                        errorMessage: validation.error || "Connector instruction violation",
                        schema: { ...(state.schema || {}), connectorInstructions, connectorType },
                        errorLog: [],
                        connectionString
                    });
                    if (repair?.sql) {
                        currentSql = repair.sql;
                    }
                } catch {
                    break;
                }
                validation = await validateSqlAgainstConnectorSkill(
                    currentSql,
                    connectionString,
                    connectorInstructions,
                    connectorType,
                    state.schema,
                    wInfo
                );
            }
            if (!validation.ok) {
                yield {
                    type: "query_error",
                    widgetId: id,
                    widgetTitle: wInfo?.title || "Metric",
                    error: validation.error,
                    message: `SQL violates connector rules: ${validation.error}`,
                    sql: currentSql
                };
                completedQueries++;
                continue;
            }

            console.log(`[EXECUTOR] Running widget ${id}...`);
            const isMssqlExec = connector.isMssql;
            const templatedSql = renderDynamicSqlTemplate(currentSql, (state.context as any)?.runtimeParams || {}, isMssqlExec);
            const contextTablePagination = ((state.context as any)?.tablePagination || undefined) as Record<string, { page: number; pageSize: number; offset?: number; includeTotal?: boolean }> | undefined;
            const resolvedTablePage = resolveTablePaginationForId(id, currentSql, contextTablePagination);
            const sqlTokenMatch = String(currentSql || "").match(/\{\{\s*(?:size|offset|page|pageSize|page_size|rowsOnPage|storeSize|storePage)\s*:\s*([^}\s]+)\s*\}\}/i);
            const sqlTargetId = sqlTokenMatch?.[1]?.trim();
            const isTableWidget = String((wInfo as any)?.type || "").toLowerCase() === "table";
            const runtimeDerivedPage = isTableWidget
                ? (resolvedTablePage
                    || derivePaginationFromRuntimeParams(id, (state.context as any)?.runtimeParams || {}, sqlTargetId)
                    || { page: 0, pageSize: 25, offset: 0, includeTotal: true })
                : undefined;
            const shouldApplyRuntimePaging = Boolean(runtimeDerivedPage) && isTableWidget;
            const runtimeSql = shouldApplyRuntimePaging && runtimeDerivedPage
                ? applyRuntimePaginationToSql(templatedSql, runtimeDerivedPage.page, runtimeDerivedPage.pageSize, runtimeDerivedPage.offset, isMssqlExec)
                : templatedSql;
            if (isPlaceholderSqlQuery(runtimeSql)) {
                yield {
                    type: "query_error",
                    widgetId: id,
                    widgetTitle: wInfo?.title || "Metric",
                    error: "SQL generation produced placeholder SQL. Regenerate plan/SQL.",
                    message: `Placeholder SQL detected for ${wInfo?.title || id}`,
                    sql: runtimeSql
                };
                completedQueries++;
                continue;
            }
            const data = await dbGateway.runQuery(runtimeSql, connectionString);

            const result = {
                widgetId: id,
                widgetTitle: wInfo?.title || "Metric",
                type: wInfo?.type || "table",
                goal: (wInfo as any)?.goal,
                plan_metric: (wInfo as any)?.metric,
                plan_dim: (wInfo as any)?.dim,
                data: Array.isArray(data) && !(data as any).error ? data : [],
                columns: (Array.isArray(data) && data.length > 0 && !(data as any).error) ? Object.keys(data[0]) : [],
                sql: runtimeSql,
                error: (data as any)?.error || null
            };

            results.push(result);
            completedQueries++;

            yield {
                type: "query_complete",
                widgetId: id,
                widgetTitle: wInfo?.title || "Metric",
                result: result,
                completed: completedQueries,
                total: totalQueries,
                message: `Completed ${wInfo?.title || id} (${completedQueries}/${totalQueries})`,
                sql: runtimeSql
            };

        } catch (err: any) {
            completedQueries++;

            const errorResult = {
                widgetId: id,
                widgetTitle: wInfo?.title || "Metric",
                type: wInfo?.type || "table",
                error: err.message,
                data: [],
                columns: [],
                sql: sql
            };

            results.push(errorResult);

            yield {
                type: "query_error",
                widgetId: id,
                widgetTitle: wInfo?.title || "Metric",
                error: err.message,
                completed: completedQueries,
                total: totalQueries,
                message: `Error in ${wInfo?.title || id}: ${err.message}`
            };
        }
    }

    const criticalError = results.find(r => r.error && (r.error.includes("Not connected") || r.error.includes("Connection failed")));
    if (criticalError) {
        yield {
            type: "error",
            message: `Database connection failure: could not connect using the configured ${connector.dialect || "database"} connector. Please verify connection settings.`,
            results: results
        };
        return;
    }

    const successCount = results.filter(r => !r.error).length;

    yield {
        type: "complete",
        results: results,
        successCount,
        totalCount: totalQueries,
        message: `Query execution complete: ${successCount}/${totalQueries} successful`
    };
}

export async function mcpCallingAgent(state: typeof AgentState.State) {
    if (!state.securityClearance?.approved) {
        return { errors: ["Execution blocked: Security clearance not granted."], status: "Security block." };
    }
    const sqlMap = state.queryValidation;
    const connector = resolveConnectorContextFromSchema(
        { ...(state.schema || {}), ...(state.context || {}) },
        {
            connectionString: state.context?.connectionString || state.context?.dbUrl || (state.schema as any)?.connectionString || (state.schema as any)?.dbUrl,
            connectorType: (state.schema as any)?.connectorType || (state.context as any)?.connectorType,
            connectorInstructions: (state.schema as any)?.connectorInstructions || (state.context as any)?.connectorInstructions
        }
    );
    const connectionString = connector.connectionString || undefined;

    const tasks = Object.entries(sqlMap).map(async ([id, sql]) => {
        try {
            console.log(`[EXECUTOR] Running widget ${id}...`);
            const isMssqlExec = connector.isMssql;
            const templatedSql = renderDynamicSqlTemplate(sql as string, (state.context as any)?.runtimeParams || {}, isMssqlExec);
            const wInfo = state.queryPlan?.widgets?.find((w: any) => w.id === id);
            const contextTablePagination = ((state.context as any)?.tablePagination || undefined) as Record<string, { page: number; pageSize: number; offset?: number; includeTotal?: boolean }> | undefined;
            const resolvedTablePage = resolveTablePaginationForId(id, sql as string, contextTablePagination);
            const sqlTokenMatch = String(sql || "").match(/\{\{\s*(?:size|offset|page|pageSize|page_size|rowsOnPage|storeSize|storePage)\s*:\s*([^}\s]+)\s*\}\}/i);
            const sqlTargetId = sqlTokenMatch?.[1]?.trim();
            const isTableWidget = String((wInfo as any)?.type || "").toLowerCase() === "table";
            const runtimeDerivedPage = isTableWidget
                ? (resolvedTablePage
                    || derivePaginationFromRuntimeParams(id, (state.context as any)?.runtimeParams || {}, sqlTargetId)
                    || { page: 0, pageSize: 10, offset: 0, includeTotal: true })
                : undefined;
            const shouldApplyRuntimePaging = Boolean(runtimeDerivedPage) && isTableWidget;
            const runtimeSql = shouldApplyRuntimePaging && runtimeDerivedPage
                ? applyRuntimePaginationToSql(templatedSql, runtimeDerivedPage.page, runtimeDerivedPage.pageSize, runtimeDerivedPage.offset, isMssqlExec)
                : templatedSql;
            if (isPlaceholderSqlQuery(runtimeSql)) {
                return {
                    widgetId: id,
                    widgetTitle: wInfo?.title || "Metric",
                    type: wInfo?.type || "table",
                    columns: [],
                    error: "SQL generation produced placeholder SQL. Regenerate plan/SQL.",
                    data: [],
                    sql: runtimeSql
                };
            }
            const data = await dbGateway.runQuery(runtimeSql, connectionString);

            if (data && (data as any).error) {
                return {
                    widgetId: id,
                    widgetTitle: wInfo?.title || "Metric",
                    type: wInfo?.type || "table",
                    columns: [],
                    error: (data as any).error,
                    data: [],
                    sql: runtimeSql
                };
            }

            const resolvedColumns = Array.isArray(data) && data.length > 0
                ? Object.keys(data[0] || {}).filter((key) => key !== "__rowKey")
                : [];
            return {
                widgetId: id,
                widgetTitle: wInfo?.title || "Metric",
                type: wInfo?.type || "table",
                goal: (wInfo as any)?.goal,
                plan_metric: (wInfo as any)?.metric,
                plan_dim: (wInfo as any)?.dim,
                data: Array.isArray(data) ? data : [],
                columns: resolvedColumns,
                sql: runtimeSql
            };
        } catch (err: any) {
            return {
                widgetId: id,
                widgetTitle: "Metric",
                type: "table",
                error: err.message,
                data: [],
                columns: []
            };
        }
    });

    const resolved = await Promise.all(tasks);

    const criticalError = resolved.find(r => r.error && (r.error.includes("Not connected") || r.error.includes("Connection failed")));
    if (criticalError) {
        return {
            errors: [`Database connection failure: could not connect using the configured ${connector.dialect || "database"} connector. Please verify connection settings.`],
            results: resolved,
            status: "Connection offline."
        };
    }

    return {
        results: resolved,
        status: `Retrieved ${resolved.length} result sets.`,
        messages: [new AIMessage(`[EXECUTOR] Parallel retrieval complete.Successfully fetched ${resolved.filter(r => !r.error).length}/${resolved.length} metrics.`)]
    };
}

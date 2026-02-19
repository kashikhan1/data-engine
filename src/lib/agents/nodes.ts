'use server';

import { AgentState } from "./state";
import { QueryPlanSchema } from "../schemas";
import { createDefaultChatModel } from "../llm/model";

import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { dbGateway } from "../mcp/server";
import { PLANNER_WIDGET_TYPE_ORDER } from "@/types/dashboard";
import { AGENT_ROLES, SQL_GENERATION_RULES } from "./prompts";
import { extractJSON, invokeModelWithRetry as invokeModelWithRetryUtil, streamModelWithRetry as streamModelWithRetryUtil } from "./llm-utils";
import { categorizeDataType, getColumnName, isTemporalType, isTextType } from "./data-type-utils";
import {
    runSchemaDiscovery as runSchemaDiscoveryImpl,
    schemaAgent as schemaAgentImpl,
    type SchemaDiscoveryOptions,
} from "./schema-discovery";
import {
    dashboardPlannerAgent as dashboardPlannerAgentImpl,
} from "./dashboard-planner-runtime";
import {
    normalizeSqlForValidation,
    stripSqlLiteralsAndComments,
    detectIsMssql,

    isPlaceholderSqlQuery,
    renderDynamicSqlTemplate,
    applyRuntimePaginationToSql,
    resolveTablePaginationForId,
    derivePaginationFromRuntimeParams,
    runQueryExecutor as runQueryExecutorImpl,
    repairFailedQuery as repairFailedQueryImpl,
    assembleFinalDashboard as assembleFinalDashboardImpl,
    runNarrativeGenerator as runNarrativeGeneratorImpl,
} from "./query-runtime";

// --- LLM Initialization ---

const getModel = () => {
    return createDefaultChatModel({ logPrefix: "[LLM]", timeoutMs: 900000 });
};

const invokeModelWithRetry = (messages: any[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetryUtil(getModel, messages, maxRetries, delay);

const streamModelWithRetry = (
    messages: any[],
    onToken?: (token: string) => void,
    maxRetries = 3,
    delay = 2000
) => streamModelWithRetryUtil(getModel, messages, onToken, maxRetries, delay);

export async function runQueryExecutor(
    queries: Record<string, string>,
    connectionString?: string,
    options?: {
        connectorInstructions?: string;
        connectorType?: string;
        tablePagination?: Record<string, { page: number; pageSize: number; offset?: number; includeTotal?: boolean }>;
        runtimeParams?: Record<string, any>;
    }
) {
    return runQueryExecutorImpl(queries, connectionString, options);
}

export async function repairFailedQuery(context: {
    widgetId: string;
    widgetTitle: string;
    widgetType: string;
    widgetGoal?: string;
    originalSql: string;
    errorMessage: string;
    schema: any;
    errorLog?: Array<{ id: string; title?: string; sql?: string; error: string; timestamp?: string }>;
    connectionString?: string;
}): Promise<{ sql: string; explanation: string }> {
    return repairFailedQueryImpl(context);
}

export async function assembleFinalDashboard(
    plan: any,
    queries: any[],
    results: any[],
    insights: string[] = [],
    filterCandidates?: any
) {
    return assembleFinalDashboardImpl(plan, queries, results, insights, filterCandidates);
}

export async function runNarrativeGenerator(resultsList: any[]) {
    return runNarrativeGeneratorImpl(resultsList);
}

async function refinePlannerOutput(input: {
    agentLabel: string;
    draft: string;
    formatSpec: string;
    onToken?: (token: string) => void;
}) {
    const { agentLabel, draft, formatSpec, onToken } = input;
    if (!draft || !draft.trim()) return draft;
    const systemPrompt = `You are a strict format editor for ${agentLabel}.

TASK:
- Fix formatting, missing fields, and clarity issues.
- Do NOT add new widgets or remove widgets.
- Keep the same intent, but ensure compliance with the format spec.
- Return ONLY the corrected output (no commentary).

FORMAT SPEC:
${formatSpec}`;

    const response = await streamModelWithRetry([
        new SystemMessage(systemPrompt),
        new HumanMessage(draft)
    ], onToken);

    return (response.content as string) || draft;
}

export type { SchemaDiscoveryOptions } from "./schema-discovery";

interface TableKpi {
    id: string;
    title: string;
    description: string;
    aggregation: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
    column?: string;
}

interface TableDataMatrix {
    rowCount?: number;
    columnCounts: {
        total: number;
        numeric: number;
        temporal: number;
        text: number;
        boolean: number;
        other: number;
    };
    categoricalCandidates: Array<{
        column: string;
        sampleDistinct: number;
        sampleValues: string[];
    }>;
    numericCandidates: Array<{
        column: string;
        type: string;
    }>;
}

interface TableFilterSuggestion {
    id: string;
    title: string;
    type: "date_range" | "multi_select" | "entity";
    column: string;
    table: string;
    sampleValues?: string[];
    targetTable?: string;
}

interface QueryExample {
    id: string;
    description: string;
    sql: string;
    results?: any[];
    executionTime?: number;
    error?: string;
}

interface TableInsight {
    semanticMatches?: {
        terms: string[];
        metrics: Array<{ slug: string; name: string; description?: string }>;
        dimensions: Array<{ slug: string; name: string; type?: string; table_name?: string }>;
    };
    kpis?: TableKpi[];
    dataMatrix?: TableDataMatrix;
    filters?: TableFilterSuggestion[];
    queryExamples?: QueryExample[];
}

function buildTableKpis(tableName: string, columns: any[], rowCount?: number): TableKpi[] {
    if (rowCount === 0) return [];
    const kpis: TableKpi[] = [];
    const titleBase = tableName.replace(/_/g, " ");

    kpis.push({
        id: `${tableName}_count`,
        title: `Total ${titleBase}`,
        description: "Row count for the table.",
        aggregation: "count",
        column: "*"
    });

    const primaryCol = columns.find((c) => c?.isPrimary || /_id$/i.test(getColumnName(c)));
    if (primaryCol) {
        kpis.push({
            id: `${tableName}_distinct_${getColumnName(primaryCol)}`,
            title: `Distinct ${getColumnName(primaryCol)}`,
            description: "Unique entity count.",
            aggregation: "distinct_count",
            column: getColumnName(primaryCol)
        });
    }

    const numericColumns = columns.filter((c) => c?.isNumeric);
    const priorityNumeric = numericColumns.find((c) =>
        /(amount|price|total|revenue|cost|value|balance|score)/i.test(getColumnName(c))
    ) || numericColumns[0];

    if (priorityNumeric) {
        const colName = getColumnName(priorityNumeric);
        kpis.push({
            id: `${tableName}_sum_${colName}`,
            title: `Sum of ${colName}`,
            description: "Aggregate sum for the primary numeric column.",
            aggregation: "sum",
            column: colName
        });
        kpis.push({
            id: `${tableName}_avg_${colName}`,
            title: `Average ${colName}`,
            description: "Average value for the primary numeric column.",
            aggregation: "avg",
            column: colName
        });
    }

    if (rowCount !== undefined) {
        kpis.push({
            id: `${tableName}_rows_profiled`,
            title: `${titleBase} rows profiled`,
            description: "Row count from schema profiling.",
            aggregation: "count",
            column: "*"
        });
    }

    return kpis.slice(0, 4);
}

function buildTableDataMatrix(tableSchema: any, sampleRows: any[], rowCount?: number): TableDataMatrix {
    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const columnCounts = {
        total: columns.length,
        numeric: 0,
        temporal: 0,
        text: 0,
        boolean: 0,
        other: 0
    };

    const categoricalCandidates: TableDataMatrix["categoricalCandidates"] = [];
    const numericCandidates: TableDataMatrix["numericCandidates"] = [];

    columns.forEach((col: any) => {
        const category = col.category || categorizeDataType(col.type || col.data_type || "");
        if (category === "numeric") columnCounts.numeric += 1;
        else if (category === "temporal") columnCounts.temporal += 1;
        else if (category === "text") columnCounts.text += 1;
        else if (category === "boolean") columnCounts.boolean += 1;
        else columnCounts.other += 1;

        if (category === "numeric") {
            numericCandidates.push({
                column: getColumnName(col),
                type: col.type || col.data_type || ""
            });
        }

        if (category === "text" && sampleRows?.length) {
            const values = sampleRows
                .map((row) => row?.[getColumnName(col)])
                .filter((val) => val !== null && val !== undefined)
                .map((val) => String(val));
            const distinct = Array.from(new Set(values));
            if (distinct.length > 0 && distinct.length <= 12) {
                categoricalCandidates.push({
                    column: getColumnName(col),
                    sampleDistinct: distinct.length,
                    sampleValues: distinct.slice(0, 6)
                });
            }
        }
    });

    return {
        rowCount,
        columnCounts,
        categoricalCandidates,
        numericCandidates
    };
}

function buildTableFilters(tableName: string, tableSchema: any, sampleRows: any[]): TableFilterSuggestion[] {
    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const filters: TableFilterSuggestion[] = [];

    columns.forEach((col: any) => {
        const colName = getColumnName(col);
        if (!colName) return;

        if (col.isTemporal || categorizeDataType(col.type || col.data_type || "") === "temporal") {
            filters.push({
                id: `${tableName}_${colName}_date`,
                title: `${colName} date range`,
                type: "date_range",
                column: colName,
                table: tableName
            });
        }

        if (col.isText || categorizeDataType(col.type || col.data_type || "") === "text") {
            const values = sampleRows
                .map((row) => row?.[colName])
                .filter((val) => val !== null && val !== undefined)
                .map((val) => String(val));
            const distinct = Array.from(new Set(values));
            if (distinct.length > 0 && distinct.length <= 12) {
                filters.push({
                    id: `${tableName}_${colName}_multi`,
                    title: `${colName} filter`,
                    type: "multi_select",
                    column: colName,
                    table: tableName,
                    sampleValues: distinct.slice(0, 6)
                });
            }
        }
    });

    const foreignKeys = Array.isArray(tableSchema?.foreignKeys) ? tableSchema.foreignKeys : [];
    foreignKeys.forEach((fk: any) => {
        if (!fk?.column_name || !fk?.foreign_table_name) return;
        filters.push({
            id: `${tableName}_${fk.column_name}_entity`,
            title: `${fk.foreign_table_name} filter`,
            type: "entity",
            column: fk.column_name,
            table: tableName,
            targetTable: fk.foreign_table_name
        });
    });

    return filters;
}

function computeVisibleColumns(tableSchema: any) {
    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const scored = columns.map((col: any) => {
        const name = String(getColumnName(col) || "").toLowerCase();
        let score = 0;
        if (col?.isPrimary) score += 3;
        if (col?.isTemporal) score += 2.5;
        if (col?.isNumeric) score += 2;
        if (col?.isText) score += 1.5;
        if (/(name|title|label|email|status|category|type|region|country)/i.test(name)) score += 3;
        if (/(amount|total|revenue|cost|price|value|qty|count|score)/i.test(name)) score += 2;
        if (/(json|metadata|payload|config|settings|blob|raw|token|secret)/i.test(name)) score -= 4;
        if (/^id$|_id$/.test(name)) score -= 0.5;
        return { name: getColumnName(col), score };
    });
    return scored
        .filter((c: { name: string; score: number }) => c.name)
        .sort((a: { name: string; score: number }, b: { name: string; score: number }) => b.score - a.score)
        .map((c: { name: string; score: number }) => c.name);
}

function computeFilterableColumnsFromInsights(insight: TableInsight | null) {
    if (!insight?.filters) return [];
    const cols = insight.filters
        .map((f) => f.column)
        .filter(Boolean);
    return Array.from(new Set(cols));
}

function buildFilterCandidatesFromColumns(
    schemaInfo: Record<string, any>,
    filterableColumns: Record<string, string[]>
) {
    const dateColumns: { table: string; column: string; type: string }[] = [];
    const categoricalColumns: { table: string; column: string; distinct: any[] }[] = [];
    const entityColumns: { viaTable: string; from: string; to: string; count?: number }[] = [];
    const searchColumns: { table: string; column: string; score: number }[] = [];
    const searchSignals = /(name|title|email|username|user_name|phone|company|customer|client|account|code|number|id)$/i;

    Object.entries(filterableColumns || {}).forEach(([table, columns]) => {
        const info = schemaInfo?.[table];
        const colInfo = info?.columns || [];
        columns.forEach((column) => {
            const match = colInfo.find((c: any) => getColumnName(c) === column);
            const type = String(match?.type || match?.data_type || "");
            if (isTemporalType(type)) {
                dateColumns.push({ table, column, type });
            } else if (isTextType(type) || type.toLowerCase().includes("enum")) {
                categoricalColumns.push({ table, column, distinct: [] });
                const scoreBase = searchSignals.test(String(column)) ? 4 : 1;
                searchColumns.push({ table, column, score: scoreBase });
            }
        });
    });

    const primaryDate = dateColumns[0];
    const primarySearch = searchColumns.sort((a, b) => b.score - a.score)[0];
    const summaryLines: string[] = [];
    if (primaryDate) {
        summaryLines.push(`Date range filter: ${primaryDate.table}.${primaryDate.column}`);
    }
    if (categoricalColumns.length > 0) {
        summaryLines.push(`Categorical filters: ${categoricalColumns.slice(0, 5).map(c => `${c.table}.${c.column}`).join(', ')}${categoricalColumns.length > 5 ? ' ...' : ''}`);
    }
    if (entityColumns.length > 0) {
        summaryLines.push(`Entity filters: ${entityColumns.slice(0, 5).map(e => e.from).join(', ')}${entityColumns.length > 5 ? ' ...' : ''}`);
    }
    if (primarySearch?.table && primarySearch?.column) {
        summaryLines.push(`Search field: ${primarySearch.table}.${primarySearch.column}`);
    }

    return {
        dateColumns,
        categoricalColumns,
        entityColumns,
        searchColumns,
        primarySearch,
        primaryDate,
        summary: summaryLines.join('\n') || 'No filterable dimensions detected.'
    };
}

async function buildSemanticMatches(tableName: string, tableSchema: any): Promise<TableInsight["semanticMatches"]> {
    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const terms = [tableName, ...columns.map((col: any) => getColumnName(col)).filter(Boolean)];

    // NOTE: Removed mock semanticService usage to enforce real schema grounding.
    return {
        terms,
        metrics: [],
        dimensions: []
    };
}

async function buildTableInsight(
    tableName: string,
    tableSchema: any,
    sampleRows: any[],
    rowCount: number | undefined,
    options: SchemaDiscoveryOptions
): Promise<TableInsight | null> {
    const shouldEnrich = options.enableSemanticSearch || options.enableTableKpis || options.enableTableMatrix || options.enableTableFilters;
    if (!shouldEnrich) return null;

    const insight: TableInsight = {};

    if (options.enableSemanticSearch) {
        insight.semanticMatches = await buildSemanticMatches(tableName, tableSchema);
    }

    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    if (options.enableTableKpis) {
        insight.kpis = buildTableKpis(tableName, columns, rowCount);
    }

    if (options.enableTableMatrix) {
        insight.dataMatrix = buildTableDataMatrix(tableSchema, sampleRows, rowCount);
    }

    if (options.enableTableFilters) {
        insight.filters = buildTableFilters(tableName, tableSchema, sampleRows);
    }

    return insight;
}

async function buildTableInsights(
    schemaInfo: Record<string, any>,
    sampleData: Record<string, any[]>,
    tableCounts: Record<string, number> | null,
    options: SchemaDiscoveryOptions
) {
    const shouldEnrich = options.enableSemanticSearch || options.enableTableKpis || options.enableTableMatrix || options.enableTableFilters;
    if (!shouldEnrich) return null;

    const tableInsights: Record<string, TableInsight> = {};
    const entries = Object.entries(schemaInfo);

    for (const [tableName, tableSchema] of entries) {
        const insight = await buildTableInsight(
            tableName,
            tableSchema,
            sampleData[tableName] || [],
            tableCounts ? tableCounts[tableName] : undefined,
            options
        );
        if (insight) {
            tableInsights[tableName] = insight;
        }
    }

    return tableInsights;
}

function getAllowedWidgetTypes(schemaForPrompt: any) {
    const disabledTypes = Array.isArray(schemaForPrompt?.disabledWidgetTypes) ? schemaForPrompt.disabledWidgetTypes : [];
    const allowedTypes = [...PLANNER_WIDGET_TYPE_ORDER].filter((t) => !disabledTypes.includes(t));
    const orderedAllowedTypes = PLANNER_WIDGET_TYPE_ORDER.filter((t) => allowedTypes.includes(t));
    const requiredWidgetCount = orderedAllowedTypes.length + (allowedTypes.includes("kpi") ? 3 : 0);
    return { allowedTypes, orderedAllowedTypes, requiredWidgetCount };
}

function buildPlannerRulesBlock(allowedTypes: string[], orderedAllowedTypes: string[], requiredWidgetCount: number) {
    return [
        "DO NOT include any widget types outside this list.",
        "You MUST include every allowed widget type at least once.",
        allowedTypes.includes("kpi")
            ? "Include exactly 4 KPI cards if KPI is allowed."
            : "Do not include KPI cards if KPI is not allowed.",
        allowedTypes.includes("table")
            ? "If table is allowed, the final widget must be a table."
            : "Do not include tables if table is not allowed.",
        "Order widgets using this preferred type order (repeat KPI cards first if enabled):",
        orderedAllowedTypes.join(", "),
        `Total widgets must be exactly ${requiredWidgetCount}.`,
    ].join("\n");
}

function truncatePlannerText(value: string, maxChars: number) {
    if (!value) return value;
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

function buildPlannerFiltersText(schemaForPrompt: any) {
    const explicitFilterable = schemaForPrompt?.filterableColumns || null;
    const filterCandidates = schemaForPrompt?.filterCandidates;
    const filterSummary = String(schemaForPrompt?.filterSummary || "").trim();
    const tableInsightFilters = Object.values(schemaForPrompt?.tableInsights || {})
        .flatMap((insight: any) => insight?.filters || [])
        .filter((f: any) => f?.table && f?.column);
    const schemaInfo = schemaForPrompt?.schemaInfo || {};
    const lines: string[] = [];
    let idx = 1;
    if (explicitFilterable && typeof explicitFilterable === "object") {
        Object.entries(explicitFilterable).forEach(([table, cols]) => {
            (Array.isArray(cols) ? cols : []).slice(0, 4).forEach((col: any) => {
                const colName = String(col);
                if (!colName) return;
                lines.push(`${idx++}) ${colName}, multi-select, default=all, ${table}.${colName}, all widgets`);
            });
        });
    }
    if (filterCandidates?.primaryDate?.table && filterCandidates?.primaryDate?.column) {
        lines.push(`${idx++}) Date Range, date range, default=this_month, ${filterCandidates.primaryDate.table}.${filterCandidates.primaryDate.column}, all widgets`);
    }
    if (filterCandidates?.primarySearch?.table && filterCandidates?.primarySearch?.column) {
        lines.push(`${idx++}) Search, search, default=empty, ${filterCandidates.primarySearch.table}.${filterCandidates.primarySearch.column}, all widgets`);
    }
    (filterCandidates?.categoricalColumns || []).slice(0, 4).forEach((col: any) => {
        if (!col?.table || !col?.column) return;
        lines.push(`${idx++}) ${col.column}, multi-select, default=all, ${col.table}.${col.column}, all widgets`);
    });
    if (lines.length === 0 && tableInsightFilters.length > 0) {
        tableInsightFilters.slice(0, 4).forEach((f: any) => {
            const label = f.title || f.column;
            const type = f.type || "multi-select";
            lines.push(`${idx++}) ${label}, ${type}, default=all, ${f.table}.${f.column}, all widgets`);
        });
    }
    if (lines.length === 0) {
        const tables = Object.entries(schemaInfo);
        let found: { table: string; column: string } | null = null;
        for (const [table, info] of tables) {
            const cols = (info as any)?.columns || [];
            for (const col of cols) {
                const colName = String(col?.name || "");
                const colType = String(col?.type || "");
                if (/date|time|timestamp/i.test(colName) || /date|time|timestamp/i.test(colType)) {
                    found = { table, column: colName };
                    break;
                }
            }
            if (found) break;
        }
        if (found) {
            lines.push(`${idx++}) Date Range, date range, default=this_month, ${found.table}.${found.column}, all widgets`);
        }
    }
    if (lines.length === 0) {
        if (filterSummary) {
            const dateMatch = filterSummary.match(/Date range filter:\s*([^\n]+)/i);
            const categoricalMatch = filterSummary.match(/Categorical filters:\s*([^\n]+)/i);
            if (dateMatch?.[1]) {
                const dateField = dateMatch[1].split(',')[0]?.trim();
                if (dateField) {
                    lines.push(`${idx++}) Date Range, date range, default=this_month, ${dateField}, all widgets`);
                }
            }
            if (categoricalMatch?.[1]) {
                const fields = categoricalMatch[1]
                    .split(',')
                    .map((f) => f.trim())
                    .filter(Boolean)
                    .slice(0, 4);
                fields.forEach((field) => {
                    lines.push(`${idx++}) ${field.split('.').pop() || field}, multi-select, default=all, ${field}, all widgets`);
                });
            }
        }
        if (lines.length === 0) {
            lines.push("1) None");
        }
    }
    return lines.join("\n");
}

function parsePlannerMeta(text: string) {
    const cleaned = String(text || "").replace(/\*\*|\*|__|#/g, '');
    const titleMatch = cleaned.match(/DASHBOARD TITLE\s*:\s*(.+)/i);
    const purposeMatch = cleaned.match(/PURPOSE\s*:\s*(.+)/i);
    const filtersSectionMatch = cleaned.match(/FILTERS TO INCLUDE\s*:\s*([\s\S]*?)(?:\nWIDGET\s+1:|$)/i);
    const filtersText = filtersSectionMatch?.[1]
        ?.split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => /^\d+\)/.test(line))
        .join('\n');
    return {
        title: titleMatch?.[1]?.trim(),
        purpose: purposeMatch?.[1]?.trim(),
        filtersText: filtersText && filtersText.length > 0 ? filtersText : null,
    };
}

function parseFiltersOnly(text: string) {
    const cleaned = String(text || "").replace(/\*\*|\*|__|#/g, '');
    const filtersSectionMatch = cleaned.match(/FILTERS TO INCLUDE\s*:\s*([\s\S]*?)$/i);
    const filtersText = filtersSectionMatch?.[1]
        ?.split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => /^\d+\)/.test(line))
        .join('\n');
    return filtersText && filtersText.length > 0 ? filtersText : null;
}

function buildPlanHeader(input: { title: string; purpose: string; filtersText: string; scenarioText?: string }) {
    const lines: string[] = [];
    lines.push(`DASHBOARD TITLE: ${input.title || "AI Analytics Dashboard"}`);
    lines.push(`PURPOSE: ${input.purpose || "Auto-generated dashboard plan."}`);
    lines.push("");
    lines.push("FILTERS TO INCLUDE:");
    lines.push(input.filtersText || "1) None");
    if (input.scenarioText) {
        lines.push("");
        lines.push("SCENARIO COVERAGE:");
        lines.push(input.scenarioText);
    }
    lines.push("");
    return lines.join("\n");
}

function replacePlanHeader(planText: string, headerText: string) {
    const widgetIndex = planText.search(/\nWIDGET\s+1\s*:/i);
    if (widgetIndex === -1) return `${headerText}${planText}`.trim();
    const rest = planText.slice(widgetIndex + 1).trimStart();
    return `${headerText}\n${rest}`.trim();
}

function resolveFiltersText(metaFiltersText: string | null, fallbackFiltersText: string) {
    if (!metaFiltersText) return fallbackFiltersText;
    const normalized = metaFiltersText.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === "1) none" || normalized === "1) none." || normalized === "none") {
        return fallbackFiltersText;
    }
    return metaFiltersText;
}

function buildScenarioCoverageText(schemaForPrompt: any, widgets: any[]) {
    const filterCandidates = schemaForPrompt?.filterCandidates || {};
    const hasPrimaryDate = Boolean(filterCandidates?.primaryDate?.table && filterCandidates?.primaryDate?.column);
    const hasSearch = Boolean(filterCandidates?.primarySearch?.table && filterCandidates?.primarySearch?.column);
    const hasCategorical = Array.isArray(filterCandidates?.categoricalColumns) && filterCandidates.categoricalColumns.length > 0;
    const hasEntity = Array.isArray(filterCandidates?.entityColumns) && filterCandidates.entityColumns.length > 0;
    const hasRelationships = Array.isArray(schemaForPrompt?.relationships) && schemaForPrompt.relationships.length > 0;
    const hasTables = Array.isArray(widgets) && widgets.some((w: any) => w?.type === "table");
    const hasKpis = Array.isArray(widgets) && widgets.some((w: any) => w?.type === "kpi");
    const summary = [
        `1) Date filters: ${hasPrimaryDate ? "yes" : "no"}`,
        `2) Search: ${hasSearch ? "yes" : "no"}`,
        `3) Categorical filters: ${hasCategorical ? "yes" : "no"}`,
        `4) Entity filters: ${hasEntity ? "yes" : "no"}`,
        `5) Joins/relationships: ${hasRelationships ? "yes" : "no"}`,
        `6) Table pagination: ${hasTables ? "yes" : "no"}`,
        `7) KPI coverage: ${hasKpis ? "yes" : "no"}`
    ];
    return summary.join("\n");
}

function buildPlanTextFromWidgets(input: {
    title: string;
    purpose: string;
    filtersText: string;
    widgets: any[];
    scenarioText?: string;
}) {
    const lines: string[] = [];
    lines.push(`DASHBOARD TITLE: ${input.title || "AI Analytics Dashboard"}`);
    lines.push(`PURPOSE: ${input.purpose || "Auto-generated dashboard plan."}`);
    lines.push("");
    lines.push("FILTERS TO INCLUDE:");
    lines.push(input.filtersText || "1) None");
    if (input.scenarioText) {
        lines.push("");
        lines.push("SCENARIO COVERAGE:");
        lines.push(input.scenarioText);
    }
    lines.push("");
    input.widgets.forEach((w: any, idx: number) => {
        const widgetTitle = String(w?.title || `Widget ${idx + 1}`).trim();
        const widgetType = String(w?.type || "chart").trim();
        const goal = String(w?.goal || "Visualization").trim();
        const uses = w?.primaryTable ? `${w.primaryTable}.*` : "Not specified.";
        lines.push(`WIDGET ${idx + 1}: ${widgetType} - ${widgetTitle}`);
        lines.push(`Shows: ${goal}`);
        lines.push("Why: Auto-generated by parallel planning.");
        lines.push(`Uses: ${uses}`);
        lines.push("Filters applied: See filters above.");
        lines.push("Notes: Auto-generated.");
        lines.push("");
    });
    return lines.join("\n").trim();
}

function orderWidgetsByType(widgets: any[], orderedAllowedTypes: string[]) {
    const typeRank = new Map(orderedAllowedTypes.map((t, i) => [t, i]));
    return [...widgets].sort((a: any, b: any) => {
        const aRank = typeRank.has(a?.type) ? (typeRank.get(a.type) as number) : 999;
        const bRank = typeRank.has(b?.type) ? (typeRank.get(b.type) as number) : 999;
        if (aRank !== bRank) return aRank - bRank;
        return String(a?.title || "").localeCompare(String(b?.title || ""));
    });
}

function formatTableInsightsForPrompt(tableInsights: Record<string, TableInsight> | null) {
    if (!tableInsights) return "";
    const trimmed = Object.fromEntries(
        Object.entries(tableInsights).slice(0, 12).map(([table, insight]) => [
            table,
            {
                semantic: insight.semanticMatches
                    ? {
                        metrics: insight.semanticMatches.metrics.map((m) => m.slug),
                        dimensions: insight.semanticMatches.dimensions.map((d) => d.slug)
                    }
                    : undefined,
                kpis: insight.kpis?.map((kpi) => ({
                    title: kpi.title,
                    aggregation: kpi.aggregation,
                    column: kpi.column
                })),
                dataMatrix: insight.dataMatrix
                    ? {
                        rowCount: insight.dataMatrix.rowCount,
                        columnCounts: insight.dataMatrix.columnCounts,
                        categoricalColumns: insight.dataMatrix.categoricalCandidates.map((c) => c.column),
                        numericColumns: insight.dataMatrix.numericCandidates.map((c) => c.column)
                    }
                    : undefined,
                filters: insight.filters?.map((f) => ({
                    title: f.title,
                    type: f.type,
                    column: f.column,
                    table: f.table,
                    targetTable: f.targetTable
                })),
                queryExamples: insight.queryExamples?.slice(0, 3).map((ex) => ({
                    description: ex.description,
                    sql: ex.sql,
                    results: ex.results?.slice(0, 2)
                }))
            }
        ])
    );
    return JSON.stringify(trimmed).slice(0, 8000);
}

function tokenizeQuery(query: string) {
    const stopwords = new Set([
        "the", "and", "for", "with", "from", "this", "that", "show", "showing", "dashboard", "plan", "report",
        "metrics", "metric", "chart", "table", "kpi", "summary", "analysis", "overview", "by", "of", "to", "in"
    ]);
    return String(query || "")
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !stopwords.has(t));
}

function scoreTableForAgent(input: {
    table: string;
    info: any;
    queryTokens: string[];
    type: string;
    tableCount?: number;
    primaryDateTable?: string;
}) {
    const { table, info, queryTokens, type, tableCount, primaryDateTable } = input;
    let score = 0;
    const tableLower = table.toLowerCase();
    queryTokens.forEach((token) => {
        if (tableLower.includes(token)) score += 4;
    });
    const cols = info?.columns || [];
    cols.forEach((col: any) => {
        const colName = String(col?.name || col?.column_name || "").toLowerCase();
        queryTokens.forEach((token) => {
            if (colName.includes(token)) score += 2;
        });
        if (type !== "table") {
            if (col?.isNumeric) score += 1.2;
            if (col?.isTemporal) score += 1.2;
        }
    });
    if (primaryDateTable && primaryDateTable === table) score += 3;
    if (type === "table") {
        score += Math.min(cols.length / 5, 4);
    }
    if (typeof tableCount === "number") {
        score += Math.min(Math.log10(tableCount + 1), 3);
    }
    return score;
}

function buildRelevantSchemaForAgent(schemaForPrompt: any, type: string, query: string, maxTables = 6) {
    const schemaInfo = schemaForPrompt?.schemaInfo || {};
    const tableCounts = schemaForPrompt?.tableCounts || {};
    const relationships = Array.isArray(schemaForPrompt?.relationships) ? schemaForPrompt.relationships : [];
    const primaryDateTable = schemaForPrompt?.filterCandidates?.primaryDate?.table;
    const queryTokens = tokenizeQuery(query);
    const tableEntries = Object.entries(schemaInfo);
    if (tableEntries.length <= maxTables) {
        return { tables: tableEntries.map(([name]) => name), relationships };
    }

    const scored = tableEntries.map(([table, info]) => {
        const count = typeof tableCounts?.[table] === "number" ? Number(tableCounts[table]) : undefined;
        const score = scoreTableForAgent({ table, info, queryTokens, type, tableCount: count, primaryDateTable });
        return { table, score };
    }).sort((a, b) => b.score - a.score);

    let selected = scored.filter((entry) => entry.score > 0).map((entry) => entry.table);
    if (selected.length === 0) {
        selected = scored.slice(0, maxTables).map((entry) => entry.table);
    } else {
        selected = selected.slice(0, maxTables);
    }

    const selectedSet = new Set(selected);
    relationships.forEach((rel: any) => {
        const from = rel?.from?.table;
        const to = rel?.to?.table;
        if (from && to) {
            if (selectedSet.has(from) && !selectedSet.has(to) && selectedSet.size < maxTables + 2) {
                selectedSet.add(to);
            } else if (selectedSet.has(to) && !selectedSet.has(from) && selectedSet.size < maxTables + 2) {
                selectedSet.add(from);
            }
        }
    });

    return {
        tables: Array.from(selectedSet),
        relationships: relationships.filter((rel: any) => selectedSet.has(rel?.from?.table) && selectedSet.has(rel?.to?.table))
    };
}

function buildSchemaTextForTables(schemaForPrompt: any, tables: string[]) {
    return tables.map((table) => {
        const info = schemaForPrompt?.schemaInfo?.[table];
        const visible = schemaForPrompt?.visibleColumns?.[table];
        const cols = (info?.columns || [])
            .filter((c: any) => {
                if (!Array.isArray(visible) || visible.length === 0) return true;
                const name = c?.name || c?.column_name;
                return visible.includes(name);
            })
            .map((c: any) => {
                const pk = c.isPrimary ? 'PK' : '';
                const name = c?.name || c?.column_name || '';
                const type = c?.type || c?.data_type || '';
                return `${name} (${type}${pk ? ', ' + pk : ''})`;
            }).join(', ');
        return `TABLE "${table}" [${cols}]`;
    }).join('\n');
}

function buildJoinCandidatesText(relationships: any[]) {
    if (!relationships || relationships.length === 0) return "None";
    return relationships.map((rel: any) => {
        const from = rel?.from?.table && rel?.from?.column ? `${rel.from.table}.${rel.from.column}` : '';
        const to = rel?.to?.table && rel?.to?.column ? `${rel.to.table}.${rel.to.column}` : '';
        if (!from || !to) return null;
        const relType = rel?.type ? ` (${rel.type})` : '';
        return `${from} -> ${to}${relType}`;
    }).filter(Boolean).join('\n');
}

function detectPrimaryIntent(schemaForPrompt: any, query: string) {
    const tableNames = Object.keys(schemaForPrompt?.schemaInfo || {}).map((t) => t.toLowerCase());
    const columnNames = Object.values(schemaForPrompt?.schemaInfo || {})
        .flatMap((info: any) => (info?.columns || []).map((c: any) => String(c?.name || c?.column_name || "").toLowerCase()));
    const haystack = `${String(query || "").toLowerCase()} ${tableNames.join(" ")} ${columnNames.join(" ")}`;
    const intents: Array<{ label: string; keywords: string[] }> = [
        { label: "SaaS", keywords: ["subscription", "mrr", "arr", "plan", "billing", "trial", "seat", "tenant", "workspace", "churn"] },
        { label: "E-commerce", keywords: ["order", "orders", "cart", "checkout", "product", "sku", "payment", "refund", "shipment", "revenue"] },
        { label: "Support", keywords: ["ticket", "tickets", "support", "case", "sla", "resolution", "agent", "queue"] },
        { label: "Marketing", keywords: ["campaign", "utm", "ad", "ads", "click", "impression", "conversion", "lead", "funnel"] },
    ];
    const scored = intents.map((intent) => {
        const score = intent.keywords.reduce((acc, kw) => acc + (haystack.includes(kw) ? 1 : 0), 0);
        return { ...intent, score };
    }).sort((a, b) => b.score - a.score);
    if (scored.length === 0 || scored[0].score === 0) return "General";
    return scored[0].label;
}

async function runPlannerDomainAgent(input: {
    domainLabel: string;
    query: string;
    schemaForPrompt: any;
    onToken?: (token: string) => void;
    onDraft?: (draft: string) => void;
    critiqueEnabled?: boolean;
}) {
    const { domainLabel, query, schemaForPrompt, onToken, onDraft, critiqueEnabled } = input;
    const schemaSummary = buildStrategySchemaSummary(schemaForPrompt);
    const systemPrompt = `You are the ${domainLabel} Domain Agent.

USER OBJECTIVE: "${query}"
SCHEMA SUMMARY:
${schemaSummary}

TASK:
Provide concise domain-specific guidance (max 5 bullet lines) about:
- Which KPIs matter most
- Which dimensions to break down by
- Any common pitfalls or must-have visuals

Return ONLY bullet lines.`;

    const response = await streamModelWithRetry([
        new SystemMessage(systemPrompt),
        new HumanMessage("Provide domain guidance only.")
    ], onToken);
    const draft = (response.content as string) || "";
    onDraft?.(draft);
    if (!critiqueEnabled) return draft;
    const formatSpec = `- Bullet line 1
- Bullet line 2
- Bullet line 3 (max 5 lines)`;
    return refinePlannerOutput({
        agentLabel: `${domainLabel} Domain Agent`,
        draft,
        formatSpec,
        onToken
    });
}

async function runPlannerFinalAgent(input: {
    query: string;
    draftPlan: string;
    allowedTypes: string[];
    orderedAllowedTypes: string[];
    requiredWidgetCount: number;
    onToken?: (token: string) => void;
    onDraft?: (draft: string) => void;
    critiqueEnabled?: boolean;
}) {
    const { query, draftPlan, allowedTypes, orderedAllowedTypes, requiredWidgetCount, onToken, onDraft, critiqueEnabled } = input;
    const systemPrompt = `You are the Final Plan Agent. You merge all sub-agent outputs into a single best plan.

USER OBJECTIVE: "${query}"
ALLOWED WIDGET TYPES (STRICT): ${allowedTypes.join(", ")}
ORDER PREFERENCE: ${orderedAllowedTypes.join(", ")}
TOTAL WIDGETS REQUIRED: ${requiredWidgetCount}

TASK:
- Validate and fix the draft plan.
- Ensure every allowed type appears at least once.
- If KPI is allowed, ensure exactly 4 KPI cards.
- If table is allowed, it must be the final widget.
- Ensure all widgets include Uses, Filters applied, Notes, Confidence, Rationale.
- Normalize wording and remove duplicates.
- Keep titles short and business-friendly.
- Use only tables/columns mentioned in the draft.

Return ONLY the final plan in this exact format:

DASHBOARD TITLE: <title>
PURPOSE: <purpose>

FILTERS TO INCLUDE:
1) <filter name, type, default, column(s), affected widgets>

SCENARIO COVERAGE:
1) <coverage line>

WIDGET 1: [Type] - [Title]
Shows: [Exact metric]
Why: [Business value]
Uses: [table.column references, include join paths if needed]
Filters applied: [List filters and how they modify the query]
Notes: [Any special requirements or comparison logic]
Confidence: [0-1]
Rationale: [Short reasoning]

WIDGET 2: ...`;

    const response = await streamModelWithRetry([
        new SystemMessage(systemPrompt),
        new HumanMessage(draftPlan)
    ], onToken);

    const draft = (response.content as string) || "";
    onDraft?.(draft);
    if (!critiqueEnabled) return draft;

    const formatSpec = `DASHBOARD TITLE: <title>
PURPOSE: <purpose>

FILTERS TO INCLUDE:
1) <filter name, type, default, column(s), affected widgets>

SCENARIO COVERAGE:
1) <coverage line>

WIDGET 1: [Type] - [Title]
Shows: [Exact metric]
Why: [Business value]
Uses: [table.column references, include join paths if needed]
Filters applied: [List filters and how they modify the query]
Notes: [Any special requirements or comparison logic]
Confidence: [0-1]
Rationale: [Short reasoning]
...`;
    return refinePlannerOutput({
        agentLabel: "Final Plan Agent",
        draft,
        formatSpec,
        onToken
    });
}

function normalizePlannedWidgets(widgets: any[], schemaInfo: Record<string, any>, allowedTypesOverride?: string[]) {
    const defaultAllowedTypes = [...PLANNER_WIDGET_TYPE_ORDER];
    const allowedTypes = new Set(allowedTypesOverride && allowedTypesOverride.length > 0
        ? allowedTypesOverride
        : defaultAllowedTypes);
    const tableNames = new Set(Object.keys(schemaInfo || {}));
    const seenIds = new Set<string>();
    const titleCounts = new Map<string, number>();

    const cleaned = widgets
        .map((w: any, idx: number) => {
            const type = allowedTypes.has(w?.type) ? w.type : "bar";
            let title = String(w?.title || w?.name || `Widget ${idx + 1}`).trim();
            const idBase = String(w?.id || `w${idx + 1}`).replace(/\s+/g, '_');
            let id = idBase;
            let counter = 1;
            while (seenIds.has(id)) {
                id = `${idBase}_${counter++}`;
            }
            seenIds.add(id);
            const titleKey = title.toLowerCase();
            const nextTitleCount = (titleCounts.get(titleKey) || 0) + 1;
            titleCounts.set(titleKey, nextTitleCount);
            if (nextTitleCount > 1) {
                title = `${title} (${nextTitleCount})`;
            }
            const primaryTable = w?.primaryTable && tableNames.has(w.primaryTable) ? w.primaryTable : undefined;
            return {
                ...w,
                id,
                type,
                title,
                primaryTable
            };
        })
        .filter(Boolean) as any[];

    const kpis = cleaned.filter((w) => w.type === "kpi");
    const nonKpis = cleaned.filter((w) => w.type !== "kpi");
    const reordered = [...kpis, ...nonKpis];
    const allowedList = allowedTypesOverride && allowedTypesOverride.length > 0
        ? allowedTypesOverride
        : defaultAllowedTypes;
    const maxWidgets = allowedList.length + (allowedList.includes("kpi") ? 3 : 0);
    return reordered.slice(0, maxWidgets);
}

function filterSchemaForNonEmptyTables(schema: any) {
    let tableCounts = schema?.tableCounts;
    if (!tableCounts || typeof tableCounts !== "object" || Object.keys(tableCounts).length === 0) {
        const sampleData = schema?.sampleData;
        if (sampleData && typeof sampleData === "object") {
            tableCounts = Object.fromEntries(
                Object.entries(sampleData).map(([table, rows]) => [table, Array.isArray(rows) ? rows.length : 0])
            );
        }
    }
    if (!tableCounts || typeof tableCounts !== "object") return null;

    const sampleData = schema?.sampleData;
    const nonEmptyTables = new Set(
        Object.entries(tableCounts)
            .filter(([table, count]) => {
                const numeric = Number(count);
                if (Number.isFinite(numeric) && numeric > 0) return true;
                const rows = Array.isArray(sampleData?.[table]) ? sampleData[table].length : 0;
                return rows > 0;
            })
            .map(([table]) => table)
    );

    const filterMap = <T extends Record<string, any>>(input: T | null | undefined) => {
        if (!input) return input || {};
        return Object.fromEntries(Object.entries(input).filter(([table]) => nonEmptyTables.has(table)));
    };

    const filteredSchemaInfo = filterMap(schema.schemaInfo);
    const filteredSampleData = filterMap(schema.sampleData);
    const filteredTableCounts = filterMap(tableCounts);
    const filteredTableInsights = schema.tableInsights ? filterMap(schema.tableInsights) : schema.tableInsights;
    const filteredVisibleColumns = schema.visibleColumns ? filterMap(schema.visibleColumns) : schema.visibleColumns;
    const filteredFilterableColumns = schema.filterableColumns ? filterMap(schema.filterableColumns) : schema.filterableColumns;
    const filteredRelationships = Array.isArray(schema.relationships)
        ? schema.relationships.filter((rel: any) => nonEmptyTables.has(rel?.from?.table) && nonEmptyTables.has(rel?.to?.table))
        : [];

    const filterCandidates = filteredFilterableColumns
        ? buildFilterCandidatesFromColumns(filteredSchemaInfo, filteredFilterableColumns)
        : detectFilterCandidates(filteredSchemaInfo, filteredSampleData, filteredTableCounts, filteredRelationships);
    const tableNames = Object.keys(filteredSchemaInfo);
    const rawAnalysis = tableNames.length
        ? `Database contains ${tableNames.length} non-empty tables including ${tableNames.slice(0, 5).join(', ')}.`
        : "No non-empty tables found for planning.";

    return {
        ...schema,
        schemaInfo: filteredSchemaInfo,
        sampleData: filteredSampleData,
        tableCounts: filteredTableCounts,
        tableInsights: filteredTableInsights,
        visibleColumns: filteredVisibleColumns,
        filterableColumns: filteredFilterableColumns,
        relationships: filteredRelationships,
        filterCandidates,
        filterSummary: filterCandidates.summary,
        rawAnalysis
    };
}

// --- STANDALONE AGENTS (New Sequential Flow) ---

/**
 * STEP 1: SCHEMA DISCOVERY (Production-Grade)
 * Expert database architect and data profiler.
 * Explores database structure via MCP and generates semantic understanding.
 */
export async function runSchemaDiscovery(
    connectionString?: string,
    options: SchemaDiscoveryOptions = {},
    allowedTables?: string[]
) {
    return runSchemaDiscoveryImpl(connectionString, options, allowedTables);
}

function detectFilterCandidates(
    schemaInfo: Record<string, any>,
    sampleData: Record<string, any[]>,
    tableCounts: Record<string, number>,
    relationships: any[]
) {
    const dateColumns: { table: string; column: string; type: string }[] = [];
    const categoricalColumns: { table: string; column: string; distinct: any[] }[] = [];
    const entityColumns: { viaTable: string; from: string; to: string; count?: number }[] = [];
    const searchColumns: { table: string; column: string; score: number }[] = [];
    const searchSignals = /(name|title|email|username|user_name|phone|company|customer|client|account|code|number|id)$/i;

    for (const [table, info] of Object.entries(schemaInfo)) {
        const columns = (info as any)?.columns || [];
        columns.forEach((col: any) => {
            const colName = col.name || col.column_name;
            const colType = (col.type || col.data_type || '').toLowerCase();
            const samples = sampleData[table] || [];
            const values = samples.map((r: any) => r[colName]).filter((v: any) => v !== null && v !== undefined);

            if (isTemporalType(colType)) {
                dateColumns.push({ table, column: colName, type: colType });
            }

            if (isTextType(colType) || colType.includes('enum')) {
                const distinct = Array.from(new Set(values.map((v: any) => String(v))));
                if (distinct.length > 0 && distinct.length <= 20) {
                    categoricalColumns.push({ table, column: colName, distinct });
                }
                const scoreBase = searchSignals.test(String(colName)) ? 4 : 1;
                const distinctScore = distinct.length > 20 ? 2 : distinct.length > 5 ? 1 : 0;
                searchColumns.push({ table, column: colName, score: scoreBase + distinctScore });
            }
        });
    }

    relationships.forEach((rel: any) => {
        if (rel?.from?.table && rel?.from?.column && rel?.to?.table && rel?.to?.column) {
            entityColumns.push({
                viaTable: rel.from.table,
                from: `${rel.from.table}.${rel.from.column}`,
                to: `${rel.to.table}.${rel.to.column}`,
                count: tableCounts[rel.to.table] || undefined
            });
        }
    });

    const primaryDate = dateColumns[0];
    const primarySearch = searchColumns.sort((a, b) => b.score - a.score)[0];
    const summaryLines: string[] = [];
    if (primaryDate) {
        summaryLines.push(`Date range filter: ${primaryDate.table}.${primaryDate.column}`);
    }
    if (categoricalColumns.length > 0) {
        summaryLines.push(`Categorical filters: ${categoricalColumns.slice(0, 5).map(c => `${c.table}.${c.column}`).join(', ')}${categoricalColumns.length > 5 ? ' ...' : ''}`);
    }
    if (entityColumns.length > 0) {
        summaryLines.push(`Entity filters: ${entityColumns.slice(0, 5).map(e => e.from).join(', ')}${entityColumns.length > 5 ? ' ...' : ''}`);
    }
    if (primarySearch?.table && primarySearch?.column) {
        summaryLines.push(`Search field: ${primarySearch.table}.${primarySearch.column}`);
    }

    return {
        dateColumns,
        categoricalColumns,
        entityColumns,
        searchColumns,
        primarySearch,
        primaryDate,
        summary: summaryLines.join('\n') || 'No filterable dimensions detected.'
    };
}

/**
 * Helper: Generate natural language schema analysis
 */
async function generateSchemaAnalysis(
    tables: string[],
    schemaInfo: Record<string, any>,
    sampleData: Record<string, any[]>,
    tableCounts: Record<string, number>,
    relationships: any[],
    projectContext?: string
): Promise<string> {
    console.log("[AGENT] Generating semantic schema analysis...");

    // Simplified schema for LLM (capped to 40 tables)
    // Simplified schema for LLM (Drastically reduced for speed/local models)
    const tableEntries = Object.entries(schemaInfo);

    // Only send Table Name + Column Count + Primary Keys to save heavily on tokens
    const simplifiedSchema = tableEntries.slice(0, 30).map(([table, info]: [string, any]) => {
        const pk = info.columns?.find((c: any) => c.isPrimary)?.name || 'id';
        return `- ${table} (PK: ${pk}, ${info.columns?.length || 0} cols)`;
    }).join('\n');

    // Minimal sample data (Top 3 tables only, 1 row each, fewer columns)
    const limitedSampleData: Record<string, any[]> = {};
    Object.entries(sampleData).slice(0, 3).forEach(([table, rows]) => {
        if (rows && rows.length > 0) {
            // Take only first 3 columns of the first row
            const firstRow = rows[0];
            const prunedRow = Object.fromEntries(Object.entries(firstRow).slice(0, 3));
            limitedSampleData[table] = [prunedRow];
        }
    });

    const projectContextBlock = projectContext ? `PROJECT CONTEXT:\n${projectContext}\n` : '';

    const systemPrompt = `You are a Senior Data Analytics Architect and Profiler.
${projectContextBlock}DATA:
${simplifiedSchema}
SAMPLES: ${JSON.stringify(limitedSampleData)}

TASK: Write a 1-paragraph summary of what this database contains. Identify key business entities (e.g. users, orders).
RULES:
- Only reference tables/columns shown in DATA.
- Do NOT invent topics or unrelated domains.
- If schema context is insufficient, say: "Insufficient schema context for semantic summary."
KEEP IT BRIEF.`;

    try {
        const response = await invokeModelWithRetry([new SystemMessage(systemPrompt)]);
        const content = (response.content as string) || "";
        const normalized = content.toLowerCase();
        const hasTableMention = tables.some((t) => normalized.includes(t.toLowerCase()));
        if (!hasTableMention) {
            return `Database contains ${tables.length} tables including ${tables.slice(0, 5).join(', ')}.`;
        }
        return content;
    } catch (error) {
        console.error("[SCHEMA_LLM_ERROR] Semantic analysis failed:", error);
        return `Database contains ${tables.length} tables including ${tables.slice(0, 5).join(', ')}.`;
    }
}

/**
 * STEP 2: DASHBOARD PLANNER (Production-Grade)
 * Expert database analyst + data analyst + KPI strategist + UI/UX dashboard designer.
 * Returns a comprehensive natural-language dashboard plan.
 */
async function runPlannerSubAgent(input: {
    query: string;
    schemaForPrompt: any;
    allowedTypes: string[];
    orderedAllowedTypes: string[];
    requiredWidgetCount: number;
    focusLabel: string;
    filtersText?: string;
    strategyNotes?: string;
    onToken?: (token: string) => void;
    onDraft?: (draft: string) => void;
    critiqueEnabled?: boolean;
}) {
    const { query, schemaForPrompt, allowedTypes, orderedAllowedTypes, requiredWidgetCount, focusLabel, filtersText, strategyNotes, onToken, onDraft, critiqueEnabled } = input;
    const tableInsightsText = formatTableInsightsForPrompt(schemaForPrompt.tableInsights || null);
    const projectContext = schemaForPrompt.projectContext || schemaForPrompt.projectAbout || "";
    const referenceDate = findLatestDate(schemaForPrompt.sampleData || {});
    const dateContext = buildDateContext(referenceDate);
    const { tables: relevantTables, relationships: relevantRelationships } = buildRelevantSchemaForAgent(schemaForPrompt, allowedTypes[0] || "chart", query, 6);
    const simplifiedSchema = buildSchemaTextForTables(schemaForPrompt, relevantTables);
    const relationships = buildJoinCandidatesText(relevantRelationships);
    const sampleDataText = JSON.stringify(Object.fromEntries(
        Object.entries(schemaForPrompt.sampleData || {})
            .filter(([table]) => relevantTables.includes(table))
            .slice(0, 2)
            .map(([k, v]: [any, any]) => [k, v.slice(0, 1)])
    ));
    const filterSummary = schemaForPrompt.filterSummary || '';
    const trimmedSchema = truncatePlannerText(simplifiedSchema, 2500);
    const trimmedRelationships = truncatePlannerText(relationships, 1000);
    const trimmedSampleData = truncatePlannerText(sampleDataText, 800);
    const trimmedFilterSummary = truncatePlannerText(filterSummary, 1200);
    const trimmedTableInsights = truncatePlannerText(tableInsightsText || '', 1500);
    const trimmedProjectContext = truncatePlannerText(projectContext, 1200);

    const systemPrompt = `You are Plan Agent (${focusLabel}), a Senior Software Architect and KPI Strategist.

USER OBJECTIVE: "${query}"
${trimmedProjectContext ? `\nPROJECT CONTEXT:\n${trimmedProjectContext}\n` : ''}

DATABASE STRUCTURE:
${trimmedSchema}

JOIN CANDIDATES:
${trimmedRelationships}

ALLOWED WIDGET TYPES (STRICT):
${allowedTypes.join(", ")}

${buildPlannerRulesBlock(allowedTypes, orderedAllowedTypes, requiredWidgetCount)}

SAMPLE DATA:
${trimmedSampleData}

DATE CONTEXT (UTC):
${dateContext.summary}

FILTERABLE DIMENSIONS:
${trimmedFilterSummary || 'No filter candidates detected.'}
${trimmedTableInsights ? `\nTABLE INSIGHTS:\n${trimmedTableInsights}` : ''}
${filtersText ? `\nAPPROVED FILTERS (USE WHEN RELEVANT):\n${filtersText}` : ''}
${strategyNotes ? `\nSTRATEGY NOTES:\n${strategyNotes}` : ''}

### Output Format (Strict)
Return ONLY widget blocks in this exact format (no dashboard title, no filters section):

WIDGET 1: [Type] - [Title]
Shows: [Exact metric]
Why: [Business value]
Uses: [table.column references, include join paths if needed e.g. orders.customer_id -> customers.id]
Filters applied: [List filters and how they modify the query]
Notes: [Any special requirements or comparison logic]
Confidence: [0-1]
Rationale: [Short reasoning]

WIDGET 2: [Type] - [Title]
...`;

    const response = await streamModelWithRetry([
        new SystemMessage(systemPrompt),
        new HumanMessage("Generate only the widget blocks for the allowed types.")
    ], onToken);
    const draft = (response.content as string) || "";
    onDraft?.(draft);
    if (!critiqueEnabled) return draft;

    const formatSpec = `WIDGET 1: [Type] - [Title]
Shows: [Exact metric]
Why: [Business value]
Uses: [table.column references, include join paths if needed]
Filters applied: [List filters and how they modify the query]
Notes: [Any special requirements or comparison logic]
Confidence: [0-1]
Rationale: [Short reasoning]
...`;
    return refinePlannerOutput({
        agentLabel: focusLabel,
        draft,
        formatSpec,
        onToken
    });
}

async function runPlannerKpiAgent(input: {
    query: string;
    schemaForPrompt: any;
    requiredWidgetCount: number;
    focusLabel: string;
    filtersText?: string;
    strategyNotes?: string;
    onToken?: (token: string) => void;
    onDraft?: (draft: string) => void;
    critiqueEnabled?: boolean;
}) {
    const { query, schemaForPrompt, requiredWidgetCount, focusLabel, filtersText, strategyNotes, onToken, onDraft, critiqueEnabled } = input;
    const projectContext = schemaForPrompt.projectContext || schemaForPrompt.projectAbout || "";
    const referenceDate = findLatestDate(schemaForPrompt.sampleData || {});
    const dateContext = buildDateContext(referenceDate);
    const { tables: relevantTables } = buildRelevantSchemaForAgent(schemaForPrompt, "kpi", query, 6);
    const simplifiedSchema = buildSchemaTextForTables(schemaForPrompt, relevantTables);
    const tableInsightsText = formatTableInsightsForPrompt(schemaForPrompt.tableInsights || null);
    const trimmedSchema = truncatePlannerText(simplifiedSchema, 2200);
    const trimmedProjectContext = truncatePlannerText(projectContext, 1200);
    const trimmedTableInsights = truncatePlannerText(tableInsightsText || '', 1600);

    const systemPrompt = `You are ${focusLabel}, a Senior Analytics Engineer specializing in KPI design.

USER OBJECTIVE: "${query}"
${trimmedProjectContext ? `\nPROJECT CONTEXT:\n${trimmedProjectContext}\n` : ''}

DATABASE STRUCTURE (RELEVANT TABLES ONLY):
${trimmedSchema}

DATE CONTEXT (UTC):
${dateContext.summary}

FILTERABLE DIMENSIONS:
${filtersText || 'No filter candidates detected.'}
${trimmedTableInsights ? `\nTABLE INSIGHTS:\n${trimmedTableInsights}` : ''}
${strategyNotes ? `\nSTRATEGY NOTES:\n${strategyNotes}` : ''}

KPI RULES (STRICT):
- Generate exactly ${requiredWidgetCount} KPI widgets.
- KPIs must be high-signal and tied to primary fact tables.
- Prefer additive metrics (count, sum, avg) over niche ratios unless query demands it.
- Always include a time-aware KPI if a date column exists (e.g., this month, last 30 days).
- Use human-readable titles (no raw IDs).
- Include explicit table.column references in Uses.

Output ONLY widget blocks in this exact format:
WIDGET 1: KPI - [Title]
Shows: [Exact metric]
Why: [Business value]
Uses: [table.column references, include join paths if needed]
Filters applied: [List filters and how they modify the query]
Notes: [Any special requirements or comparison logic]
Confidence: [0-1]
Rationale: [Short reasoning]

WIDGET 2: ...`;

    const response = await streamModelWithRetry([
        new SystemMessage(systemPrompt),
        new HumanMessage("Generate KPI widgets only.")
    ], onToken);
    const draft = (response.content as string) || "";
    onDraft?.(draft);
    if (!critiqueEnabled) return draft;
    const formatSpec = `WIDGET 1: KPI - [Title]
Shows: [Exact metric]
Why: [Business value]
Uses: [table.column references, include join paths if needed]
Filters applied: [List filters and how they modify the query]
Notes: [Any special requirements or comparison logic]
Confidence: [0-1]
Rationale: [Short reasoning]
...`;
    return refinePlannerOutput({
        agentLabel: focusLabel,
        draft,
        formatSpec,
        onToken
    });
}

async function runPlannerMetaAgent(input: {
    query: string;
    schemaForPrompt: any;
    allowedTypes: string[];
    orderedAllowedTypes: string[];
    requiredWidgetCount: number;
    onToken?: (token: string) => void;
    onDraft?: (draft: string) => void;
    critiqueEnabled?: boolean;
}) {
    const { query, schemaForPrompt, allowedTypes, orderedAllowedTypes, requiredWidgetCount, onToken, onDraft, critiqueEnabled } = input;
    const tableInsightsText = formatTableInsightsForPrompt(schemaForPrompt.tableInsights || null);
    const projectContext = schemaForPrompt.projectContext || schemaForPrompt.projectAbout || "";
    const referenceDate = findLatestDate(schemaForPrompt.sampleData || {});
    const dateContext = buildDateContext(referenceDate);
    const simplifiedSchema = Object.entries(schemaForPrompt.schemaInfo || {}).map(([table, info]: [string, any]) => {
        const cols = info.columns?.map((c: any) => c.name).join(', ');
        return `${table}: [${cols}]`;
    }).join('\n');
    const relationships = (schemaForPrompt.relationships || []).map((r: any) => {
        if (!r?.from?.table || !r?.to?.table) return '';
        return `${r.from.table}.${r.from.column || ''} -> ${r.to.table}.${r.to.column || ''}`;
    }).filter(Boolean).join('\n');
    const sampleDataText = JSON.stringify(Object.fromEntries(
        Object.entries(schemaForPrompt.sampleData || {}).slice(0, 2).map(([k, v]: [any, any]) => [k, v.slice(0, 1)])
    ));
    const filterSummary = schemaForPrompt.filterSummary || '';
    const trimmedSchema = truncatePlannerText(simplifiedSchema, 2000);
    const trimmedRelationships = truncatePlannerText(relationships, 800);
    const trimmedSampleData = truncatePlannerText(sampleDataText, 600);
    const trimmedFilterSummary = truncatePlannerText(filterSummary, 1200);
    const trimmedTableInsights = truncatePlannerText(tableInsightsText || '', 1200);
    const trimmedProjectContext = truncatePlannerText(projectContext, 1000);

    const systemPrompt = `You are the Planner Meta Agent. Your job is to produce a concise dashboard title, purpose, and filters.

USER OBJECTIVE: "${query}"
${trimmedProjectContext ? `\nPROJECT CONTEXT:\n${trimmedProjectContext}\n` : ''}

DATABASE STRUCTURE:
${trimmedSchema}

RELATIONSHIPS:
${trimmedRelationships}

ALLOWED WIDGET TYPES (STRICT):
${allowedTypes.join(", ")}

${buildPlannerRulesBlock(allowedTypes, orderedAllowedTypes, requiredWidgetCount)}

SAMPLE DATA:
${trimmedSampleData}

DATE CONTEXT (UTC):
${dateContext.summary}

FILTERABLE DIMENSIONS:
${trimmedFilterSummary || 'No filter candidates detected.'}
${trimmedTableInsights ? `\nTABLE INSIGHTS:\n${trimmedTableInsights}` : ''}

Return ONLY this format:
DASHBOARD TITLE: <title>
PURPOSE: <purpose>

FILTERS TO INCLUDE:
1) <filter name, type, default, column(s), affected widgets>`;

    const response = await streamModelWithRetry([
        new SystemMessage(systemPrompt),
        new HumanMessage("Generate the dashboard title, purpose, and filters in the exact format.")
    ], onToken);
    const draft = (response.content as string) || "";
    onDraft?.(draft);
    if (!critiqueEnabled) return draft;
    const formatSpec = `DASHBOARD TITLE: <title>
PURPOSE: <purpose>

FILTERS TO INCLUDE:
1) <filter name, type, default, column(s), affected widgets>`;
    return refinePlannerOutput({
        agentLabel: "Meta Agent",
        draft,
        formatSpec,
        onToken
    });
}

async function runPlannerFilterAgent(input: {
    query: string;
    schemaForPrompt: any;
    allowedTypes: string[];
    orderedAllowedTypes: string[];
    requiredWidgetCount: number;
    onToken?: (token: string) => void;
    onDraft?: (draft: string) => void;
    critiqueEnabled?: boolean;
}) {
    const { query, schemaForPrompt, allowedTypes, orderedAllowedTypes, requiredWidgetCount, onToken, onDraft, critiqueEnabled } = input;
    const projectContext = schemaForPrompt.projectContext || schemaForPrompt.projectAbout || "";
    const referenceDate = findLatestDate(schemaForPrompt.sampleData || {});
    const dateContext = buildDateContext(referenceDate);
    const simplifiedSchema = Object.entries(schemaForPrompt.schemaInfo || {}).map(([table, info]: [string, any]) => {
        const cols = info.columns?.map((c: any) => `${c.name} (${c.type})`).join(', ');
        return `${table}: [${cols}]`;
    }).join('\n');
    const relationships = (schemaForPrompt.relationships || []).map((r: any) => {
        if (!r?.from?.table || !r?.to?.table) return '';
        return `${r.from.table}.${r.from.column || ''} -> ${r.to.table}.${r.to.column || ''}`;
    }).filter(Boolean).join('\n');
    const sampleDataText = JSON.stringify(Object.fromEntries(
        Object.entries(schemaForPrompt.sampleData || {}).slice(0, 2).map(([k, v]: [any, any]) => [k, v.slice(0, 1)])
    ));
    const filterSummary = schemaForPrompt.filterSummary || '';
    const tableInsightsText = formatTableInsightsForPrompt(schemaForPrompt.tableInsights || null);
    const trimmedSchema = truncatePlannerText(simplifiedSchema, 2500);
    const trimmedRelationships = truncatePlannerText(relationships, 1000);
    const trimmedSampleData = truncatePlannerText(sampleDataText, 800);
    const trimmedFilterSummary = truncatePlannerText(filterSummary, 1200);
    const trimmedTableInsights = truncatePlannerText(tableInsightsText || '', 2000);
    const trimmedProjectContext = truncatePlannerText(projectContext, 1200);

    const systemPrompt = `You are the Filter Planner Agent. Your job is to propose dashboard filters.

USER OBJECTIVE: "${query}"
${trimmedProjectContext ? `\nPROJECT CONTEXT:\n${trimmedProjectContext}\n` : ''}

DATABASE STRUCTURE:
${trimmedSchema}

RELATIONSHIPS:
${trimmedRelationships}

ALLOWED WIDGET TYPES (STRICT):
${allowedTypes.join(", ")}

${buildPlannerRulesBlock(allowedTypes, orderedAllowedTypes, requiredWidgetCount)}

SAMPLE DATA:
${trimmedSampleData}

DATE CONTEXT (UTC):
${dateContext.summary}

FILTERABLE DIMENSIONS:
${trimmedFilterSummary || 'No filter candidates detected.'}
${trimmedTableInsights ? `\nTABLE INSIGHTS:\n${trimmedTableInsights}` : ''}

Return ONLY this section in exact format:
FILTERS TO INCLUDE:
1) <filter name, type, default, column(s), affected widgets>`;

    const response = await streamModelWithRetry([
        new SystemMessage(systemPrompt),
        new HumanMessage("Generate filters in the exact format.")
    ], onToken);
    const draft = (response.content as string) || "";
    onDraft?.(draft);
    if (!critiqueEnabled) return draft;
    const formatSpec = `FILTERS TO INCLUDE:
1) <filter name, type, default, column(s), affected widgets>`;
    return refinePlannerOutput({
        agentLabel: "Filter Agent",
        draft,
        formatSpec,
        onToken
    });
}

type PlannerAgentEvent = { type: "start" | "done"; agent: string };
type PlannerAgentToken = { agent: string; token: string };
type PlannerAgentDraft = { agent: string; content: string };
type PlannerMetaEvent = { type: "planner_intents"; intents: string[] };

function shouldRunStrategyAgent(schemaForPrompt: any, query: string) {
    const tableCount = Object.keys(schemaForPrompt?.schemaInfo || {}).length;
    const relationshipCount = Array.isArray(schemaForPrompt?.relationships) ? schemaForPrompt.relationships.length : 0;
    const shortQuery = String(query || "").trim().length < 20;
    return tableCount > 6 || relationshipCount > 3 || shortQuery;
}

function buildStrategySchemaSummary(schemaForPrompt: any) {
    const tables = Object.keys(schemaForPrompt?.schemaInfo || {});
    const relationships = Array.isArray(schemaForPrompt?.relationships) ? schemaForPrompt.relationships : [];
    const dateColumns = schemaForPrompt?.filterCandidates?.dateColumns || [];
    return [
        `Tables: ${tables.length > 0 ? tables.slice(0, 8).join(", ") : "none"}`,
        `Relationships: ${relationships.length}`,
        `Date columns: ${dateColumns.length}`
    ].join("\n");
}

async function runPlannerStrategyAgent(input: {
    query: string;
    schemaForPrompt: any;
    allowedTypes: string[];
    onToken?: (token: string) => void;
    onDraft?: (draft: string) => void;
    critiqueEnabled?: boolean;
}) {
    const { query, schemaForPrompt, allowedTypes, onToken, onDraft, critiqueEnabled } = input;
    const schemaSummary = buildStrategySchemaSummary(schemaForPrompt);
    const systemPrompt = `You are the Strategy Agent for dashboard planning.

USER OBJECTIVE: "${query}"
ALLOWED WIDGET TYPES: ${allowedTypes.join(", ")}

SCHEMA SUMMARY:
${schemaSummary}

TASK:
Provide concise guidance (max 6 bullet lines) about:
- Best story arc for this dashboard
- Key business metrics to prioritize
- Any caution about sparse tables or missing dates
- Suggested grouping grain (daily/weekly/monthly)

Return ONLY the bullet lines.`;

    const response = await streamModelWithRetry([
        new SystemMessage(systemPrompt),
        new HumanMessage("Provide strategy notes only.")
    ], onToken);
    const draft = (response.content as string) || "";
    onDraft?.(draft);
    if (!critiqueEnabled) return draft;
    const formatSpec = `- Bullet line 1
- Bullet line 2
- Bullet line 3 (max 6 lines)`;
    return refinePlannerOutput({
        agentLabel: "Strategy Agent",
        draft,
        formatSpec,
        onToken
    });
}

async function generateDashboardPlan(
    query: string,
    schema: any,
    includeAgentEvent = false,
    onAgentEvent?: (event: PlannerAgentEvent) => void,
    onAgentToken?: (event: PlannerAgentToken) => void,
    onAgentDraft?: (event: PlannerAgentDraft) => void,
    onPlannerMeta?: (event: PlannerMetaEvent) => void
) {
    const filteredSchema = filterSchemaForNonEmptyTables(schema);
    const schemaForPrompt = filteredSchema || schema;
    const { allowedTypes, orderedAllowedTypes, requiredWidgetCount } = getAllowedWidgetTypes(schemaForPrompt);
    const emitToken = (agent: string) => (token: string) => onAgentToken?.({ agent, token });
    const critiqueEnabled = true;

    onAgentEvent?.({ type: "start", agent: "Meta Agent" });
    const metaText = await runPlannerMetaAgent({
        query,
        schemaForPrompt,
        allowedTypes,
        orderedAllowedTypes,
        requiredWidgetCount,
        onToken: emitToken("Meta Agent"),
        onDraft: (content) => onAgentDraft?.({ agent: "Meta Agent", content }),
        critiqueEnabled
    }).catch(() => "").finally(() => onAgentEvent?.({ type: "done", agent: "Meta Agent" }));

    onAgentEvent?.({ type: "start", agent: "Filter Agent" });
    const filterText = await runPlannerFilterAgent({
        query,
        schemaForPrompt,
        allowedTypes,
        orderedAllowedTypes,
        requiredWidgetCount,
        onToken: emitToken("Filter Agent"),
        onDraft: (content) => onAgentDraft?.({ agent: "Filter Agent", content }),
        critiqueEnabled
    }).catch(() => "").finally(() => onAgentEvent?.({ type: "done", agent: "Filter Agent" }));

    let strategyText = "";
    if (shouldRunStrategyAgent(schemaForPrompt, query)) {
        onAgentEvent?.({ type: "start", agent: "Strategy Agent" });
        strategyText = await runPlannerStrategyAgent({
            query,
            schemaForPrompt,
            allowedTypes,
            onToken: emitToken("Strategy Agent"),
            onDraft: (content) => onAgentDraft?.({ agent: "Strategy Agent", content }),
            critiqueEnabled
        }).catch(() => "").finally(() => onAgentEvent?.({ type: "done", agent: "Strategy Agent" }));
    }
    const domainLabel = detectPrimaryIntent(schemaForPrompt, query);
    onPlannerMeta?.({ type: "planner_intents", intents: [domainLabel] });
    const domainAgentName = `${domainLabel} Domain Agent`;
    onAgentEvent?.({ type: "start", agent: domainAgentName });
    const domainText = await runPlannerDomainAgent({
        domainLabel,
        query,
        schemaForPrompt,
        onToken: emitToken(domainAgentName),
        onDraft: (content) => onAgentDraft?.({ agent: domainAgentName, content }),
        critiqueEnabled
    }).catch(() => "").finally(() => onAgentEvent?.({ type: "done", agent: domainAgentName }));
    const { extractDashboardTitle, parseNaturalLanguagePlan } = await import('@/utils/plan-parser');
    const meta = parsePlannerMeta(metaText);
    const filtersFromAgent = parseFiltersOnly(filterText);
    const strategyNotes = [strategyText, domainText].filter(Boolean).join("\n");
    const resolvedFiltersText = resolveFiltersText(filtersFromAgent, buildPlannerFiltersText(schemaForPrompt));

    const perTypeTasks: Array<() => Promise<string>> = [];
    const agentLabels: string[] = ["Meta Agent", "Filter Agent"];
    if (strategyText) agentLabels.push("Strategy Agent");
    agentLabels.push(domainAgentName);
    const typesForAgents = orderedAllowedTypes.length > 0 ? orderedAllowedTypes : allowedTypes;

    typesForAgents.forEach((type) => {
        const label = `${type.toUpperCase()} Content Agent`;
        agentLabels.push(label);
        onAgentEvent?.({ type: "start", agent: label });
        const requiredCount = type === "kpi" ? 4 : 1;
        perTypeTasks.push(() => {
            const runner = type === "kpi"
                ? runPlannerKpiAgent({
                    query,
                    schemaForPrompt,
                    requiredWidgetCount: requiredCount,
                    focusLabel: label,
                    filtersText: resolvedFiltersText,
                    strategyNotes,
                    onToken: emitToken(label),
                    onDraft: (content) => onAgentDraft?.({ agent: label, content }),
                    critiqueEnabled
                })
                : runPlannerSubAgent({
                    query,
                    schemaForPrompt,
                    allowedTypes: [type],
                    orderedAllowedTypes: [type],
                    requiredWidgetCount: requiredCount,
                    focusLabel: label,
                    filtersText: resolvedFiltersText,
                    strategyNotes,
                    onToken: emitToken(label),
                    onDraft: (content) => onAgentDraft?.({ agent: label, content }),
                    critiqueEnabled
                });
            return runner.finally(() => onAgentEvent?.({ type: "done", agent: label }));
        });
    });

    const runWithConcurrency = async <T,>(tasks: Array<() => Promise<T>>, limit: number) => {
        const results: T[] = [];
        let index = 0;
        const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
            while (index < tasks.length) {
                const current = index++;
                results[current] = await tasks[current]();
            }
        });
        await Promise.all(workers);
        return results;
    };

    const concurrencyEnv = Number(process.env.PLANNER_AGENT_CONCURRENCY || process.env.NEXT_PUBLIC_PLANNER_AGENT_CONCURRENCY || 3);
    const concurrency = Number.isFinite(concurrencyEnv) && concurrencyEnv > 0 ? Math.max(1, Math.floor(concurrencyEnv)) : 3;
    const groupResults = await runWithConcurrency(perTypeTasks, concurrency);
    const parsedGroups = groupResults.map((text) => parseNaturalLanguagePlan(text));
    const combined = parsedGroups.flat();
    const ordered = orderWidgetsByType(combined, orderedAllowedTypes);
    const widgets = normalizePlannedWidgets(ordered, schemaForPrompt.schemaInfo || {}, allowedTypes);

    const titleBase = String(query || "").split(/[.!?]/)[0]?.trim();
    const fallbackTitle = titleBase && titleBase.length <= 60 ? `${titleBase} Dashboard` : "AI Analytics Dashboard";
    const title = meta.title || fallbackTitle;
    const purpose = meta.purpose || (query ? `Dashboard plan for: ${query}` : "Auto-generated dashboard plan.");
    const scenarioText = buildScenarioCoverageText(schemaForPrompt, widgets);
    let rawPlan = buildPlanTextFromWidgets({
        title,
        purpose,
        filtersText: resolvedFiltersText,
        widgets,
        scenarioText
    });
    agentLabels.push("Final Plan Agent");
    onAgentEvent?.({ type: "start", agent: "Final Plan Agent" });
    const finalPlanText = await runPlannerFinalAgent({
        query,
        draftPlan: rawPlan,
        allowedTypes,
        orderedAllowedTypes,
        requiredWidgetCount,
        onToken: (token) => onAgentToken?.({ agent: "Final Plan Agent", token }),
        onDraft: (content) => onAgentDraft?.({ agent: "Final Plan Agent", content }),
        critiqueEnabled
    })
        .catch(() => rawPlan)
        .finally(() => onAgentEvent?.({ type: "done", agent: "Final Plan Agent" }));

    const finalWidgets = normalizePlannedWidgets(parseNaturalLanguagePlan(finalPlanText), schemaForPrompt.schemaInfo || {}, allowedTypes);
    const finalTitle = extractDashboardTitle(finalPlanText) || title;
    let finalRawPlan = finalPlanText || rawPlan;

    if (includeAgentEvent) {
        const agentNames = agentLabels.length > 0 ? agentLabels.join(", ") : "Parallel agents";
        finalRawPlan = `${finalRawPlan}\n\nEVENT_STREAM:\n{"type":"planner_agents","content":"${agentNames}"}`;
    }

    return { title: finalTitle, rawPlan: finalRawPlan, widgets: finalWidgets };
}

export async function runDashboardPlanner(query: string, schema: any) {
    console.log("[AGENT] Planning Dashboard Architecture (Pro Mode)...");

    return generateDashboardPlan(query, schema, true);
}

/**
 * STEP 2.5: STREAMING DASHBOARD PLANNER
 * Returns an async generator for streaming the plan text.
 */
export async function* runDashboardPlannerStream(query: string, schema: any) {
    console.log("[AGENT] Planning Dashboard Architecture (Streaming Mode)...");
    type PlannerStreamItem = { kind: "chunk"; chunk: string } | { kind: "event"; event: any };
    const queue: PlannerStreamItem[] = [];
    let resolver: ((value: PlannerStreamItem) => void) | null = null;
    let done = false;

    const push = (value: PlannerStreamItem) => {
        if (resolver) {
            const r = resolver;
            resolver = null;
            r(value);
            return;
        }
        queue.push(value);
    };

    const next = () => new Promise<PlannerStreamItem>((resolve) => {
        if (queue.length > 0) {
            resolve(queue.shift() as PlannerStreamItem);
            return;
        }
        resolver = resolve;
    });

    const emitAgentEvent = (event: PlannerAgentEvent) => {
        push({
            kind: "event", event: {
                type: "planner_agent_status",
                agent: event.agent,
                status: event.type
            }
        });
    };
    const emitAgentToken = (event: PlannerAgentToken) => {
        if (!event?.token) return;
        push({ kind: "event", event: { type: "planner_agent_token", agent: event.agent, token: event.token } });
    };
    const emitAgentDraft = (event: PlannerAgentDraft) => {
        push({ kind: "event", event: { type: "planner_agent_draft", agent: event.agent, content: event.content } });
    };
    const emitPlannerMeta = (event: PlannerMetaEvent) => {
        push({ kind: "event", event });
    };

    const planPromise = generateDashboardPlan(query, schema, false, emitAgentEvent, emitAgentToken, emitAgentDraft, emitPlannerMeta)
        .then((plan) => {
            done = true;
            return plan;
        })
        .catch((err) => {
            done = true;
            throw err;
        });

    while (!done || queue.length > 0) {
        const eventChunk = await next();
        if (eventChunk) {
            yield eventChunk;
        }
    }

    const plan = await planPromise;
    const chunks = String(plan.rawPlan || '').match(/[\s\S]{1,1200}/g) || [];
    for (const chunk of chunks) {
        yield { kind: "chunk", chunk };
    }
}

/**
 * FINALIZER: Converts plan text to structured data.
 * Used at the end of streaming.
 */
export async function finalizePlan(planText: string) {
    const { extractDashboardTitle, parseNaturalLanguagePlan } = await import('@/utils/plan-parser');

    // Safety: Strip typical markdown that confuses the parser
    const withoutEvents = planText.split("EVENT_STREAM:")[0] || planText;
    const cleanPlan = withoutEvents.replace(/\*\*|\*|__/g, '');

    return {
        title: extractDashboardTitle(cleanPlan) || "AI Analytics Dashboard",
        rawPlan: cleanPlan,
        widgets: normalizePlannedWidgets(parseNaturalLanguagePlan(cleanPlan), {})
    };
}

// Deprecated local helpers (moved to @/utils/plan-parser)
// These are kept hidden but we remove them from this file or comment them out if possible.
// Actually, I'll just remove them since I'm already editing the file.

/**
 * STEP 3: QUERY GENERATOR (Production-Grade)
 * Expert PostgreSQL database developer and query optimizer.
 * Generates optimized, safe, and high-performance SQL for every widget.
 */
function parseWidgetDetailsFromPlan(rawPlan: string) {
    if (!rawPlan) return [];
    const cleaned = rawPlan.replace(/\*\*|\*|__|#/g, '');
    const matches = Array.from(cleaned.matchAll(/(?:^|\n)\s*WIDGET\s*\d+[^]*?(?=(?:\n\s*WIDGET\s*\d+)|$)/gi));
    return matches.map((match) => {
        const block = match[0];
        const usesMatch = block.match(/Uses:\s*([^\n]+)/i);
        const filtersMatch = block.match(/Filters applied:\s*([^\n]+)/i);
        const notesMatch = block.match(/Notes:\s*([^\n]+)/i);
        return {
            uses: usesMatch?.[1]?.trim() || "",
            filters: filtersMatch?.[1]?.trim() || "",
            notes: notesMatch?.[1]?.trim() || ""
        };
    });
}

function parseScenarioCoverageFromPlan(rawPlan: string) {
    if (!rawPlan) return "";
    const cleaned = rawPlan.replace(/\*\*|\*|__|#/g, '');
    const match = cleaned.match(/SCENARIO COVERAGE:\s*([\s\S]*?)(?:\nWIDGET\s+\d+:|$)/i);
    return match?.[1]?.trim() || "";
}

function buildAliasMap(sql: string) {
    const map = new Map<string, string>();
    const regex = /\b(from|join)\s+["`\[]?([a-zA-Z0-9_.]+)["`\]]?(?:\s+as)?\s+([a-zA-Z0-9_]+)?/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(sql)) !== null) {
        const rawTable = match[2];
        const table = rawTable?.split('.').pop() || rawTable;
        const alias = match[3] || table;
        if (table) {
            map.set(table, table);
            if (alias) map.set(alias, table);
        }
    }
    return map;
}

function extractJoinPairs(sql: string, aliasMap: Map<string, string>) {
    const pairs: Array<{ leftTable: string; leftColumn: string; rightTable: string; rightColumn: string }> = [];
    const regex = /\bon\s+["`\[]?([a-zA-Z0-9_]+)["`\]]?\.(["`\[]?[a-zA-Z0-9_]+["`\]]?)\s*=\s*["`\[]?([a-zA-Z0-9_]+)["`\]]?\.(["`\[]?[a-zA-Z0-9_]+["`\]]?)/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(sql)) !== null) {
        const leftAlias = match[1];
        const leftColumn = match[2].replace(/["`\[\]]/g, '');
        const rightAlias = match[3];
        const rightColumn = match[4].replace(/["`\[\]]/g, '');
        const leftTable = aliasMap.get(leftAlias) || leftAlias;
        const rightTable = aliasMap.get(rightAlias) || rightAlias;
        if (leftTable && rightTable && leftColumn && rightColumn) {
            pairs.push({ leftTable, leftColumn, rightTable, rightColumn });
        }
    }
    return pairs;
}

function buildRelationshipSet(schema: any) {
    const rels = Array.isArray(schema?.relationships) ? schema.relationships : [];
    const set = new Set<string>();
    rels.forEach((rel: any) => {
        if (rel?.from?.table && rel?.from?.column && rel?.to?.table && rel?.to?.column) {
            const forward = `${rel.from.table}.${rel.from.column}->${rel.to.table}.${rel.to.column}`;
            const reverse = `${rel.to.table}.${rel.to.column}->${rel.from.table}.${rel.from.column}`;
            set.add(forward);
            set.add(reverse);
        }
    });
    return set;
}

function columnIsPrimary(schema: any, table: string, column: string) {
    const info = schema?.schemaInfo?.[table] || schema?.schemaInfo?.[table?.toLowerCase?.()] || schema?.schemaInfo?.[table?.toUpperCase?.()];
    const cols = info?.columns || [];
    const match = cols.find((c: any) => (c?.name || c?.column_name) === column);
    return match?.isPrimary === true;
}

function validateJoinsAgainstSchema(sql: string, schemaForPrompt?: any) {
    if (!schemaForPrompt?.relationships || schemaForPrompt.relationships.length === 0) return { ok: true };
    const aliasMap = buildAliasMap(sql);
    const pairs = extractJoinPairs(sql, aliasMap);
    if (pairs.length === 0) return { ok: true };
    const relSet = buildRelationshipSet(schemaForPrompt);
    for (const pair of pairs) {
        const key = `${pair.leftTable}.${pair.leftColumn}->${pair.rightTable}.${pair.rightColumn}`;
        if (!relSet.has(key)) {
            return { ok: false, error: `Validation failed: join ${key} is not defined in schema relationships.` };
        }
        const leftIsPk = columnIsPrimary(schemaForPrompt, pair.leftTable, pair.leftColumn);
        const rightIsPk = columnIsPrimary(schemaForPrompt, pair.rightTable, pair.rightColumn);
        if (leftIsPk === false && rightIsPk === false) {
            return { ok: false, error: `Validation failed: join ${key} may cause fan-out (no primary key).` };
        }
    }
    return { ok: true };
}

function validateSqlAgainstInstructions(sql: string, connectionString?: string, connectorInstructions?: string, connectorType?: string, schemaForPrompt?: any) {
    const trimmed = normalizeSqlForValidation(sql);
    const startsWithAllowed = /^(select|with|show|explain)\b/i.test(trimmed);
    if (!startsWithAllowed) {
        return { ok: false, error: "Validation failed: SQL must start with SELECT, WITH, SHOW, or EXPLAIN." };
    }
    const semicolonIndex = trimmed.indexOf(";");
    if (semicolonIndex >= 0 && trimmed.slice(semicolonIndex).trim() !== ";") {
        return { ok: false, error: "Validation failed: multiple SQL statements are not allowed." };
    }
    const blocked = ["drop", "delete", "truncate", "update", "insert", "alter", "create", "grant", "revoke"];
    const sanitized = stripSqlLiteralsAndComments(trimmed).toLowerCase();
    if (blocked.some((kw) => new RegExp(`\\b${kw}\\b`, "i").test(sanitized))) {
        return { ok: false, error: "Validation failed: unsafe SQL detected." };
    }
    const lower = String(connectionString || "").toLowerCase();
    const typeLower = String(connectorType || "").toLowerCase();
    const isMssql =
        lower.startsWith("mssql://") ||
        lower.startsWith("sqlserver://") ||
        lower.includes("server=") ||
        lower.includes("data source=") ||
        typeLower.includes("mssql") ||
        typeLower.includes("sql server");
    if (isMssql && /\blimit\s+\d+/i.test(trimmed)) {
        return { ok: false, error: "Validation failed: MSSQL does not support LIMIT. Use TOP or OFFSET/FETCH." };
    }
    if (!isMssql && /\btop\s+\d+/i.test(trimmed)) {
        return { ok: false, error: "Validation failed: PostgreSQL does not support TOP. Use LIMIT." };
    }
    const bans = new Set<string>();
    const requires = new Set<string>();
    if (connectorInstructions) {
        const normalized = connectorInstructions
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
    }
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
    const joinValidation = validateJoinsAgainstSchema(trimmed, schemaForPrompt);
    if (!joinValidation.ok) return joinValidation;
    return { ok: true };
}

export async function runQueryGenerator(
    plan: any,
    schema: any,
    filters: Record<string, any> = {},
    errorLog: Array<{ id: string; title?: string; sql?: string; error: string; timestamp?: string }> = [],
    applyFilters: boolean = false
) {
    console.log("[AGENT] Engineering SQL Queries (Pro Mode)...");
    const filteredSchema = filterSchemaForNonEmptyTables(schema);
    const schemaForPrompt = filteredSchema || schema;
    const connectionString = schemaForPrompt?.connectionString || schemaForPrompt?.dbUrl || schemaForPrompt?.postgresUrl || schemaForPrompt?.mssqlUrl || "";
    const connectorInstructions = schemaForPrompt?.connectorInstructions || "";
    const connectorType = String(schemaForPrompt?.connectorType || schemaForPrompt?.connector?.type || "").toLowerCase();
    const isMssql = (() => {
        const lower = String(connectionString || "").toLowerCase();
        if (lower.startsWith("mssql://") || lower.startsWith("sqlserver://") || lower.includes("server=") || lower.includes("data source=")) {
            return true;
        }
        return connectorType.includes("mssql") || connectorType.includes("sql server");
    })();
    const enforceQueries = async (input: Record<string, string>) => {
        const output: Record<string, string> = { ...input };
        const tasks = Object.entries(output).map(async ([id, sql]) => {
            const widget = (effectiveWidgets || []).find((w: any) => w.id === id);
            let attempt = 0;
            let currentSql = sql;
            while (attempt < 2) {
                const validation = validateSqlAgainstInstructions(currentSql, connectionString, connectorInstructions, connectorType, schemaForPrompt);
                if (validation.ok) break;
                attempt += 1;
                try {
                    const repair = await repairFailedQuery({
                        widgetId: id,
                        widgetTitle: widget?.title || id,
                        widgetType: widget?.type || "unknown",
                        widgetGoal: widget?.goal,
                        originalSql: currentSql,
                        errorMessage: validation.error || "Connector instruction violation",
                        schema: schemaForPrompt,
                        errorLog,
                        connectionString
                    });
                    if (repair?.sql) {
                        currentSql = repair.sql;
                    } else {
                        break;
                    }
                } catch {
                    break;
                }
            }
            const finalCheck = validateSqlAgainstInstructions(currentSql, connectionString, connectorInstructions, connectorType, schemaForPrompt);
            if (!finalCheck.ok) {
                try {
                    const widget = (effectiveWidgets || []).find((w: any) => w.id === id);
                    const repair = await repairFailedQuery({
                        widgetId: id,
                        widgetTitle: widget?.title || id,
                        widgetType: widget?.type || "unknown",
                        widgetGoal: widget?.goal,
                        originalSql: currentSql,
                        errorMessage: finalCheck.error || "Connector instruction violation",
                        schema: schemaForPrompt,
                        errorLog,
                        connectionString
                    });
                    if (repair?.sql) {
                        const recheck = validateSqlAgainstInstructions(repair.sql, connectionString, connectorInstructions, connectorType, schemaForPrompt);
                        if (recheck.ok) {
                            output[id] = repair.sql;
                            return;
                        }
                    }
                } catch {
                    // fallthrough to fallback SQL
                }
                const fallbackForWidget = buildFallbackSql(plan, schemaForPrompt, isMssql)?.sqlMap?.[id];
                output[id] = fallbackForWidget || currentSql;
            } else {
                output[id] = currentSql;
            }
        });
        await Promise.all(tasks);
        return output;
    };

    const escapeSqlLiteral = (value: string) => value.replace(/'/g, "''");
    const getQualifiedColumnType = (qualified: string) => {
        const [table, column] = qualified.split(".");
        if (!table || !column) return null;
        const tableInfo = schemaForPrompt?.schemaInfo?.[table] || schemaForPrompt?.schemaInfo?.[table.toLowerCase()] || schemaForPrompt?.schemaInfo?.[table.toUpperCase()];
        const cols = tableInfo?.columns || [];
        const match = cols.find((c: any) => (c?.name || c?.column_name) === column);
        return (match?.type || match?.data_type || "").toLowerCase();
    };
    const maybeCastTextColumn = (qualified: string) => {
        if (!isMssql) return qualified;
        const type = getQualifiedColumnType(qualified);
        if (!type) return qualified;
        if (type.includes("text") || type.includes("ntext")) {
            return `CAST(${qualified} AS NVARCHAR(MAX))`;
        }
        return qualified;
    };
    const applyFiltersToSql = (sql: string, clauses: string[]) => {
        if (!clauses.length) return sql;
        const trimmed = sql.trim().replace(/;+\s*$/, '');
        const lower = trimmed.toLowerCase();
        const normalizedClauses = clauses.filter((c) => !lower.includes(c.toLowerCase()));
        if (normalizedClauses.length === 0) return `${trimmed};`;

        const keywordPositions = [
            lower.indexOf(" group by "),
            lower.indexOf(" having "),
            lower.indexOf(" order by "),
            lower.indexOf(" limit "),
        ].filter((idx) => idx >= 0);
        const boundary = keywordPositions.length > 0 ? Math.min(...keywordPositions) : trimmed.length;
        const head = trimmed.slice(0, boundary);
        const tail = trimmed.slice(boundary);
        const hasWhere = lower.includes(" where ");
        const joiner = normalizedClauses.join(" AND ");
        const next = hasWhere ? `${head} AND ${joiner}${tail}` : `${head} WHERE ${joiner}${tail}`;
        return `${next};`;
    };
    const ensureWhereBase = (sql: string) => {
        const trimmed = sql.trim().replace(/;+\s*$/, '');
        const lower = trimmed.toLowerCase();
        if (lower.includes(" where ")) return `${trimmed};`;
        const keywordPositions = [
            lower.indexOf(" group by "),
            lower.indexOf(" having "),
            lower.indexOf(" order by "),
            lower.indexOf(" limit "),
        ].filter((idx) => idx >= 0);
        const boundary = keywordPositions.length > 0 ? Math.min(...keywordPositions) : trimmed.length;
        const head = trimmed.slice(0, boundary);
        const tail = trimmed.slice(boundary);
        return `${head} WHERE 1=1${tail};`;
    };
    const formatLiteral = (value: any) => {
        if (value === null || value === undefined) return null;
        if (typeof value === "number") return String(value);
        if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
        return `'${escapeSqlLiteral(String(value))}'`;
    };
    const formatDate = (date: Date) => date.toISOString().slice(0, 10);
    const parseDate = (value?: string) => {
        if (!value) return null;
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    };
    const startOfWeekUtc = (date: Date) => {
        const day = date.getUTCDay();
        const diff = (day + 6) % 7; // Monday as start of week
        const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        start.setUTCDate(start.getUTCDate() - diff);
        return start;
    };
    const startOfMonthUtc = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const startOfYearUtc = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    const addDaysUtc = (date: Date, days: number) => {
        const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        next.setUTCDate(next.getUTCDate() + days);
        return next;
    };
    const resolveDateRange = (preset: string, base: Date) => {
        switch (preset) {
            case "today":
                return { from: formatDate(base), to: formatDate(base) };
            case "this_week": {
                const from = startOfWeekUtc(base);
                return { from: formatDate(from), to: formatDate(base) };
            }
            case "this_month": {
                const from = startOfMonthUtc(base);
                return { from: formatDate(from), to: formatDate(base) };
            }
            case "this_year": {
                const from = startOfYearUtc(base);
                return { from: formatDate(from), to: formatDate(base) };
            }
            case "last_7_days":
                return { from: formatDate(addDaysUtc(base, -6)), to: formatDate(base) };
            case "last_30_days":
                return { from: formatDate(addDaysUtc(base, -29)), to: formatDate(base) };
            case "last_90_days":
                return { from: formatDate(addDaysUtc(base, -89)), to: formatDate(base) };
            default:
                return null;
        }
    };
    const paginationControlKeys = new Set([
        "page",
        "size",
        "pagesize",
        "page_size",
        "offset",
        "rowsonpage",
        "storepage",
        "storesize"
    ]);
    const isPaginationControlKey = (dimension: string) => {
        const key = String(dimension || "").trim();
        if (!key) return false;
        if (key.startsWith("__page:") || key.startsWith("__pageSize:") || key.startsWith("__offset:")) return true;
        const lower = key.toLowerCase();
        if (paginationControlKeys.has(lower)) return true;
        const lastSegment = lower.split(":").pop() || lower;
        return paginationControlKeys.has(lastSegment);
    };
    const buildFilterSqlHints = (resolved: Record<string, any>) => {
        const hints: string[] = [];
        Object.entries(resolved || {}).forEach(([dimension, info]) => {
            const type = info?.type;
            const value = info && typeof info === "object" && "value" in info ? info.value : info;
            const safeDimension = maybeCastTextColumn(dimension);
            const dimensionName = String(dimension || "");
            const hasKey = `__has.${dimensionName}`;
            if (dimensionName.startsWith("__") || isPaginationControlKey(dimensionName)) {
                return;
            }
            const isVerboseColumn = /(settings|config|json|metadata|payload|properties|options)/i.test(dimensionName);
            const rawValueText = Array.isArray(value) ? value.join(",") : String(value ?? "");
            const isVerboseValue = rawValueText.length > 120;
            if (isVerboseColumn || isVerboseValue) {
                return;
            }

            if (type === "date-range") {
                const fromKey = `${dimensionName}.from`;
                const toKey = `${dimensionName}.to`;
                hints.push(`({{__has.${fromKey}}} = 0 OR ${safeDimension} >= {{${fromKey}}})`);
                hints.push(`({{__has.${toKey}}} = 0 OR ${safeDimension} <= {{${toKey}}})`);
                return;
            }

            if (Array.isArray(value)) {
                hints.push(`({{${hasKey}}} = 0 OR ${safeDimension} IN ({{${dimensionName}}}))`);
                return;
            }
            if (type === "search") {
                // Search is handled in the SQL prompt to avoid hard-coding a single column
                return;
            } else {
                hints.push(`({{${hasKey}}} = 0 OR ${safeDimension} = {{${dimensionName}}})`);
            }
        });
        return hints;
    };

    const pickTableSortColumn = (widget: any) => {
        const table = widget?.primaryTable
            || (schemaForPrompt?.filterCandidates?.primaryDate?.table)
            || Object.keys(schemaForPrompt?.schemaInfo || {})[0];
        if (!table) return null;
        const tableInfo = schemaForPrompt?.schemaInfo?.[table];
        const cols = tableInfo?.columns || [];
        const primaryDate = schemaForPrompt?.filterCandidates?.primaryDate;
        if (primaryDate?.table === table && primaryDate?.column) {
            return `${table}.${primaryDate.column}`;
        }
        const pk = cols.find((c: any) => c?.isPrimary)?.name || cols.find((c: any) => (c?.name || '').toLowerCase() === 'id')?.name;
        if (pk) return `${table}.${pk}`;
        const temporal = cols.find((c: any) => c?.isTemporal)?.name;
        if (temporal) return `${table}.${temporal}`;
        return null;
    };

    const pickTableTieBreakerColumn = (widget: any, primarySortColumn?: string | null) => {
        const table = widget?.primaryTable
            || (schemaForPrompt?.filterCandidates?.primaryDate?.table)
            || Object.keys(schemaForPrompt?.schemaInfo || {})[0];
        if (!table) return null;
        const tableInfo = schemaForPrompt?.schemaInfo?.[table];
        const cols = tableInfo?.columns || [];
        const pk = cols.find((c: any) => c?.isPrimary)?.name || cols.find((c: any) => (c?.name || '').toLowerCase() === 'id')?.name;
        const candidate = pk ? `${table}.${pk}` : null;
        if (!candidate) return null;
        if (primarySortColumn && String(primarySortColumn).toLowerCase() === String(candidate).toLowerCase()) {
            return null;
        }
        return candidate;
    };

    const normalizeSqlForWidget = (sql: string, widget: any) => {
        if (!sql) return sql;
        let cleaned = String(sql).trim();
        const hasComment = /\/\*[\s\S]*?\*\//.test(cleaned) || /^\s*--/.test(cleaned);
        if (!hasComment) {
            cleaned = `/* widget: ${widget?.id || "unknown"} */\n${cleaned}`;
        }

        const isTable = widget?.type === "table";
        if (!isTable) return cleaned;

        const sizeToken = widget?.id ? `{{size:${widget.id}}}` : "{{size}}";
        const offsetToken = widget?.id ? `{{offset:${widget.id}}}` : "{{offset}}";
        const sortColumn = pickTableSortColumn(widget);
        const tieBreakerColumn = pickTableTieBreakerColumn(widget, sortColumn);
        const resolveColumnRef = (candidate: string | null) => {
            if (!candidate) return null;
            const col = candidate.split(".").pop() || candidate;
            const colEscaped = col.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const aliasMatch = cleaned.match(new RegExp(`\\b([a-zA-Z_][\\w]*)\\.${colEscaped}\\b`, "i"));
            if (aliasMatch?.[0]) return aliasMatch[0];
            const fullEscaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (new RegExp(`\\b${fullEscaped}\\b`, "i").test(cleaned)) return candidate;
            if (new RegExp(`\\b${colEscaped}\\b`, "i").test(cleaned)) return col;
            return null;
        };
        const resolvedSortColumn = resolveColumnRef(sortColumn);
        const resolvedTieBreakerColumn = resolveColumnRef(tieBreakerColumn);
        const hasOrderBy = /\border\s+by\b/i.test(cleaned);
        const orderClause = !hasOrderBy && resolvedSortColumn ? ` ORDER BY ${resolvedSortColumn} DESC` : "";
        const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const hasStableSort = Boolean(
            hasOrderBy &&
            resolvedSortColumn &&
            new RegExp(`\\b${escapeRegex(resolvedSortColumn)}\\b`, "i").test(cleaned)
        );
        const stableOrderSuffix = hasOrderBy && resolvedSortColumn && !hasStableSort ? `, ${resolvedSortColumn} DESC` : "";
        const hasTieBreakerInOrder = Boolean(
            hasOrderBy &&
            resolvedTieBreakerColumn &&
            new RegExp(`\\b${escapeRegex(resolvedTieBreakerColumn)}\\b`, "i").test(cleaned)
        );
        const tieBreakerSuffix = hasOrderBy && resolvedTieBreakerColumn && !hasTieBreakerInOrder
            ? `, ${resolvedTieBreakerColumn} DESC`
            : "";
        const tieBreakerForNewOrder = !hasOrderBy && resolvedTieBreakerColumn ? `, ${resolvedTieBreakerColumn} DESC` : "";

        if (isMssql) {
            cleaned = cleaned.replace(/\bTOP\s+\d+\b/i, "").trim();
            cleaned = cleaned.replace(/\bLIMIT\s+[^\s;]+(\s+OFFSET\s+[^\s;]+)?\b/i, "").trim();
            cleaned = cleaned.replace(/\bOFFSET\s+[^\s;]+\s+ROWS\s+FETCH\s+NEXT\s+[^\s;]+\s+ROWS\s+ONLY\b/i, "").trim();
            const orderBy = hasOrderBy || resolvedSortColumn ? "" : " ORDER BY (SELECT NULL)";
            const trimmed = cleaned.replace(/;+\s*$/, "");
            return `${trimmed}${stableOrderSuffix}${tieBreakerSuffix}${orderClause}${tieBreakerForNewOrder}${orderBy} OFFSET ${offsetToken} ROWS FETCH NEXT ${sizeToken} ROWS ONLY;`;
        }

        cleaned = cleaned.replace(/\bLIMIT\s+[^\s;]+(\s+OFFSET\s+[^\s;]+)?\b/i, "").trim();
        cleaned = cleaned.replace(/\bOFFSET\s+[^\s;]+\b/i, "").trim();

        const trimmed = cleaned.replace(/;+\s*$/, "");
        cleaned = `${trimmed}${stableOrderSuffix}${tieBreakerSuffix}${orderClause}${tieBreakerForNewOrder}\nLIMIT ${sizeToken} OFFSET ${offsetToken};`;
        return cleaned;
    };

    const polishQueries = (queries: Record<string, string>) => {
        const widgetMap = new Map((effectiveWidgets || []).map((w: any) => [w.id, w]));
        return Object.fromEntries(
            Object.entries(queries).map(([id, sql]) => [id, normalizeSqlForWidget(sql, widgetMap.get(id))])
        );
    };

    let effectiveWidgets = Array.isArray(plan.widgets) ? plan.widgets : [];
    const rawPlan = typeof plan.rawPlan === 'string' ? plan.rawPlan : '';
    if (effectiveWidgets.length === 0 && rawPlan) {
        const { parseNaturalLanguagePlan } = await import('@/utils/plan-parser');
        effectiveWidgets = parseNaturalLanguagePlan(rawPlan);
    }
    const widgetDetails = parseWidgetDetailsFromPlan(rawPlan);
    const scenarioCoverage = parseScenarioCoverageFromPlan(rawPlan);

    const tables = Object.keys(schemaForPrompt.schemaInfo || {});

    const truncate = (text: string, max = 4000) => text.length > max ? `${text.slice(0, max)}...` : text;
    const clampSection = (label: string, text: string, max: number) => {
        const trimmed = truncate(text, max);
        return `${label}\n${trimmed}`;
    };

    // Simplified schema for LLM optimized reading to prevent hallucinations (hard cap to avoid token overflow)
    const simplifiedSchema = Object.entries(schemaForPrompt.schemaInfo || {})
        .slice(0, 3) // tighter cap to avoid prompt explosion
        .map(([table, info]: [string, any]) => {
            const cols = (info.columns || []).slice(0, 4).map((c: any) => {
                const pk = c.isPrimary ? 'PK' : '';
                return `${c.name} (${c.type}${pk ? ', ' + pk : ''})`;
            }).join(', ');
            return `TABLE "${table}" [${cols}]`;
        }).join('\n');

    const widgetSummaryLines = (effectiveWidgets || []).map((w: any, idx: number) => {
        const title = w?.title ? String(w.title).slice(0, 80) : '';
        const metric = w?.metric ? String(w.metric).slice(0, 40) : '';
        const dim = w?.dim ? String(w.dim).slice(0, 40) : '';
        const details = widgetDetails[idx] || {};
        const uses = details.uses ? ` | uses=${details.uses}` : '';
        const filters = details.filters ? ` | filters=${details.filters}` : '';
        const notes = details.notes ? ` | notes=${details.notes}` : '';
        return `${idx + 1}) ${w.id} | ${w.type} | ${title} | metric=${metric} | dim=${dim}${uses}${filters}${notes}`;
    });

    const widgets = truncate(widgetSummaryLines.join('\n'), 4000);
    const relationships = truncate((schemaForPrompt.relationships || [])
        .slice(0, 3)
        .map((r: any) => {
            if (!r?.from?.table || !r?.to?.table) return '';
            return `${r.from.table}.${r.from.column || ''} -> ${r.to.table}.${r.to.column || ''}`;
        })
        .filter(Boolean)
        .join('\n'), 600);

    // Aggressively trim sample data (or omit)
    const sampleData = schemaForPrompt.sampleData || {};
    const sampleDataText = truncate(JSON.stringify(Object.fromEntries(
        Object.entries(sampleData)
            .slice(0, 1)
            .map(([k, v]: [any, any]) => [k, (v || []).slice(0, 1)])
    )), 500);
    const recentErrors = truncate(JSON.stringify((errorLog || []).slice(0, 15)), 1200);
    const connectorInstructionsTrimmed = truncate(String(schemaForPrompt.connectorInstructions || ''), 1200);

    // Data-Aware Time Anchoring
    const referenceDate = findLatestDate(sampleData);
    const timeContext = referenceDate
        ? `DATA IS HISTORICAL. Treat '${referenceDate}' as the current date for relative time filters (e.g. "last 30 days" = reference date - 30 days). DO NOT use CURRENT_DATE.`
        : isMssql
            ? `DATA IS LIVE. Use GETDATE() for relative time filters.`
            : `DATA IS LIVE. Use CURRENT_DATE for relative time filters.`;
    const dateContext = buildDateContext(referenceDate);
    const sqlHints = buildSqlPromptHints(schemaForPrompt);

    // Generate dynamic SQL patterns for each widget
    const widgetPatternMap = new Map<string, string>();
    (effectiveWidgets || []).forEach((w: any) => {
        const bestPatterns = sqlHints.findBestPatterns(w.goal || w.title || '', w.table || '');
        if (bestPatterns.length > 0) {
            const guidance = sqlHints.generateDynamicGuidance(w, bestPatterns, isMssql);
            widgetPatternMap.set(w.id, guidance);
        }
    });

    // Build widget-specific dynamic guidance section
    const dynamicGuidanceSections: string[] = [];
    widgetPatternMap.forEach((guidance, widgetId) => {
        dynamicGuidanceSections.push(`\n--- WIDGET ${widgetId} DYNAMIC PATTERNS ---\n${guidance}\n`);
    });
    const dynamicGuidanceText = dynamicGuidanceSections.join('\n');

    const baseDate = parseDate(referenceDate || undefined) || new Date();
    const hasActiveRuntimeFilters = Object.entries(filters || {}).some(([dimension, value]) => {
        if (isPaginationControlKey(dimension)) return false;
        if (Array.isArray(value)) return value.length > 0;
        if (value && typeof value === "object") {
            if ("from" in value || "to" in value) {
                return Boolean((value as any).from || (value as any).to || (value as any).preset);
            }
            if ("value" in value) {
                const inner = (value as any).value;
                if (Array.isArray(inner)) return inner.length > 0;
                return inner !== undefined && inner !== null && String(inner).trim() !== "";
            }
        }
        return value !== undefined && value !== null && String(value).trim() !== "";
    });
    const hasPlanDefaultFilters = Array.isArray(plan?.filters) && plan.filters.some((f: any) => {
        const value = f?.value;
        if (Array.isArray(value)) return value.length > 0;
        if (value && typeof value === "object") {
            if ("from" in value || "to" in value) {
                return Boolean(value.from || value.to || value.preset);
            }
        }
        return value !== undefined && value !== null && String(value).trim() !== "";
    });
    const shouldApplyFilters = Boolean(applyFilters || hasActiveRuntimeFilters || hasPlanDefaultFilters);
    const planFilters = shouldApplyFilters && Array.isArray(plan?.filters) && plan.filters.length > 0
        ? plan.filters
        : [];
    const resolvedFilters: Record<string, any> = shouldApplyFilters
        ? (planFilters.length > 0
            ? planFilters.reduce((acc: Record<string, any>, f: any) => {
                const dimension = f?.dimension;
                if (!dimension) return acc;
                if (isPaginationControlKey(dimension)) return acc;
                const rawValue = Object.prototype.hasOwnProperty.call(filters, dimension)
                    ? filters[dimension]
                    : f?.value;

                const type = String(f?.type || "").toLowerCase();
                if (type === "date-range" || type === "date_range") {
                    const preset = typeof rawValue === "string" ? rawValue : rawValue?.preset;
                    const customFrom = rawValue?.from;
                    const customTo = rawValue?.to;
                    const range = preset && preset !== "custom"
                        ? resolveDateRange(preset, baseDate)
                        : (customFrom || customTo ? { from: customFrom, to: customTo } : null);
                    acc[dimension] = {
                        type: "date-range",
                        value: rawValue,
                        preset: preset || "custom",
                        range
                    };
                    return acc;
                }

                if (type.includes("multi")) {
                    const value = Array.isArray(rawValue) ? rawValue : (rawValue !== undefined ? [rawValue] : []);
                    acc[dimension] = { type: "multi-select", value };
                    return acc;
                }
                if (type.includes("entity")) {
                    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
                    acc[dimension] = { type: "entity", value };
                    return acc;
                }

                acc[dimension] = { type: f?.type || "select", value: rawValue };
                return acc;
            }, {})
            : (filters || {}))
        : {};

    const searchEntry = Object.entries(resolvedFilters).find(([, info]) => info?.type === "search");
    const searchParamKey = searchEntry ? String(searchEntry[0]) : "__search";
    let searchValue = searchEntry ? String((searchEntry[1] as any)?.value ?? "").trim() : "";
    if (!searchValue) {
        searchValue = String(filters?.__search ?? "").trim();
    }
    const requestedSearchColumn = String(filters?.__searchColumn ?? "").trim().toLowerCase();
    const allSearchCandidates = Array.isArray(schemaForPrompt?.filterCandidates?.searchColumns)
        ? schemaForPrompt.filterCandidates.searchColumns
        : [];
    const searchCandidates = requestedSearchColumn
        ? allSearchCandidates.filter((candidate: any) => {
            const table = String(candidate?.table || "").trim().toLowerCase();
            const column = String(candidate?.column || "").trim().toLowerCase();
            if (!column) return false;
            const qualified = `${table}.${column}`;
            return (
                column === requestedSearchColumn
                || qualified === requestedSearchColumn
                || qualified.endsWith(`.${requestedSearchColumn}`)
            );
        })
        : allSearchCandidates;
    const effectiveSearchCandidates = searchCandidates.length > 0 ? searchCandidates : allSearchCandidates;
    const searchCandidateText = effectiveSearchCandidates
        .slice(0, 8)
        .map((c: any) => `${c.table}.${c.column}`)
        .join(", ") || "None";

    // Enforce primary date filter column when a date-range filter is present
    const primaryDate = schemaForPrompt?.filterCandidates?.primaryDate;
    if (primaryDate?.table && primaryDate?.column) {
        const primaryDimension = `${primaryDate.table}.${primaryDate.column}`;
        const dateEntries = Object.entries(resolvedFilters).filter(([, info]) => info?.type === "date-range");
        if (dateEntries.length > 0) {
            const [firstKey, firstVal] = dateEntries[0];
            if (firstKey !== primaryDimension) {
                resolvedFilters[primaryDimension] = firstVal;
                delete resolvedFilters[firstKey];
            }
        }
    }

    const activeFilters = truncate(JSON.stringify(resolvedFilters), 800);
    const filterSqlHintList = buildFilterSqlHints(resolvedFilters);
    if (effectiveSearchCandidates.length > 0) {
        const searchCols = effectiveSearchCandidates
            .map((c: any) => `${c.table}.${c.column}`)
            .slice(0, 5)
            .map((col: string) => maybeCastTextColumn(col));
        const orClause = isMssql
            ? searchCols.map((col: string) => `${col} LIKE '%' + {{${searchParamKey}}} + '%'`).join(" OR ")
            : searchCols.map((col: string) => `${col} ILIKE '%' || {{${searchParamKey}}} || '%'`).join(" OR ");
        if (orClause) {
            filterSqlHintList.push(`({{__has.${searchParamKey}}} = 0 OR (${orClause}))`);
        }
    }
    const filterSqlHints = filterSqlHintList.join("\n") || "NONE";
    const applyFiltersToQueries = (queries: Record<string, string>) => {
        if (!shouldApplyFilters || filterSqlHintList.length === 0) return queries;
        return Object.fromEntries(
            Object.entries(queries).map(([id, sql]) => {
                const baseSql = ensureWhereBase(sql);
                return [id, applyFiltersToSql(baseSql, filterSqlHintList)];
            })
        );
    };

    const systemPrompt = isMssql ? `You are SQL Agent, a Senior SQL Server (MSSQL) Engineer and query optimizer.
Connector instructions are mandatory and override any conflicting guidance.

### DATABASE CONNECTION INFO
Type: Microsoft SQL Server (MSSQL)
${connectorInstructionsTrimmed ? `Special Instructions: ${connectorInstructionsTrimmed}` : ''}

### HELPER FUNCTION REFERENCE
**Date Functions:**
- Get today's date: CAST(GETDATE() AS DATE) or CONVERT(DATE, GETDATE())
- Get current timestamp: GETDATE()
- Add days: DATEADD(day, N, date_col)
- Subtract days: DATEADD(day, -N, date_col)
- Date difference in days: DATEDIFF(day, start_date, end_date)
- Truncate to month: DATEADD(month, DATEDIFF(month, 0, date_col), 0)
- Truncate to year: DATEADD(year, DATEDIFF(year, 0, date_col), 0)
- Format date: CONVERT(VARCHAR, date_col, 120) -- yields YYYY-MM-DD HH:MM:SS

**String Functions:**
- Case-insensitive LIKE: col LIKE '%term%'
- Concatenate: col1 + ' ' + col2
- Uppercase: UPPER(col)
- Lowercase: LOWER(col)
- Trim: LTRIM(RTRIM(col))
- Substring: SUBSTRING(col, start, length)

**Aggregation Helpers:**
- Safe division: numerator / NULLIF(denominator, 0)
- Handle NULL: ISNULL(col, default_value) or COALESCE(col, default_value)
- Conditional count: COUNT(CASE WHEN condition THEN 1 END)
- Running total: SUM(col) OVER (ORDER BY date_col)
- Row number: ROW_NUMBER() OVER (ORDER BY col)

**Pagination:**
- TOP N: SELECT TOP N * FROM table
- OFFSET/FETCH: OFFSET N ROWS FETCH NEXT M ROWS ONLY

### CRITICAL: SQL SERVER SYNTAX RULES (MANDATORY)
1. **NO LIMIT** - Use TOP or OFFSET/FETCH.
2. **DATE MATH** - Use GETDATE(), DATEADD, DATEDIFF.
3. **DATE TRUNC** - Use DATEADD(day, DATEDIFF(day, 0, col), 0) for day, DATEADD(month, DATEDIFF(month, 0, col), 0) for month.
4. **TEXT/NText** - If comparing text/ntext, CAST to NVARCHAR(MAX).
5. **IDENTIFIERS** - Use [Table] and [Column] when needed.
6. **NO ILIKE** - Use LIKE with proper collation if needed.
7. **Handle NULLs** - Use ISNULL or COALESCE.
8. **Explicit Aggregations** - Every non-aggregated column must be in GROUP BY.
9. **Division by Zero** - Protect divisions: numerator / NULLIF(denominator, 0).

### DATABASE SCHEMA (STRICT TRUTH)
${simplifiedSchema}

### RELATIONSHIPS (STRICT JOIN LOGIC)
${relationships}

### TIME CONTEXT (CRITICAL)
${timeContext}

### DATE CONTEXT (UTC)
${dateContext.summary}

### DATA MODEL HINTS
${sqlHints.summary}

${connectorInstructionsTrimmed ? `### CONNECTOR INSTRUCTIONS\n${connectorInstructionsTrimmed}\n` : ''}

### DATA PREVIEW (SAMPLE RECORDS)
${sampleDataText}

### DASHBOARD PLAN (STRUCTURED WIDGETS, TRUNCATED)
${widgets}

### ACTIVE FILTERS (APPLY EXACTLY IN WHERE CLAUSES)
- JSON: ${activeFilters || "{}"}
- If an array filter is empty, do not filter on that dimension.
- Date filters must use BETWEEN with the provided range when available.
- If a date-range filter includes "range.from"/"range.to", use those values directly (do not recalculate).
- REQUIRED WHERE CONDITIONS (apply ALL when present; AND together):
${filterSqlHints}
- Runtime values must use placeholders, not hardcoded literals.
- Preferred predicate guard pattern: ({{__has.<param_key>}} = 0 OR column = {{<param_key>}}).

### DYNAMIC QUERY PATTERNS (Widget-Specific Templates)
${dynamicGuidanceText || 'No specific patterns matched. Use general SQL best practices.'}

### API-STYLE CONTRACT (BACKEND-LIKE BEHAVIOR)
- Treat table/detail widgets like API list endpoints.
- Validate and clamp pagination inputs in SQL logic: page >= 0, page_size between 1 and 100, defaults page=0 and page_size=25 when missing.
- Only use filter and sort fields that exist in schema or widget config; ignore unsupported fields.
- Search value must be length 2-100; if outside bounds, ignore search filter.
- Prefer parameterized optional predicates (e.g., @p_q IS NULL OR [name] LIKE '%' + @p_q + '%').
- For paginated detail outputs, include COUNT(*) OVER() AS total_count for consistent pagination metadata.
- Always apply deterministic ORDER BY before OFFSET/FETCH (fallback to created/date/id column from schema when needed).
- Use dynamic template placeholders instead of hardcoded literals for runtime values: {{status}}, {{created_from}}, {{created_to}}, {{__search}}, {{size}}, {{offset}}.

### SEARCH FILTER (GLOBAL)
- Search value: "${searchValue || ""}"
- Apply search to the most relevant text column for each widget (prefer widget primary table).
- Candidate columns (from schema): ${searchCandidateText}
- If search value is empty, do not apply search.

### RECENT SQL ERRORS (FIX THESE PATTERNS)
${recentErrors || "[]"}
- Avoid repeating these failures. Validate table/column names and data types against schema.
- Explicitly double-check every error message and adjust queries to prevent the same failure.

### SCENARIO COVERAGE (FROM PLAN)
${scenarioCoverage || "Not provided"}

### Your Mission
Generate **one optimized, production-grade SQL query for each widget** in the dashboard plan.
You MUST provide queries for exactly these IDs: ${effectiveWidgets.map((w: any) => w.id).join(', ')}.

### Phase 1: Pre-Query Validation (Mandatory)
1. Verify table names exist in schema; if a widget uses a non-existent table, do not guess.
2. Verify column names exist; if mismatch, pick the closest column from schema and update query accordingly.
3. Verify relationships match schema direction; join only on FK -> PK as provided.
4. Check data types using schema and sample values; do not SUM text or apply date functions to non-dates.

### Phase 2: Build Query Step-by-Step
1. Start FROM with the primary fact table.
2. Add JOINs only when needed, using aliases and FK -> PK mappings.
3. Apply WHERE filters from widget notes; match exact status/category values from samples. If the plan mentions a relative time period (e.g. "last month") and no explicit date filter is provided, apply a sensible relative range using DATE CONTEXT and PRIMARY_DATE.
4. Add SELECT columns and aggregations; use ISNULL/COALESCE on sums/avgs.
5. Add GROUP BY for all non-aggregated select columns. Never put aggregate expressions in GROUP BY.
6. Add ORDER BY for meaningful sorting.
7. Use TOP 10 for top-N charts; TOP 100 for detail tables.

### Phase 3: Validation Rules (Must Check All)
- All tables/columns exist exactly as in schema.
- Joins follow provided relationships.
- GROUP BY includes every non-aggregated select column.
- Data types match operations.
- WHERE uses exact values from sample data (case-sensitive).
- Do not invent columns; if you need a unique entity key, use the actual primary key or obvious id column from the schema.

### Formatting Rules
- Always include a SQL comment identifying the widget.
- Use explicit JOINs with aliases.
- Do not use SELECT *.
- Use COALESCE/ISNULL for aggregates that can return NULL.
- Apply time filters based on the widget notes.
- Alias EVERY select expression with a meaningful snake_case name.
- Do not AVG timestamps directly; to average durations use DATEDIFF with DATEADD.

### Simplicity & Professionalism
- Prefer the simplest correct query; avoid unnecessary filters or joins.
- Do NOT filter on settings/config/JSON/blob-like columns unless explicitly required by the widget.
- Avoid verbose IN lists; cap to a small, meaningful set.
- Keep WHERE clauses focused on business-relevant filters (date + 1–2 dimensions).

### Best Practices (MSSQL)
- Keep filters SARGable (avoid wrapping indexed columns in functions in WHERE).
- Prefer explicit columns; only return fields required for the widget.
- Use TOP with ORDER BY for top-N charts.
- Avoid ORDER BY in subqueries unless paired with TOP/OFFSET.
- Use appropriate date boundaries (>= start AND < end) when possible.

### Output Rules (Strict JSON)
Return a valid JSON array of objects. Do not wrap in markdown code blocks.
Example:
[
  { "id": "w1", "sql": "SELECT COUNT(*) AS total FROM [table]" }
]`
        : `You are SQL Agent, a Senior PostgreSQL Engineer and query optimizer.

### DATABASE CONNECTION INFO
Type: PostgreSQL
${connectorInstructionsTrimmed ? `Special Instructions: ${connectorInstructionsTrimmed}` : ''}

### HELPER FUNCTION REFERENCE
**Date Functions:**
- Get today's date: CURRENT_DATE
- Get current timestamp: NOW() or CURRENT_TIMESTAMP
- Add days: date_col + INTERVAL 'N days'
- Subtract days: date_col - INTERVAL 'N days'
- Date difference in days: (end_date::date - start_date::date)
- Truncate to day: DATE_TRUNC('day', date_col)
- Truncate to month: DATE_TRUNC('month', date_col)
- Truncate to year: DATE_TRUNC('year', date_col)
- Extract day/month/year: EXTRACT(DAY FROM date_col), EXTRACT(MONTH FROM date_col), EXTRACT(YEAR FROM date_col)
- Format date: TO_CHAR(date_col, 'YYYY-MM-DD')

**String Functions:**
- Case-insensitive LIKE: col ILIKE '%term%'
- Concatenate: col1 || ' ' || col2 or CONCAT(col1, ' ', col2)
- Uppercase: UPPER(col)
- Lowercase: LOWER(col)
- Trim: TRIM(col)
- Substring: SUBSTRING(col FROM start FOR length)
- Replace: REPLACE(col, 'old', 'new')

**Aggregation Helpers:**
- Safe division: numerator / NULLIF(denominator, 0)
- Handle NULL: COALESCE(col, default_value)
- Conditional count: COUNT(*) FILTER (WHERE condition)
- Conditional sum: SUM(CASE WHEN condition THEN col ELSE 0 END)
- Running total: SUM(col) OVER (ORDER BY date_col)
- Row number: ROW_NUMBER() OVER (ORDER BY col)
- Rank: RANK() OVER (ORDER BY col)

**Pagination:**
- LIMIT: LIMIT N
- OFFSET: OFFSET N LIMIT M

### CRITICAL: POSTGRESQL SYNTAX RULES (MANDATORY)
1. **NO DATEDIFF()** - This function DOES NOT EXIST in PostgreSQL.
   - USE: \`date1 - date2\` for the difference in days.
   - Example: \`CURRENT_DATE - created_at\`
2. **NO window functions inside aggregates** - You cannot do \`SUM(count(*) OVER (...))\`. 
   - USE a Common Table Expression (CTE) if you need to aggregate window results.
6. **NO sum(boolean)** - You cannot sum a boolean column directly. 
   - USE: \`SUM(CASE WHEN col THEN 1 ELSE 0 END)\` or \`COUNT(*) FILTER(WHERE col)\`.
7. **Handle NULLs** - Use \`COALESCE(SUM(col), 0)\` for metrics to avoid returning null to the UI.
8. **Explicit Aggregations** - Every column in SELECT must either be in GROUP BY or be an aggregate function.
9. **Division by Zero** - Protect divisions: \`numerator / NULLIF(denominator, 0)\`.
10. **COALESCE TYPE SAFETY** - PostgreSQL will error if you \`COALESCE(interval, 0)\`.
    - If calculating days difference using \`(A - B)\` where A or B are TIMESTAMPS, it returns an \`interval\`.
    - You MUST cast to date FIRST (\`A::date - B::date\`) to get an integer, OR cast the interval to an integer: \`EXTRACT(DAY FROM (A - B))::integer\`.
    - Always ensure your \`COALESCE\` arguments are the same type.

### DATABASE SCHEMA (STRICT TRUTH)
${simplifiedSchema}

### RELATIONSHIPS (STRICT JOIN LOGIC)
${relationships}

### TIME CONTEXT (CRITICAL)
${timeContext}

### DATE CONTEXT (UTC)
${dateContext.summary}

### DATA MODEL HINTS
${sqlHints.summary}

${connectorInstructionsTrimmed ? `### CONNECTOR INSTRUCTIONS\n${connectorInstructionsTrimmed}\n` : ''}

### DATA PREVIEW (SAMPLE RECORDS)
${sampleDataText}

### DASHBOARD PLAN (STRUCTURED WIDGETS, TRUNCATED)
${widgets}

### ACTIVE FILTERS (APPLY EXACTLY IN WHERE CLAUSES)
- JSON: ${activeFilters || "{}"}
- If an array filter is empty, do not filter on that dimension.
- Date filters must use BETWEEN with the provided range when available.
- If a date-range filter includes "range.from"/"range.to", use those values directly (do not recalculate).
- REQUIRED WHERE CONDITIONS (apply ALL when present; AND together):
${filterSqlHints}
- Runtime values must use placeholders, not hardcoded literals.
- Preferred predicate guard pattern: ({{__has.<param_key>}} = 0 OR column = {{<param_key>}}).

### DYNAMIC QUERY PATTERNS (Widget-Specific Templates)
${dynamicGuidanceText || 'No specific patterns matched. Use general SQL best practices.'}

### API-STYLE CONTRACT (BACKEND-LIKE BEHAVIOR)
- Treat table/detail widgets like API list endpoints.
- Validate and clamp pagination inputs in SQL logic: page >= 0, page_size between 1 and 100, defaults page=0 and page_size=25 when missing.
- Only use filter and sort fields that exist in schema or widget config; ignore unsupported fields.
- Search value must be length 2-100; if outside bounds, ignore search filter.
- Prefer parameterized optional predicates (e.g., $1::text IS NULL OR "name" ILIKE '%' || $1 || '%').
- For paginated detail outputs, include COUNT(*) OVER() AS total_count for consistent pagination metadata.
- Always apply deterministic ORDER BY before LIMIT/OFFSET (fallback to created/date/id column from schema when needed).
- Use dynamic template placeholders instead of hardcoded literals for runtime values: {{status}}, {{created_from}}, {{created_to}}, {{__search}}, {{size}}, {{offset}}.

### RECENT SQL ERRORS (FIX THESE PATTERNS)
${recentErrors || "[]"}
- Avoid repeating these failures. Validate table/column names and data types against schema.
- Explicitly double-check every error message and adjust queries to prevent the same failure. For example:
  - If errors mention missing columns/tables, select only columns present in \`schemaInfo\`.
  - If errors mention type casts or aggregates, adjust casts/aggregations accordingly.
  - If errors mention permissions or disallowed statements, restrict to SELECT/CTEs only.

### Your Mission
Generate **one optimized, production-grade SQL query for each widget** in the dashboard plan.
You MUST provide queries for exactly these IDs: ${effectiveWidgets.map((w: any) => w.id).join(', ')}.

### Phase 1: Pre-Query Validation (Mandatory)
1. Verify table names exist in schema; if a widget uses a non-existent table, do not guess.
2. Verify column names exist; if mismatch, pick the closest column from schema and update query accordingly.
3. Verify relationships match schema direction; join only on FK -> PK as provided.
4. Check data types using schema and sample values; do not SUM text or apply date functions to non-dates.

### Phase 2: Build Query Step-by-Step
1. Start FROM with the primary fact table.
2. Add JOINs only when needed, using aliases and FK -> PK mappings.
3. Apply WHERE filters from widget notes; match exact status/category values from samples. If the plan mentions a relative time period (e.g. "last month") and no explicit date filter is provided, apply a sensible relative range using DATE CONTEXT and PRIMARY_DATE.
4. Add SELECT columns and aggregations; use COALESCE on sums/avgs.
5. Add GROUP BY for all non-aggregated select columns. Never put aggregate expressions in GROUP BY.
6. Add ORDER BY for meaningful sorting.
7. Add LIMIT for charts/tables (10 for top-N, 50-100 for detail tables).

### Phase 3: Validation Rules (Must Check All)
- All tables/columns exist exactly as in schema.
- Joins follow provided relationships.
- GROUP BY includes every non-aggregated select column.
- Data types match operations.
- WHERE uses exact values from sample data (case-sensitive).
- No alias mixing (use aliases consistently).
 - Do not invent columns; if you need a unique entity key, use the actual primary key or obvious id column from the schema. Never use clients.id unless the schema lists it. Use COUNT(*) or COUNT(DISTINCT <existing column>) if unsure.

### Formatting Rules
- Always include a SQL comment identifying the widget.
- Use explicit JOINs with aliases.
- Do not use SELECT *.
- Use COALESCE for aggregates that can return NULL.
- Apply time filters based on the widget notes.
- Alias EVERY select expression with a meaningful snake_case name. Never return unnamed columns (avoid ?column?).
- Use descriptive aliases that match the metric intent (e.g., total_clients, active_clients, churn_rate, daily_activations, device_type, activation_status); avoid generic names like count or value.
- Do not AVG timestamps directly; to average durations use EXTRACT(EPOCH FROM ts) / 60.0 (or similar) and AVG that numeric expression.

### Simplicity & Professionalism
- Prefer the simplest correct query; avoid unnecessary filters or joins.
- Do NOT filter on settings/config/JSON/blob-like columns unless explicitly required by the widget.
- Avoid verbose IN lists; cap to a small, meaningful set.
- Keep WHERE clauses focused on business-relevant filters (date + 1–2 dimensions).

### Best Practices (PostgreSQL)
- Keep filters SARGable (avoid wrapping indexed columns in functions in WHERE).
- Prefer explicit columns; only return fields required for the widget.
- Use LIMIT with ORDER BY for top-N charts.
- Avoid ORDER BY in subqueries unless paired with LIMIT/OFFSET.
- Use appropriate date boundaries (>= start AND < end) when possible.

### Professional Standards:
- **Use CTEs (WITH clause)** for complex multi-step transformations or joins to improve readability.
- **Semantic Naming**: Use clear aliases for columns (e.g., \`SELECT COUNT(*) as total_orders\`). Every projected column must have an alias.
- **Data Pruning**: Use explicit column lists in SELECT; avoid \`SELECT *\`.
- **Joins**: Use LEFT JOIN when the primary entity might not have matching records in the joined table.
- **Type Safety**: Use explicit casting \`::type\` when there is any ambiguity.
- **Time Intelligence**: If the plan asks for "By Month", use \`DATE_TRUNC('month', timestamp_col::timestamp)\`.

### Output Rules (Strict JSON)
Return a valid JSON array of objects. Do not wrap in markdown code blocks.
Example:
[
  { "id": "w1", "sql": "SELECT count(*) FROM table" },
  { "id": "w2", "sql": "SELECT * FROM table LIMIT 10" }
]`;

    const isSqlPlaceholder = (sql?: string) => {
        const text = String(sql || "").toLowerCase();
        return (
            text.includes("sql generation missing")
            || text.includes("check plan/schema")
            || text.includes("sql violates connector rules")
            || text.includes("demo placeholder")
        );
    };
    const fillMissingQueries = (queries: Record<string, string>) => {
        const missing = (effectiveWidgets || []).filter((w: any) => !queries[w.id] || isSqlPlaceholder(queries[w.id]));
        if (missing.length === 0) return queries;
        const fallbackSql = buildFallbackSql(plan, schemaForPrompt, isMssql);
        missing.forEach((w: any) => {
            if (fallbackSql?.sqlMap?.[w.id]) {
                queries[w.id] = fallbackSql.sqlMap[w.id];
            }
        });
        return queries;
    };

    const concurrencyEnv = Number(process.env.PLANNER_AGENT_CONCURRENCY || process.env.NEXT_PUBLIC_PLANNER_AGENT_CONCURRENCY || 3);
    const concurrency = Number.isFinite(concurrencyEnv) && concurrencyEnv > 0 ? Math.max(1, Math.floor(concurrencyEnv)) : 3;

    // Parallel SQL Generation Logic
    const widgetsToProcess = (effectiveWidgets || []).slice(0, 10);
    const projectContext = schemaForPrompt?.projectContext || schemaForPrompt?.context || "";

    // Helper for parallel execution with limit
    const runInParallel = async (tasks: Array<() => Promise<any>>, limit: number) => {
        const results: any[] = [];
        let index = 0;
        const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
            while (index < tasks.length) {
                const i = index++;
                results[i] = await tasks[i]();
            }
        });
        await Promise.all(workers);
        return results;
    };

    console.log(`[SQL_GENERATOR] Generating SQL for ${widgetsToProcess.length} widgets with concurrency ${concurrency}...`);

    const sqlTasks = widgetsToProcess.map((widget: any) => async () => {
        try {
            const role = isMssql ? AGENT_ROLES.SQL_SERVER_ENGINEER : AGENT_ROLES.SQL_ENGINEER;
            const rules = isMssql ? SQL_GENERATION_RULES.MSSQL : SQL_GENERATION_RULES.POSTGRES;

            // Build focused schema context for this specific widget
            const { tables: relevantTables, relationships: relevantRelationships } = buildRelevantSchemaForAgent(
                schemaForPrompt,
                widget.type || "chart",
                `${widget.title} ${widget.goal}`,
                10
            );

            const focusedSchemaText = buildSchemaTextForTables(schemaForPrompt, relevantTables);
            const widgetJson = JSON.stringify(widget, null, 2);

            const expertPrompt = `Role: ${role}
Connector instructions are mandatory and override any conflicting guidance.

### CRITICAL RULES:
${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

### FOCUSED DATABASE SCHEMA (STRICT TRUTH)
${focusedSchemaText}

### RELATIONSHIPS (STRICT JOIN LOGIC)
${JSON.stringify(relevantRelationships)}

### TIME CONTEXT
${timeContext}

### DATE CONTEXT (UTC)
${dateContext.summary}

### PROJECT BRIEF & TARGET WIDGET
Project: ${projectContext}
Target Widget: ${widgetJson}

### ACTIVE FILTERS (MUST APPLY IN WHERE)
- JSON: ${activeFilters || "{}"}
- REQUIRED WHERE CONDITIONS:
${filterSqlHints}

### SEARCH CONTEXT
- Search Column Candidates: ${searchCandidateText}
- Global Search Value: "${searchValue}"

YOUR TASK:
Generate exactly ONE optimized ${isMssql ? 'MSSQL' : 'PostgreSQL'} query for WIDGET ID: "${widget.id}".
Return ONLY the SQL. No JSON wrapping, no markdown, no conversational filler.`;

            const response = await invokeModelWithRetry([
                new SystemMessage(expertPrompt),
                new HumanMessage(`Generate the SQL for ${widget.id}.`)
            ]);

            let sql = String(response.content || "").trim();
            // Clean up if the model ignored instructions and wrapped in markdown
            sql = sql.replace(/```sql/gi, '').replace(/```/g, '').trim();

            return { id: widget.id, sql };
        } catch (err: any) {
            console.error(`[SQL_GENERATOR] Failed for widget ${widget.id}:`, err.message);
            // Fallback for this single widget
            const fallback = buildFallbackSql(plan, schemaForPrompt, isMssql)?.sqlMap?.[widget.id] || "SELECT 1 /* fallback */";
            return { id: widget.id, sql: fallback };
        }
    });

    const results = await runInParallel(sqlTasks, concurrency);
    const sqlMap: Record<string, string> = {};
    results.forEach(r => {
        if (r?.id && r?.sql) sqlMap[r.id] = r.sql;
    });

    // Post-processing and enforcement
    const prepared = applyFiltersToQueries(polishQueries(fillMissingQueries(sqlMap)));
    return await enforceQueries(prepared);
}

function normalizeSqlJsonContent(content: string): string {
    let cleaned = content.replace(/```json/gi, '').replace(/```/g, '').trim();

    const arrayJson = extractFirstJsonArray(cleaned);
    if (arrayJson) {
        cleaned = arrayJson;
    }

    // Replace template-literal SQL blocks with JSON strings
    cleaned = cleaned.replace(/`([\s\S]*?)`/g, (_match, inner) => {
        const trimmed = String(inner).trim();
        return JSON.stringify(trimmed);
    });

    return cleaned.trim();
}

function extractFirstJsonArray(content: string): string | null {
    const start = content.indexOf('[');
    if (start === -1) return null;

    let depth = 0;
    for (let i = start; i < content.length; i++) {
        const ch = content[i];
        if (ch === '[') depth++;
        if (ch === ']') depth--;
        if (depth === 0) {
            return content.slice(start, i + 1);
        }
    }
    return null;
}

/**
 * Helper: Find latest date in sample data
 */
function findLatestDate(sampleData: Record<string, any[]>): string | null {
    let maxTimestamp = 0;

    Object.values(sampleData).forEach(rows => {
        rows.forEach(row => {
            Object.values(row).forEach(val => {
                if (typeof val === 'string' || val instanceof Date) {
                    const date = new Date(val);
                    if (!isNaN(date.getTime()) && date.getFullYear() > 2000 && date.getFullYear() < 2100) {
                        if (date.getTime() > maxTimestamp) maxTimestamp = date.getTime();
                    }
                }
            });
        });
    });

    if (maxTimestamp === 0) return null;

    // Check if data is older than 30 days (heuristic)
    const diffDays = (Date.now() - maxTimestamp) / (1000 * 60 * 60 * 24);
    if (diffDays > 30) {
        return new Date(maxTimestamp).toISOString().split('T')[0];
    }
    return null; // Data is fresh enough
}

function buildDateContext(referenceDate?: string | null) {
    const base = referenceDate ? new Date(`${referenceDate}T00:00:00Z`) : new Date();
    const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
    const format = (date: Date) => date.toISOString().slice(0, 10);
    const startOfWeekUtc = (date: Date) => {
        const day = date.getUTCDay();
        const diff = (day + 6) % 7; // Monday start
        const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        start.setUTCDate(start.getUTCDate() - diff);
        return start;
    };
    const startOfMonthUtc = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    const startOfYearUtc = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), 0, 1));

    const thisWeekStart = startOfWeekUtc(safeBase);
    const thisMonthStart = startOfMonthUtc(safeBase);
    const thisYearStart = startOfYearUtc(safeBase);
    const lastMonthStart = new Date(Date.UTC(safeBase.getUTCFullYear(), safeBase.getUTCMonth() - 1, 1));
    const lastMonthEnd = new Date(Date.UTC(safeBase.getUTCFullYear(), safeBase.getUTCMonth(), 0));
    const lastYearStart = new Date(Date.UTC(safeBase.getUTCFullYear() - 1, 0, 1));
    const lastYearEnd = new Date(Date.UTC(safeBase.getUTCFullYear() - 1, 11, 31));

    const summary = [
        `TODAY: ${format(safeBase)}`,
        `THIS_WEEK: ${format(thisWeekStart)} to ${format(safeBase)}`,
        `THIS_MONTH: ${format(thisMonthStart)} to ${format(safeBase)}`,
        `LAST_MONTH: ${format(lastMonthStart)} to ${format(lastMonthEnd)}`,
        `THIS_YEAR: ${format(thisYearStart)} to ${format(safeBase)}`,
        `LAST_YEAR: ${format(lastYearStart)} to ${format(lastYearEnd)}`
    ].join('\n');

    return {
        baseDate: format(safeBase),
        summary
    };
}

// Dynamic Query Pattern Matcher - Matches widget requirements to best query template
function findBestQueryPatterns(
    widgetGoal: string,
    widgetTable: string,
    queryExamples: any[],
    schemaInfo: any
): any[] {
    if (!queryExamples || queryExamples.length === 0) return [];

    const goalLower = widgetGoal.toLowerCase();
    const patterns: Array<{ example: any; score: number; reasons: string[] }> = [];

    queryExamples.forEach((ex: any) => {
        let score = 0;
        const reasons: string[] = [];
        const descLower = ex.description?.toLowerCase() || '';
        const sqlLower = ex.sql?.toLowerCase() || '';

        // Table match (highest priority)
        if (ex.table?.toLowerCase() === widgetTable?.toLowerCase()) {
            score += 50;
            reasons.push('Same table');
        }

        // Pattern matching based on widget goal keywords
        if (/date|time|range|period|between/i.test(goalLower)) {
            if (descLower.includes('date') || sqlLower.includes('date')) {
                score += 30;
                reasons.push('Date filtering pattern');
            }
        }

        if (/search|find|filter|where|like/i.test(goalLower)) {
            if (descLower.includes('search') || descLower.includes('filter') ||
                sqlLower.includes('like') || sqlLower.includes('where')) {
                score += 30;
                reasons.push('Search/filter pattern');
            }
        }

        if (/count|sum|avg|total|aggregate|group/i.test(goalLower)) {
            if (sqlLower.includes('count') || sqlLower.includes('sum') ||
                sqlLower.includes('group by')) {
                score += 30;
                reasons.push('Aggregation pattern');
            }
        }

        if (/join|relate|connect|link/i.test(goalLower)) {
            if (descLower.includes('join') || sqlLower.includes('join')) {
                score += 40;
                reasons.push('JOIN pattern');
            }
        }

        if (/enum|category|type|status/i.test(goalLower)) {
            if (descLower.includes('enum') || descLower.includes('value')) {
                score += 25;
                reasons.push('Enum/categorical pattern');
            }
        }

        // Bonus for successful execution
        if (ex.results && ex.results.length > 0) {
            score += 10;
            reasons.push('Verified working');
        }

        // Bonus for fast execution
        if (ex.executionTime && ex.executionTime < 100) {
            score += 5;
            reasons.push('Fast query');
        }

        if (score > 0) {
            patterns.push({ example: ex, score, reasons });
        }
    });

    // Sort by score and return top 3
    return patterns
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(p => ({
            ...p.example,
            matchScore: p.score,
            matchReasons: p.reasons
        }));
}

// Generate dynamic SQL guidance based on widget requirements and query patterns
function generateDynamicSqlGuidance(
    widget: any,
    bestPatterns: any[],
    schemaInfo: any,
    isMssql: boolean
): string {
    if (bestPatterns.length === 0) return '';

    const guidance: string[] = ['### DYNAMIC QUERY PATTERNS (Use as Templates)'];

    bestPatterns.forEach((pattern, idx) => {
        guidance.push(`\n**Pattern ${idx + 1}** (Match Score: ${pattern.matchScore})`);
        guidance.push(`Reasons: ${pattern.matchReasons?.join(', ')}`);
        guidance.push(`Purpose: ${pattern.description}`);
        guidance.push(`SQL Template:`);
        guidance.push('```sql');
        guidance.push(pattern.sql);
        guidance.push('```');

        if (pattern.results && pattern.results.length > 0) {
            guidance.push(`Sample Results: ${JSON.stringify(pattern.results[0])}`);
        }

        // Add specific guidance on how to adapt this pattern
        guidance.push('**How to adapt:**');

        // Extract columns from the example SQL
        const tableMatch = pattern.sql.match(/FROM\s+["\[]?(\w+)["\]]?/i);
        const exampleTable = tableMatch ? tableMatch[1] : pattern.table;
        const targetTable = widget.table || exampleTable;

        if (exampleTable !== targetTable) {
            guidance.push(`- Replace table "${exampleTable}" with "${targetTable}"`);
        }

        if (pattern.sql.toLowerCase().includes('where')) {
            guidance.push('- Keep the WHERE clause structure but adapt conditions to your widget filters');
        }

        if (pattern.sql.toLowerCase().includes('join')) {
            guidance.push('- Maintain JOIN pattern for related data access');
        }

        if (pattern.sql.toLowerCase().includes('group by')) {
            guidance.push('- Use similar aggregation pattern with appropriate GROUP BY columns');
        }
    });

    // Add SQL syntax hints based on patterns
    if (bestPatterns.some(p => p.sql?.toLowerCase().includes('date'))) {
        guidance.push('\n### DATE FILTERING GUIDANCE');
        if (isMssql) {
            guidance.push('- Use: DATEADD(day, -30, GETDATE()) for "last 30 days"');
            guidance.push('- Use: DATEADD(month, DATEDIFF(month, 0, date_col), 0) for month truncation');
        } else {
            guidance.push('- Use: CURRENT_DATE - INTERVAL \'30 days\' for "last 30 days"');
            guidance.push('- Use: DATE_TRUNC(\'month\', date_col) for month truncation');
        }
    }

    return guidance.join('\n');
}

function buildSqlPromptHints(schemaForPrompt: any) {
    const dateColumns: string[] = [];
    const numericColumns: string[] = [];
    const categoricalColumns: string[] = [];
    const tableCounts = schemaForPrompt?.tableCounts || {};

    const filterCandidates = schemaForPrompt?.filterCandidates || {};
    if (Array.isArray(filterCandidates.dateColumns)) {
        filterCandidates.dateColumns.forEach((entry: any) => {
            if (entry?.table && entry?.column) {
                dateColumns.push(`${entry.table}.${entry.column}`);
            }
        });
    }
    if (Array.isArray(filterCandidates.categoricalColumns)) {
        filterCandidates.categoricalColumns.forEach((entry: any) => {
            if (entry?.table && entry?.column) {
                categoricalColumns.push(`${entry.table}.${entry.column}`);
            }
        });
    }

    const schemaInfo = schemaForPrompt?.schemaInfo || {};
    Object.entries(schemaInfo).forEach(([table, info]: [string, any]) => {
        const columns = Array.isArray(info?.columns) ? info.columns : [];
        columns.forEach((col: any) => {
            const name = col?.name || col?.column_name;
            const type = String(col?.type || col?.data_type || "").toLowerCase();
            if (!name) return;
            if (type.includes("date") || type.includes("time")) {
                dateColumns.push(`${table}.${name}`);
                return;
            }
        });
    });

    const tableInsights = schemaForPrompt?.tableInsights || {};
    Object.entries(tableInsights).forEach(([table, insight]: [string, any]) => {
        const dataMatrix = insight?.dataMatrix || {};
        (dataMatrix.numericCandidates || []).forEach((entry: any) => {
            if (entry?.column) {
                numericColumns.push(`${table}.${entry.column}`);
            }
        });
        (dataMatrix.categoricalCandidates || []).forEach((entry: any) => {
            if (entry?.column) {
                categoricalColumns.push(`${table}.${entry.column}`);
            }
        });
    });

    const unique = (values: string[]) => Array.from(new Set(values));
    const primaryDate = filterCandidates?.primaryDate
        ? `${filterCandidates.primaryDate.table}.${filterCandidates.primaryDate.column}`
        : null;
    const tableRows = Object.entries(tableCounts).slice(0, 12).map(([table, count]) => `${table}: ${count}`);

    // Build detailed filter examples from tableInsights
    const filterExamples: any[] = [];
    Object.entries(tableInsights).forEach(([table, insight]: [string, any]) => {
        const filters = insight?.filters || [];
        filters.forEach((filter: any) => {
            if (filter?.column && filter?.examples) {
                filterExamples.push({
                    filter: `${table}.${filter.column}`,
                    type: filter.type,
                    sampleValues: filter.examples.sampleValues || filter.sampleValues,
                    distinctValues: filter.examples.distinctValues,
                    totalDistinctCount: filter.examples.totalDistinctCount,
                    sampleQueries: filter.examples.sampleQueries?.slice(0, 2), // Limit to 2 queries
                    queryToGetValues: filter.examples.queryToGetValues
                });
            }
        });
    });

    // Build relationship samples from related tables
    const relationshipSamples: Record<string, any> = {};
    const sampleData = schemaForPrompt?.sampleData || {};
    const relationships = schemaForPrompt?.schemaRelationships || schemaForPrompt?.relationships || [];

    relationships.forEach((rel: any) => {
        const targetTable = rel?.toTable || rel?.to?.table;
        if (targetTable && sampleData[targetTable] && !relationshipSamples[targetTable]) {
            relationshipSamples[targetTable] = {
                sampleRows: sampleData[targetTable].slice(0, 3),
                relatedVia: {
                    fromTable: rel?.fromTable || rel?.from?.table,
                    fromColumn: rel?.via || rel?.from?.column,
                    toTable: targetTable,
                    toColumn: rel?.targetColumn || rel?.to?.column
                }
            };
        }
    });

    // Build query examples with actual results
    const queryExamplesWithResults: any[] = [];
    Object.entries(tableInsights).forEach(([table, insight]: [string, any]) => {
        const examples = insight?.queryExamples || [];
        examples.forEach((ex: any) => {
            if (ex?.results && ex.results.length > 0) {
                queryExamplesWithResults.push({
                    table,
                    description: ex.description,
                    sql: ex.sql,
                    results: ex.results.slice(0, 3), // Limit to 3 rows
                    executionTime: ex.executionTime
                });
            }
        });
    });

    const summaryLines = [
        `PRIMARY_DATE: ${primaryDate || "none"}`,
        `DATE_COLUMNS: ${unique(dateColumns).slice(0, 10).join(", ") || "none"}`,
        `NUMERIC_COLUMNS: ${unique(numericColumns).slice(0, 10).join(", ") || "none"}`,
        `CATEGORICAL_COLUMNS: ${unique(categoricalColumns).slice(0, 10).join(", ") || "none"}`,
        `TABLE_ROWS: ${tableRows.join(", ") || "unknown"}`,
        ``,
        `FILTER_EXAMPLES (use these to understand data patterns):`,
        ...filterExamples.slice(0, 8).map((f: any) => {
            const lines = [`  - ${f.filter} (${f.type}):`];
            if (f.sampleValues?.length) {
                lines.push(`    Sample values: ${JSON.stringify(f.sampleValues.slice(0, 5))}`);
            }
            if (f.distinctValues?.length) {
                lines.push(`    Distinct values (${f.totalDistinctCount || f.distinctValues.length} total): ${JSON.stringify(f.distinctValues.slice(0, 5))}`);
            }
            if (f.queryToGetValues) {
                lines.push(`    Query to explore: ${f.queryToGetValues}`);
            }
            return lines.join("\n");
        }),
        ``,
        `RELATED_TABLE_SAMPLES (for JOIN understanding):`,
        ...Object.entries(relationshipSamples).slice(0, 6).map(([table, data]: [string, any]) => {
            const lines = [`  - ${table}:`];
            lines.push(`    Join via: ${data.relatedVia.fromTable}.${data.relatedVia.fromColumn} = ${data.relatedVia.toTable}.${data.relatedVia.toColumn}`);
            lines.push(`    Sample data: ${JSON.stringify(data.sampleRows)}`);
            return lines.join("\n");
        }),
        ``,
        `EXECUTED_QUERY_EXAMPLES (verified working SQL with real results):`,
        ...queryExamplesWithResults.slice(0, 10).map((ex: any) => {
            const lines = [`  - ${ex.table}: ${ex.description} (${ex.executionTime}ms)`];
            lines.push(`    SQL: ${ex.sql.replace(/\n/g, ' ')}`);
            lines.push(`    Results: ${JSON.stringify(ex.results)}`);
            return lines.join("\n");
        })
    ];

    return {
        primaryDate,
        dateColumns: unique(dateColumns),
        numericColumns: unique(numericColumns),
        categoricalColumns: unique(categoricalColumns),
        filterExamples: filterExamples.slice(0, 10),
        relationshipSamples,
        queryExamples: queryExamplesWithResults.slice(0, 10),
        summary: summaryLines.join("\n"),
        // Add helper functions for dynamic pattern matching
        findBestPatterns: (widgetGoal: string, widgetTable: string) =>
            findBestQueryPatterns(widgetGoal, widgetTable, queryExamplesWithResults, schemaInfo),
        generateDynamicGuidance: (widget: any, bestPatterns: any[], isMssql: boolean) =>
            generateDynamicSqlGuidance(widget, bestPatterns, schemaInfo, isMssql)
    };
}

/**
 * Helper: Parse structured SQL output
 */
/**
 * Helper: Parse structured SQL output (Robust version)
 */
/**
 * Helper: Parse structured SQL output (Robust multi-pattern version)
 */
function parseSQLOutput(output: string, widgets: any[]): Record<string, string> {
    console.log("[DEBUG] Parsing SQL Output. Output Length:", output.length);
    const queries: Record<string, string> = {};
    const lowerOutput = output.toLowerCase();

    // Strategy 1: Explicit "WIDGET: wX" / "SQL: SELECT" pattern
    const blocks = output.split(/(?=widget|---)/i);
    for (const block of blocks) {
        const idMatch = block.match(/(?:widget|id|item|widgetid)[:\s-]+(w\d+|[0-9]+|[a-zA-Z0-9_-]+)/i);
        // Look for SQL after the label or within the block
        const sqlMatch = block.match(/(?:sql|query)[:\s-]+([\s\S]+?)(?=(?:widget|---)|$)/i)
            || block.match(/select\s+[\s\S]+?(?=;|$)/i);

        if (idMatch && sqlMatch) {
            let id = idMatch[1].trim();
            // Normalization is tricky if IDs are complex. 
            // Better to try finding ANY widget that ends with this ID or matches exactly.

            let rawSql = sqlMatch[1] || sqlMatch[0];
            let sql = rawSql.trim()
                .replace(/```sql/gi, '')
                .replace(/```/g, '')
                .replace(/\*\*/g, '')
                .trim();

            // STRIP JSON artifacts (leaked closing braces/brackets/quotes from fallback parsing)
            // This happens when the LLM returns JSON but we fall back to text parsing
            sql = sql.replace(/^["']|["']$/g, ''); // Strip outer quotes
            sql = sql.replace(/[}\],]+$/, '').trim(); // Strip trailing JSON artifacts

            if (sql.endsWith(';')) sql = sql.slice(0, -1);

            // Try exact match first
            let target = widgets.find(w => w.id === id || w.id.toLowerCase() === id.toLowerCase());

            // If not found, try robust normalization (e.g. w1 -> w1 or 1 -> w1)
            if (!target) {
                const normalizedId = id.toLowerCase().startsWith('w') ? id.toLowerCase() : 'w' + id;
                target = widgets.find(w => w.id.toLowerCase() === normalizedId);
            }

            if (target && sql.length > 10) {
                console.log(`[DEBUG] Found Strategy 1 match for ${target.id}`);
                queries[target.id] = sql;
            } else {
                // Try fuzzy match: does widget ID contain this ID?
                target = widgets.find(w => w.id.includes(id));
                if (target && sql.length > 10) {
                    queries[target.id] = sql;
                }
            }
        }
    }

    // Strategy 2: Heuristic block discovery (if Strategy 1 failed for some widgets)
    widgets.forEach(w => {
        if (!queries[w.id]) {
            // Pattern: w1: SELECT ...
            const directRegex = new RegExp(`${w.id}[:\\s-]+(select[\\s\\S]+?)(?=;|$|w\\d+:)`, "i");
            const match = output.match(directRegex);
            if (match) {
                console.log(`[DEBUG] Found Strategy 2 match for ${w.id}`);
                let sql = match[1].trim()
                    .replace(/```sql/gi, '')
                    .replace(/```/g, '')
                    .replace(/\*\*/g, '')
                    .trim();

                // Consistency fix for trailing artifacts
                sql = sql.replace(/^["']|["']$/g, '');
                sql = sql.replace(/[}\],]+$/, '').trim();

                if (sql.endsWith(';')) sql = sql.slice(0, -1);
                queries[w.id] = sql;
            }
        }
    });

    // Strategy 3: Sequential Mapping (Last Resort)
    // If we find N code blocks and we have N widgets, map them in order
    const sqlCodeBlocks = output.match(/```sql[\s\S]*?```/gi) || output.match(/select[\s\S]+?(?=;|$)/gi);
    console.log(`[DEBUG] Strategy 3: Found ${sqlCodeBlocks?.length || 0} code blocks vs ${widgets.length} widgets`);

    if (Object.keys(queries).length < widgets.length && sqlCodeBlocks) {
        // Only do this if the count matches exactly to avoid mis-mapping
        if (sqlCodeBlocks.length === widgets.length) {
            console.log("[AGENT] Sequential SQL Mapping triggered.");
            widgets.forEach((w, idx) => {
                if (!queries[w.id]) {
                    let sql = sqlCodeBlocks[idx]
                        .replace(/```sql/gi, '')
                        .replace(/```/g, '')
                        .replace(/\*\*/g, '')
                        .trim();
                    if (sql.endsWith(';')) sql = sql.slice(0, -1);
                    queries[w.id] = sql;
                }
            });
        }
    }

    // Final validation: keep only parsable SQL and let caller backfill missing widgets.
    widgets.forEach(w => {
        if (!queries[w.id]) {
            console.warn(`[SQL_PARSER] Missing query for ${w.id}.`);
        }
    });

    return queries;
}

/**
 * STEP 4: QUERY EXECUTOR
 * Executes generated SQL in parallel with performance tracking.
 */
// --- LEGACY AGENTS (Maintained for backward compatibility during migration) ---

/**
 * ENTRY: INTENT UNDERSTANDING
 */
export async function intentAgent(state: typeof AgentState.State) {
    const lastMessage = state.messages[state.messages.length - 1];
    const query = typeof lastMessage.content === 'string' ? lastMessage.content : "Overview of data";
    const focusTable = state.context?.focusTable;
    
    // Get today's date
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const todayFormatted = today.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
    });

    const prompt = `You are an Intent Parsing Agent (Senior Analyst). Extract user goals into JSON.
    
    TODAY'S DATE: ${todayFormatted} (${todayStr})
    Use this when interpreting date-related queries like "today", "this week", "last month", etc.
    
    FIELDS: intent (short string), entities (tables involved), metrics (requested values), dimensions (grouping), filters (where clause ideas).
    ${focusTable ? `CONTEXT: The user is currently inspecting the '${focusTable}' table. Prioritize this entity.` : ''}
    QUERY: "${query}"`;

    const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
    const parsed = extractJSON(response.content as string) || { intent: focusTable ? `Focus on ${focusTable}` : "overview", entities: focusTable ? [focusTable] : [] };

    if (parsed.entities) {
        parsed.entities = Array.isArray(parsed.entities)
            ? parsed.entities.filter((e: any) => typeof e === 'string' && e !== 'null')
            : [];
    } else {
        parsed.entities = [];
    }

    return {
        intent: parsed,
        status: "Intent parsed.",
        messages: [new AIMessage(`[INTENT] Targets: ${parsed.entities.length > 0 ? parsed.entities.join(', ') : 'General'}`)]
    };
}

/**
 * 1. SCHEMA AGENT
 * Objective: Database intelligence & profiling
 */
export async function schemaAgent(state: typeof AgentState.State) {
    return schemaAgentImpl(state);
}

/**
 * 2. QUERY ENHANCER
 * Objective: Deepen intent and contextualize with schema
 */
export async function queryEnhancerAgent(state: typeof AgentState.State) {
    const prompt = `Role: Senior Data Architect. Enhance the raw intent with technical context.
    INTENT: ${JSON.stringify(state.intent)}
    SCHEMA: ${JSON.stringify(state.schemaInfo)}
    
    Explain the entities involved, suggest metrics to track, and identify potential join paths.
    Return JSON: { "technical_context": "...", "suggested_metrics": [], "join_paths": [] }`;

    const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
    const enhanced = extractJSON(response.content as string) || { suggested_metrics: [] };

    return {
        querySpecification: enhanced, // Store technical context here
        status: "Technical context established.",
        messages: [new AIMessage(`[ENHANCER] Identified ${enhanced.suggested_metrics?.length || 0} key metrics for the dashboard.`)]
    };
}

/**
 * 3. DASHBOARD PLANNER AGENT ⭐
 * Objective: Decides what widgets to create
 */
export async function dashboardPlannerAgent(state: typeof AgentState.State) {
    return dashboardPlannerAgentImpl(state);
}

/**
 * 4. MULTI-QUERY ORCHESTRATOR AGENT ⭐
 * Objective: Replaces single SQL Generator. Generates SQL for ALL widgets.
 */
export async function multiQueryOrchestratorAgent(state: typeof AgentState.State) {
    let plan = state.queryPlan;
    const retryCount = state.retryCount || 0;
    const maxRetries = 3;
    const connectionString = state.context?.connectionString || state.context?.dbUrl || state.context?.postgresUrl || state.context?.mssqlUrl || "";
    const isMssql = (() => {
        const lower = String(connectionString || "").toLowerCase();
        return lower.startsWith("mssql://") || lower.startsWith("sqlserver://") || lower.includes("server=") || lower.includes("data source=");
    })();
    const projectContext = state.context?.projectContext || "";

    if (!plan || !plan.widgets || plan.widgets.length === 0) {
        return {
            status: "Error: No valid dashboard plan available. Cannot generate SQL.",
            errors: ["Dashboard plan is missing or empty."],
            messages: [new AIMessage("[ORCHESTRATOR] Planning failed – no widgets were architected.")],
            results: []
        };
    }

    // If this is a retry and we have repaired SQL, use it instead of generating new
    if (state.repairedSQL && retryCount > 0) {
        console.log(`[ORCHESTRATOR] Using repaired SQL for retry ${retryCount}/${maxRetries}`);
        return {
            queryValidation: state.repairedSQL,
            sqlQueries: Object.values(state.repairedSQL),
            status: `Using repaired SQL queries for retry ${retryCount}/${maxRetries}`,
            messages: [new AIMessage(`[ORCHESTRATOR] Using regenerated SQL for retry attempt ${retryCount}`)]
        };
    }

    const schemaForPrompt = {
        schemaInfo: state.schemaInfo,
        relationships: state.schemaRelationships,
        sampleData: state.sampleData,
        connectorInstructions: state.context?.connectorInstructions,
        connectorType: state.context?.connectorType,
        connectionString,
        projectContext
    };

    const filters = (state.context?.runtimeParams as Record<string, any>) || {};
    const errorLog = (state.errors || []).map(err => ({ id: 'prev_error', error: err }));

    // Use our high-performance parallel generator
    const sqlMap = await runQueryGenerator(plan, schemaForPrompt, filters, errorLog, true);

    return {
        queryPlan: plan,
        queryValidation: sqlMap,
        sqlQueries: Object.values(sqlMap),
        status: "Synthesized multi-query set with parallel expert agents.",
        messages: [new AIMessage(`[ORCHESTRATOR] Generated ${Object.keys(sqlMap).length} targeted SQL statements with Expert-per-Widget orchestration.`)]
    };
}

/**
 * Build safe fallback SQL when the LLM returns nothing.
 */
function buildFallbackSql(plan: any, schemaInfo: Record<string, any> | undefined, isMssql = false) {
    const entry = Object.entries(schemaInfo || {}).find(([, info]) => (info as any)?.columns?.length);
    if (!entry) return null;
    const [tableName, info] = entry as [string, any];
    const columns = info?.columns || [];
    const getName = (col: any) => col?.name || col?.column_name;
    const quoteIdent = (name: string) => {
        const raw = String(name || "").trim();
        if (isMssql) return `[${raw.replace(/]/g, "]]")}]`;
        return `"${raw.replace(/"/g, '""')}"`;
    };
    const quoteCol = (col: any) => quoteIdent(getName(col) || String(col || ""));
    const tableRef = quoteIdent(tableName);
    const numericCol = columns.find((c: any) => categorizeDataType(c.data_type || c.type || "") === "numeric");
    const temporalCol = columns.find((c: any) => isTemporalType(c.data_type || c.type || ""));
    const textCol = columns.find((c: any) => isTextType(c.data_type || c.type || ""));
    const idCol = columns.find((c: any) => c.isPrimary || getName(c) === "id") || columns[0];
    const columnNames = columns.map((c: any) => quoteCol(c)).join(", ") || "*";

    const map: Record<string, string> = {};
    const widgets = Array.isArray(plan?.widgets) && plan.widgets.length > 0
        ? plan.widgets
        : [
            { id: "w_kpi_total", type: "kpi" },
            { id: "w_kpi_sum", type: "kpi" },
            { id: "w_trend", type: "line" },
            { id: "w_top_category", type: "bar" },
            { id: "w_distribution", type: "pie" },
            { id: "w_table", type: "table" }
        ];

    const numericValueExpr = numericCol ? `COALESCE(SUM(${quoteCol(numericCol)}), 0)` : "COUNT(*)";
    const categoryCol = textCol || idCol;
    const categoryRef = quoteCol(categoryCol);
    const orderColRef = temporalCol ? quoteCol(temporalCol) : quoteCol(idCol);
    let kpiIndex = 0;

    widgets.forEach((widget: any) => {
        const widgetId = String(widget?.id || "").trim();
        if (!widgetId) return;
        const widgetType = String(widget?.type || "").toLowerCase();

        if (widgetType === "kpi") {
            kpiIndex += 1;
            if (kpiIndex === 1) {
                map[widgetId] = `SELECT COUNT(*) AS total_records FROM ${tableRef};`;
            } else if (numericCol) {
                map[widgetId] = `SELECT COALESCE(SUM(${quoteCol(numericCol)}), 0) AS total_value FROM ${tableRef};`;
            } else {
                map[widgetId] = `SELECT COUNT(DISTINCT ${quoteCol(idCol)}) AS total_entities FROM ${tableRef};`;
            }
            return;
        }

        if (widgetType === "line" || widgetType === "area") {
            if (temporalCol) {
                if (isMssql) {
                    map[widgetId] = `SELECT TOP 90 CAST(${quoteCol(temporalCol)} AS date) AS day, ${numericValueExpr} AS value
FROM ${tableRef}
GROUP BY CAST(${quoteCol(temporalCol)} AS date)
ORDER BY day DESC;`;
                } else {
                    map[widgetId] = `SELECT DATE_TRUNC('day', ${quoteCol(temporalCol)}) AS day, ${numericValueExpr} AS value
FROM ${tableRef}
GROUP BY 1
ORDER BY 1 DESC
LIMIT 90;`;
                }
            } else if (isMssql) {
                map[widgetId] = `SELECT TOP 50 ${quoteCol(idCol)} AS seq, ${numericCol ? quoteCol(numericCol) : "1"} AS value
FROM ${tableRef}
ORDER BY ${quoteCol(idCol)} DESC;`;
            } else {
                map[widgetId] = `SELECT ${quoteCol(idCol)} AS seq, ${numericCol ? quoteCol(numericCol) : "1"} AS value
FROM ${tableRef}
ORDER BY ${quoteCol(idCol)} DESC
LIMIT 50;`;
            }
            return;
        }

        if (widgetType === "table") {
            if (isMssql) {
                map[widgetId] = `SELECT TOP 50 ${columnNames}
FROM ${tableRef}
ORDER BY ${orderColRef} DESC;`;
            } else {
                map[widgetId] = `SELECT ${columnNames}
FROM ${tableRef}
ORDER BY ${orderColRef} DESC
LIMIT 50;`;
            }
            return;
        }

        // Fallback for bar/pie/donut/scatter/funnel/other chart types
        if (isMssql) {
            map[widgetId] = `SELECT TOP 10 ${categoryRef} AS category, ${numericValueExpr} AS value
FROM ${tableRef}
GROUP BY ${categoryRef}
ORDER BY value DESC;`;
        } else {
            map[widgetId] = `SELECT ${categoryRef} AS category, ${numericValueExpr} AS value
FROM ${tableRef}
GROUP BY 1
ORDER BY value DESC
LIMIT 10;`;
        }
    });

    return { sqlMap: map, plan };
}

/**
 * Build demo SQL map placeholders (not executed).
 */
function buildDemoSql(plan: any) {
    const sqlMap: Record<string, string> = {};
    (plan.widgets || []).forEach((w: any) => {
        sqlMap[w.id] = `-- demo placeholder for ${w.title}`;
    });
    return sqlMap;
}

/**
 * 5. SECURITY VALIDATOR
 */
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

/**
 * 6. MCP CALLING AGENT (QUERY EXECUTOR) - STREAMING VERSION
 */
export async function* mcpCallingAgentStream(state: typeof AgentState.State) {
    if (!state.securityClearance?.approved) {
        yield { type: "error", message: "Execution blocked: Security clearance not granted." };
        return;
    }

    const sqlMap = state.queryValidation;
    const connectionString =
        state.context?.connectionString ||
        state.context?.dbUrl ||
        state.context?.postgresUrl ||
        state.context?.mssqlUrl ||
        state.schema?.connectionString ||
        state.schema?.dbUrl ||
        state.schema?.postgresUrl ||
        state.schema?.mssqlUrl ||
        undefined;
    const connectorInstructions = state.schema?.connectorInstructions || state.context?.connectorInstructions || "";
    const connectorType = state.schema?.connectorType || state.context?.connectorType || "";
    const totalQueries = Object.keys(sqlMap).length;
    let completedQueries = 0;

    yield { type: "progress", stage: "starting", message: `Preparing to execute ${totalQueries} queries...` };


    const results: any[] = [];

    // Execute queries sequentially with progress updates to enable proper streaming
    for (const [id, sql] of Object.entries(sqlMap)) {
        const wInfo = state.queryPlan?.widgets?.find((w: any) => w.id === id);

        try {
            // Yield query start
            yield {
                type: "query_progress",
                widgetId: id,
                widgetTitle: wInfo?.title || "Metric",
                stage: "executing",
                message: `Executing query for ${wInfo?.title || id}...`,
                sql: sql  // Include the actual SQL query
            };

            let currentSql = sql as string;
            let validation = validateSqlAgainstInstructions(currentSql, connectionString, connectorInstructions, connectorType, state.schema);
            let attempts = 0;
            while (!validation.ok && attempts < 2) {
                attempts += 1;
                try {
                    const repair = await repairFailedQuery({
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
                validation = validateSqlAgainstInstructions(currentSql, connectionString, connectorInstructions, connectorType, state.schema);
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
            const isMssqlExec = detectIsMssql(connectionString, connectorType);
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

            // Yield query completion
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

            // Yield query error
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

    // Check for critical connection errors
    const criticalError = results.find(r => r.error && (r.error.includes("Not connected") || r.error.includes("Connection failed")));
    if (criticalError) {
        yield {
            type: "error",
            message: "Database Connection Failure: The AI could not connect to your Postgres instance. Please check your POSTGRES_URL in .env.",
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

/**
 * 6. MCP CALLING AGENT (QUERY EXECUTOR) - ORIGINAL NON-STREAMING VERSION
 */
export async function mcpCallingAgent(state: typeof AgentState.State) {
    if (!state.securityClearance?.approved) {
        return { errors: ["Execution blocked: Security clearance not granted."], status: "Security block." };
    }
    const sqlMap = state.queryValidation;
    const connectionString = state.context?.connectionString || state.context?.dbUrl || state.context?.postgresUrl || state.context?.mssqlUrl || undefined;


    const results: any[] = [];

    // Parallel execution simulation
    const tasks = Object.entries(sqlMap).map(async ([id, sql]) => {
        try {
            console.log(`[EXECUTOR] Running widget ${id}...`);
            const isMssqlExec = detectIsMssql(connectionString, (state.schema as any)?.connectorType || (state.context as any)?.connectorType);
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

    // Filter results to check for global system failures
    const criticalError = resolved.find(r => r.error && (r.error.includes("Not connected") || r.error.includes("Connection failed")));
    if (criticalError) {
        return {
            errors: ["Database Connection Failure: The AI could not connect to your Postgres instance. Please check your POSTGRES_URL in .env."],
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

/**
 * 7. ANALYTICS AGENT - STREAMING VERSION
 */
export async function* analyticsAgentStream(state: typeof AgentState.State) {
    yield { type: "progress", stage: "starting", message: "Starting analytics analysis..." };

    try {
        const prompt = `Role: Senior Data Scientist. Analyze these results collectively.
        RESULTS: ${JSON.stringify(state.results.map(r => ({ title: r.widgetTitle, sample: r.data.slice(0, 3) })))}
        
        Return JSON: { "insights": ["..."], "anomalies": ["..."] }`;

        yield { type: "progress", stage: "analyzing", message: "Analyzing data patterns..." };

        const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
        const analysis = extractJSON(response.content as string) || { insights: ["Data patterns analyzed."] };

        yield {
            type: "progress",
            stage: "generating_insights",
            message: `Generated ${analysis.insights?.length || 0} insights and ${analysis.anomalies?.length || 0} anomaly detections`
        };

        yield {
            type: "complete",
            analytics: analysis,
            insights: analysis.insights,
            message: "Analytics analysis complete"
        };

    } catch (error) {
        yield {
            type: "error",
            message: `Analytics analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        };
    }
}

/**
 * 7. ANALYTICS AGENT - ORIGINAL NON-STREAMING VERSION
 */
export async function analyticsAgent(state: typeof AgentState.State) {
    const prompt = `Role: Senior Data Scientist. Analyze these results collectively.
    RESULTS: ${JSON.stringify(state.results.map(r => ({ title: r.widgetTitle, sample: r.data.slice(0, 3) })))}
    
    Return JSON: { "insights": ["..."], "anomalies": ["..."] }`;

    const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
    const analysis = extractJSON(response.content as string) || { insights: ["Data patterns analyzed."] };

    return {
        analytics: analysis,
        insights: analysis.insights,
        status: "Collective analysis complete.",
        messages: [new AIMessage(`[ANALYTICS] Generated strategic observations across ${state.results.length} datasets.`)]
    };
}

/**
 * 8. VISUALIZATION AGENT - STREAMING VERSION
 */
export async function* chartDesignAgentStream(state: typeof AgentState.State) {
    const results = state.results;
    const widgetSpecs: any[] = [];
    const totalWidgets = results.length;
    let processedWidgets = 0;

    yield { type: "progress", stage: "starting", message: `Starting visualization design for ${totalWidgets} widgets...` };

    for (const res of results) {
        processedWidgets++;

        yield {
            type: "widget_progress",
            widgetId: res.widgetId,
            widgetTitle: res.widgetTitle,
            stage: "processing",
            message: `Designing visualization for ${res.widgetTitle} (${processedWidgets}/${totalWidgets})`
        };

        if (res.error || res.type === 'kpi' || res.type === 'table') {
            widgetSpecs.push(res);
            yield {
                type: "widget_complete",
                widgetId: res.widgetId,
                widgetTitle: res.widgetTitle,
                result: res,
                message: `${res.widgetTitle} requires no visualization (KPI/Table type)`
            };
            continue;
        }

        try {
            // Generate Vega-Lite for charts
            const vizPrompt = `Generate Vega-Lite for:
            TITLE: ${res.widgetTitle}
            TYPE: ${res.type}
            COLUMNS: ${JSON.stringify(res.columns)}
            SAMPLE: ${JSON.stringify(res.data.slice(0, 2))}
            Return ONLY JSON. Use "table" for data source.`;

            yield {
                type: "widget_progress",
                widgetId: res.widgetId,
                widgetTitle: res.widgetTitle,
                stage: "generating_spec",
                message: `Generating Vega-Lite specification for ${res.widgetTitle}...`
            };

            const response = await invokeModelWithRetry([new SystemMessage(vizPrompt)]);
            const vegaSpec = extractJSON(response.content as string);

            const widgetWithSpec = { ...res, vegaSpec };
            widgetSpecs.push(widgetWithSpec);

            yield {
                type: "widget_complete",
                widgetId: res.widgetId,
                widgetTitle: res.widgetTitle,
                result: widgetWithSpec,
                message: `Completed visualization design for ${res.widgetTitle}`
            };

        } catch (error) {
            const errorResult = { ...res, error: error instanceof Error ? error.message : 'Visualization generation failed' };
            widgetSpecs.push(errorResult);

            yield {
                type: "widget_error",
                widgetId: res.widgetId,
                widgetTitle: res.widgetTitle,
                error: error instanceof Error ? error.message : 'Unknown error',
                message: `Failed to generate visualization for ${res.widgetTitle}`
            };
        }
    }

    yield {
        type: "complete",
        results: widgetSpecs,
        message: `Visualization design complete: ${widgetSpecs.filter(w => !w.error).length}/${totalWidgets} successful`
    };
}

/**
 * 8. VISUALIZATION AGENT - ORIGINAL NON-STREAMING VERSION
 */
export async function chartDesignAgent(state: typeof AgentState.State) {
    const results = state.results;
    const widgetSpecs: any[] = [];

    for (const res of results) {
        if (res.error || res.type === 'kpi' || res.type === 'table') {
            widgetSpecs.push(res);
            continue;
        }

        // Generate Vega-Lite for charts
        const vizPrompt = `Generate Vega-Lite for:
        TITLE: ${res.widgetTitle}
        TYPE: ${res.type}
        COLUMNS: ${JSON.stringify(res.columns)}
        SAMPLE: ${JSON.stringify(res.data.slice(0, 2))}
        Return ONLY JSON. Use "table" for data source.`;

        const response = await invokeModelWithRetry([new SystemMessage(vizPrompt)]);
        const vegaSpec = extractJSON(response.content as string);

        widgetSpecs.push({ ...res, vegaSpec });
    }

    return {
        results: widgetSpecs, // Update results with specs
        status: "Visualization specs synthesized.",
        messages: [new AIMessage(`[VISUALIZER] Completed visual mapping for all active components.`)]
    };
}

/**
 * 9. SMART LAYOUT BUILDER AGENT ⭐
 * Objective: Arranges widgets into beautiful grid
 */
export async function smartLayoutBuilderAgent(state: typeof AgentState.State) {
    const widgets = state.results;

    const prompt = `Role: Senior UX/UI Engineer. 
    TASK: Arrange ${widgets.length} components into a high-density, professional board.
    WIDGETS: ${JSON.stringify(widgets.map(w => ({ id: w.widgetId, type: w.type, title: w.widgetTitle })))}

    GEOMETRY RULES:
    1. TOP ROW: All 'kpi' type widgets must be in the first row. Width: 3 (4 per row). Height: 2.
    2. MIDDLE SECTION: 'line', 'bar', 'donut', 'pie' charts. Width: 6 (2 per row) or 12 (1 per row). Height: 4.
    3. BOTTOM SECTION: 'table' widgets. Width: 12. Height: 6.
    4. ALIGNMENT: Ensure 'x' increments correctly (0, 3, 6, 9 for KPIs; 0, 6 for charts) and 'y' reflects clear row sections.

    Return JSON Map: { "widget_id": { "x": number, "y": number, "w": number, "h": number } }`;

    const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
    const layoutMap = extractJSON(response.content as string) || {};

    const layout = Object.entries(layoutMap).map(([id, pos]: [string, any]) => ({
        i: id,
        ...pos
    }));

    return {
        executionPlan: layout, // Use executionPlan for the grid layout
        status: "Responsive layout calculated.",
        messages: [new AIMessage(`[LAYOUT] Optimized ${widgets.length} components for 12-column executive view.`)]
    };
}

/**
 * 10. WIDGET RENDERER AGENT
 * Objective: Final assembly
 */
export async function widgetRendererAgent(state: typeof AgentState.State) {
    const results = Array.isArray(state.results) ? state.results : [];
    const layoutFromState = Array.isArray(state.executionPlan) ? state.executionPlan : [];

    const fallbackFromPlan = () => {
        const planned = Array.isArray(state.queryPlan?.widgets) ? state.queryPlan.widgets : [];
        return planned.map((w: any, index: number) => ({
            widgetId: w.id || `widget_${index + 1}`,
            widgetTitle: w.title || `Widget ${index + 1}`,
            type: w.type || "table",
            goal: w.goal,
            plan_metric: w.metric,
            plan_dim: w.dim,
            data: undefined,
            columns: [w.dim, w.metric].filter(Boolean)
        }));
    };

    const baseResults = results.length > 0 ? results : fallbackFromPlan();

    const normalizedResults = baseResults.map((res: any, index: number) => {
        const fallbackId = res.widgetTitle ? `w_${res.widgetTitle.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : `widget_${index + 1}`;
        const widgetId = String(res.widgetId || fallbackId);
        return { ...res, widgetId };
    });

    const validIds = new Set(normalizedResults.map((res: any) => res.widgetId));
    const normalizedLayout = layoutFromState
        .filter((item: any) => item && item.i && validIds.has(String(item.i)))
        .map((item: any) => ({
            i: String(item.i),
            x: Number(item.x) || 0,
            y: Number(item.y) || 0,
            w: Number(item.w) || 6,
            h: Number(item.h) || 4,
        }));

    const layoutIds = new Set(normalizedLayout.map((item: any) => item.i));
    const fallbackLayout: any[] = [];

    const getDefaultSize = (type?: string) => {
        if (type === "kpi") return { w: 3, h: 2 };
        if (type === "table") return { w: 12, h: 6 };
        return { w: 6, h: 4 };
    };

    let cursorX = 0;
    let cursorY = normalizedLayout.length > 0
        ? Math.max(...normalizedLayout.map((item) => item.y + item.h))
        : 0;
    let rowHeight = 0;

    const placeNext = (widgetId: string, size: { w: number; h: number }) => {
        if (cursorX + size.w > 12) {
            cursorX = 0;
            cursorY += rowHeight || 1;
            rowHeight = 0;
        }

        const position = { i: widgetId, x: cursorX, y: cursorY, w: size.w, h: size.h };
        cursorX += size.w;
        rowHeight = Math.max(rowHeight, size.h);
        return position;
    };

    normalizedResults.forEach((res: any) => {
        if (!layoutIds.has(res.widgetId)) {
            fallbackLayout.push(placeNext(res.widgetId, getDefaultSize(res.type)));
            layoutIds.add(res.widgetId);
        }
    });

    const mergedLayout = [...normalizedLayout, ...fallbackLayout];
    const layoutById = new Map(mergedLayout.map((item: any) => [item.i, item]));

    const finalWidgets = normalizedResults.map((res: any) => {
        const grid = layoutById.get(res.widgetId) || { x: 0, y: 0, w: 6, h: 4 };

        const safeColumns = Array.isArray(res.columns) ? res.columns : [];

        return {
            id: res.widgetId,
            title: res.widgetTitle,
            type: res.type,
            goal: res.goal,
            data: res.data,
            vegaSpec: (res as any).vegaSpec,
            kpiConfig: res.type === 'kpi' ? {
                valueField: res.plan_metric || safeColumns.find((c: string) => ['total', 'amount', 'revenue', 'count', 'sum'].some(k => c.toLowerCase().includes(k))) || safeColumns[0],
                format: 'compact'
            } : undefined,
            tableConfig: res.type === 'table' ? {
                columns: safeColumns.map((c: string) => ({ field: c, header: c.toUpperCase().replace(/_/g, ' ') }))
            } : undefined,
            position: grid
        };
    });

    return {
        dashboard: {
            id: `dash_${Date.now()}`,
            name: (state.queryPlan as any)?.title || "AI Insight Hub",
            widgets: finalWidgets.map((w: any) => ({
                ...w,
                goal: w.goal // Explicitly pass the goal for the UI
            })),
            layout: mergedLayout,
            actionablePlan: (state.queryPlan as any)?.actionable_plan
        },
        status: "Dashboard final assembly complete.",
        messages: [new AIMessage(`[RENDERER] Assembled full-fidelity dashboard configuration.`)]
    };
}

/**
 * 11. EXPLANATION AGENT
 */
export async function insightGenerationAgent(state: typeof AgentState.State) {
    const prompt = `Role: Senior Strategic Executive Analyst.
    Dashboard: ${state.dashboard?.name}
    Insights: ${JSON.stringify(state.insights)}
    
    Summarize findings in 3 bulleted sentences. Focus on action and value.`;

    const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
    const summary = (response.content as string).split('\n').filter(s => s.trim().length > 10);

    return {
        insights: summary,
        status: "Executive summary delivered.",
        messages: [new AIMessage(`[EXPLANATION] Dashboard narrative finalized.`)]
    };
}

// --- LEGACY WRAPPERS ---
export async function sqlAgent(state: typeof AgentState.State) { return await multiQueryOrchestratorAgent(state); }
export async function schemaDiscoveryAgent(state: typeof AgentState.State) { return await schemaAgent(state); }
export async function planAgent(state: typeof AgentState.State) { return await queryEnhancerAgent(state); }
export async function samplingDataAgent(state: typeof AgentState.State) { return { status: "Skipped." }; }
export async function queryValidationAgent(state: typeof AgentState.State) { return { status: "Skipped." }; }
/**
 * 11. QUALITY CHECK AGENT
 * Validates query results and triggers retries for empty data
 */
export async function qualityCheckAgent(state: typeof AgentState.State) {
    const results = state.results || [];
    const queryPlan = state.queryPlan;
    const retryCount = state.retryCount || 0;
    const maxRetries = 3;

    const errors: string[] = [];
    const needsRetry: string[] = [];
    const emptyWidgets: any[] = [];

    // Check each result for quality issues
    for (const result of results) {
        // Check 1: Empty data
        if (result.data && result.data.length === 0 && !result.error) {
            errors.push(`No data returned for "${result.widgetTitle || result.widgetId}".`);
            needsRetry.push(String(result.widgetId));
            emptyWidgets.push(result);
            continue;
        }

        // Check 2: Error results
        if (result.error) {
            errors.push(`Execution error for "${result.widgetTitle || result.widgetId}": ${result.error}`);
            needsRetry.push(String(result.widgetId));
            continue;
        }

        // Check 3: Data quality issues (sample checks)
        if (result.data && result.data.length > 0) {
            // Check for NULL values in key metrics
            const numericColumns = result.columns.filter((col: string) =>
                result.data.some((row: any) => typeof row[col] === 'number')
            );

            if (numericColumns.length > 0) {
                const nullCounts = numericColumns.map((col: string) => ({
                    column: col,
                    nullCount: result.data.filter((row: any) => row[col] === null).length
                }));

                const highNullColumns = nullCounts.filter((nc: any) => nc.nullCount > result.data.length * 0.5);
                if (highNullColumns.length > 0) {
                    errors.push(`High NULL values (${highNullColumns.map((nc: any) => `${nc.column}: ${nc.nullCount}/${result.data.length}`).join(', ')}) in "${result.widgetTitle}".`);
                }
            }
        }
    }

    // If we have empty data and retries available, trigger retry
    if (needsRetry.length > 0 && retryCount < maxRetries) {
        console.log(`[QA] Quality issues detected. Triggering retry ${retryCount + 1}/${maxRetries}`);

        return {
            errors,
            status: `QA failed with ${errors.length} issues. Attempting retry ${retryCount + 1}/${maxRetries}...`,
            retryCount: retryCount + 1,
            shouldRepair: true,
            retryWidgets: needsRetry,
            emptyWidgets,
            messages: [new AIMessage(`[QA] Quality check failed. ${errors.length} issues found. Triggering SQL repair for widgets: ${needsRetry.join(', ')}`)]
        };
    }

    // If retries exhausted but we still have issues
    if (needsRetry.length > 0) {
        return {
            errors,
            status: `QA failed after ${maxRetries} retries. ${errors.length} unresolved issues.`,
            shouldContinue: true, // Continue anyway for partial results
            messages: [new AIMessage(`[QA] Quality issues persist after ${maxRetries} retries. Proceeding with partial results.`)]
        };
    }

    // All checks passed
    return {
        status: "QA validation passed. All results meet quality standards.",
        qualityScore: 95,
        messages: [new AIMessage(`[QA] Quality check passed. All ${results.length} datasets meet quality standards.`)]
    };
}
/**
 * 12. SQL REPAIR AGENT
 * Regenerates SQL queries when empty data is detected, learning from previous mistakes
 */
export async function sqlRepairAgent(state: typeof AgentState.State) {
    const { retryWidgets = [], emptyWidgets = [], queryPlan, schema, retryCount = 0 } = state;

    if (retryWidgets.length === 0) {
        return { status: "No widgets need repair. Skipping." };
    }

    console.log(`[SQL Repair] Regenerating SQL for ${retryWidgets.length} widgets (retry ${retryCount})`);

    // Extract failed queries and their context
    const failedQueries = emptyWidgets.map((widget: any) => ({
        widgetId: widget.widgetId,
        widgetTitle: widget.widgetTitle,
        originalSQL: widget.sql,
        error: widget.error,
        dataLength: widget.data?.length || 0
    }));

    // Create enhanced prompt that includes previous failures for learning
    const repairPrompt = `
You are a Senior SQL repair agent. Your task is to regenerate SQL queries that previously returned empty results.

CONTEXT:
- Database Schema: ${JSON.stringify(schema, null, 2)}
- Original Query Plan: ${JSON.stringify(queryPlan, null, 2)}
- Previous Failures: ${JSON.stringify(failedQueries, null, 2)}

INSTRUCTIONS:
1. Analyze why the previous queries returned empty data
2. Generate improved SQL queries that are more likely to return results
3. Consider: broader date ranges, less restrictive filters, alternative aggregations
4. Maintain the original business intent and metrics
5. Apply all SQL validation rules from the original generator

Generate ONLY the SQL queries for the failed widgets. Return in the same format as the original SQL generator.
`;

    // Use shared model initialization with a higher-quality OpenAI fallback for repair tasks.
    const model = createDefaultChatModel({
        logPrefix: "[LLM][SQL_REPAIR]",
        openAIFallbackModel: "gpt-4o",
        temperature: 0.1,
        maxTokens: 4000,
        timeoutMs: 900000,
    });

    try {
        const response = await model.invoke([
            new SystemMessage(repairPrompt),
            new HumanMessage("Please regenerate the SQL queries for the failed widgets:")
        ]);

        // Parse the regenerated SQL from the response
        const repairedSQL = extractJSON(response.content.toString());

        console.log(`[SQL Repair] Successfully regenerated ${Object.keys(repairedSQL).length} SQL queries`);

        return {
            status: `SQL repair completed. Regenerated ${Object.keys(repairedSQL).length} queries.`,
            repairedSQL,
            repairContext: {
                failedQueries,
                retryCount
            },
            messages: [new AIMessage(`[SQL Repair] Regenerated SQL for widgets: ${retryWidgets.join(', ')}`)]
        };

    } catch (error) {
        console.error("[SQL Repair] Error regenerating SQL:", error);
        return {
            status: "SQL repair failed.",
            error: error instanceof Error ? error.message : "Unknown error",
            messages: [new AIMessage(`[SQL Repair] Failed to regenerate SQL: ${error}`)]
        };
    }
}

export async function dataTransformationAgent(state: typeof AgentState.State) { return { status: "Skipped." }; }

import { AIMessage, SystemMessage } from "@langchain/core/messages";

import { connectToPostgres } from "@/app/actions/mcp";
import { createDefaultChatModel } from "@/lib/llm/model";
import { dbGateway } from "@/lib/mcp/server";

import { categorizeDataType, getColumnName, isNumericType, isTemporalType, isTextType } from "./data-type-utils";
import { invokeModelWithRetry as invokeModelWithRetryUtil } from "./llm-utils";
import { AgentState } from "./state";

export interface SchemaDiscoveryOptions {
    enableSemanticSearch?: boolean;
    enableTableKpis?: boolean;
    enableTableMatrix?: boolean;
    enableTableFilters?: boolean;
    projectContext?: string;
}

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

interface QueryExample {
    id: string;
    description: string;
    sql: string;
    results?: any[];
    executionTime?: number;
    error?: string;
}

interface TableFilterSuggestion {
    id: string;
    title: string;
    type: "date_range" | "multi_select" | "entity" | "search" | "range";
    column: string;
    table: string;
    sampleValues?: string[];
    targetTable?: string;
    examples?: {
        sampleValues?: string[];
        sampleQueries?: string[];
        queryToGetValues?: string;
        distinctValues?: string[];
        totalDistinctCount?: number;
        relationshipInfo?: {
            fromTable: string;
            fromColumn: string;
            toTable: string;
            toColumn: string;
        };
    };
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

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][SCHEMA]", timeoutMs: 900000 });

const invokeModelWithRetry = (messages: any[], maxRetries = 3, delay = 2000) =>
    invokeModelWithRetryUtil(getModel, messages, maxRetries, delay);

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
    const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

    columns.forEach((col: any) => {
        const colName = getColumnName(col);
        if (!colName) return;
        const colType = String(col.type || col.data_type || "").toLowerCase();
        const category = categorizeDataType(colType);

        // DATE FILTERS: Multiple queries for temporal analysis
        if (col.isTemporal || category === "temporal") {
            const dateValues = sampleRows
                .map((row) => row?.[colName])
                .filter((val) => val !== null && val !== undefined)
                .map((val) => String(val));

            const distinctDates = Array.from(new Set(dateValues));

            // Multiple date queries for different time-based analysis
            const exampleQueries = [
                `SELECT ${quoteIdent(colName)} FROM ${quoteIdent(tableName)} ORDER BY ${quoteIdent(colName)} DESC LIMIT 5`,
                `SELECT MIN(${quoteIdent(colName)}) as min_date, MAX(${quoteIdent(colName)}) as max_date FROM ${quoteIdent(tableName)}`,
                `SELECT DATE_TRUNC('month', ${quoteIdent(colName)}) as month, COUNT(*) FROM ${quoteIdent(tableName)} GROUP BY month ORDER BY month DESC LIMIT 12`,
                `SELECT DATE_TRUNC('week', ${quoteIdent(colName)}) as week, COUNT(*) FROM ${quoteIdent(tableName)} GROUP BY week ORDER BY week DESC LIMIT 4`,
                `SELECT ${quoteIdent(colName)} FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} >= CURRENT_DATE - INTERVAL '30 days' LIMIT 10`
            ];

            filters.push({
                id: `${tableName}_${colName}_date`,
                title: `${colName} date range`,
                type: "date_range",
                column: colName,
                table: tableName,
                sampleValues: distinctDates.slice(0, 5),
                examples: {
                    sampleValues: distinctDates.slice(0, 5),
                    sampleQueries: exampleQueries,
                    queryToGetValues: `SELECT ${quoteIdent(colName)} FROM ${quoteIdent(tableName)} ORDER BY ${quoteIdent(colName)} DESC LIMIT 5`
                }
            });
        }

        // NUMERIC FILTERS: Single query for numeric analysis
        if (col.isNumeric || category === "numeric") {
            const numericValues = sampleRows
                .map((row) => row?.[colName])
                .filter((val) => val !== null && val !== undefined && !isNaN(Number(val)));

            if (numericValues.length > 0) {
                // Single comprehensive query for numeric data
                const exampleQuery = `SELECT MIN(${quoteIdent(colName)}) as min_value, MAX(${quoteIdent(colName)}) as max_value, AVG(${quoteIdent(colName)}) as avg_value FROM ${quoteIdent(tableName)}`;

                filters.push({
                    id: `${tableName}_${colName}_numeric`,
                    title: `${colName} numeric range`,
                    type: "range",
                    column: colName,
                    table: tableName,
                    sampleValues: numericValues.slice(0, 3).map(String),
                    examples: {
                        sampleValues: numericValues.slice(0, 3).map(String),
                        sampleQueries: [exampleQuery],
                        queryToGetValues: exampleQuery
                    }
                });
            }
        }

        // TEXT FILTERS: One query for text fields
        if (col.isText || category === "text") {
            const values = sampleRows
                .map((row) => row?.[colName])
                .filter((val) => val !== null && val !== undefined)
                .map((val) => String(val));
            const distinct = Array.from(new Set(values));

            if (distinct.length > 0) {
                // Check if this is an enum-like column (low distinct count)
                const isEnum = distinct.length <= 12 || colType.includes("enum");

                if (isEnum) {
                    // ENUM: Multiple queries for exploration
                    const exampleQueries = [
                        `SELECT DISTINCT ${quoteIdent(colName)} FROM ${quoteIdent(tableName)} LIMIT 20`,
                        `SELECT ${quoteIdent(colName)}, COUNT(*) as count FROM ${quoteIdent(tableName)} GROUP BY ${quoteIdent(colName)} ORDER BY count DESC`,
                        `SELECT * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} = '${distinct[0] || "value"}' LIMIT 10`
                    ];

                    filters.push({
                        id: `${tableName}_${colName}_enum`,
                        title: `${colName} enum`,
                        type: "multi_select",
                        column: colName,
                        table: tableName,
                        sampleValues: distinct.slice(0, 6),
                        examples: {
                            distinctValues: distinct.slice(0, 20),
                            totalDistinctCount: distinct.length,
                            sampleQueries: exampleQueries,
                            queryToGetValues: `SELECT DISTINCT ${quoteIdent(colName)} FROM ${quoteIdent(tableName)} LIMIT 20`
                        }
                    });
                } else {
                    // TEXT: Single query for text search
                    const exampleQuery = `SELECT DISTINCT ${quoteIdent(colName)} FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} IS NOT NULL LIMIT 20`;

                    filters.push({
                        id: `${tableName}_${colName}_text`,
                        title: `${colName} search`,
                        type: "search",
                        column: colName,
                        table: tableName,
                        sampleValues: distinct.slice(0, 3),
                        examples: {
                            distinctValues: distinct.slice(0, 10),
                            totalDistinctCount: distinct.length,
                            sampleQueries: [exampleQuery],
                            queryToGetValues: exampleQuery
                        }
                    });
                }
            }
        }
    });

    const foreignKeys = Array.isArray(tableSchema?.foreignKeys) ? tableSchema.foreignKeys : [];
    foreignKeys.forEach((fk: any) => {
        if (!fk?.column_name || !fk?.foreign_table_name) return;

        // Get sample FK values if available
        const fkValues = sampleRows
            .map((row) => row?.[fk.column_name])
            .filter((val) => val !== null && val !== undefined)
            .slice(0, 5);

        const exampleQueries = [
            `SELECT ${quoteIdent(fk.column_name)} FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(fk.column_name)} IS NOT NULL LIMIT 5`,
            `SELECT * FROM ${quoteIdent(tableName)} t JOIN ${quoteIdent(fk.foreign_table_name)} ft ON t.${quoteIdent(fk.column_name)} = ft.${quoteIdent(fk.foreign_column_name || 'id')} LIMIT 5`
        ];

        filters.push({
            id: `${tableName}_${fk.column_name}_entity`,
            title: `${fk.foreign_table_name} filter`,
            type: "entity",
            column: fk.column_name,
            table: tableName,
            targetTable: fk.foreign_table_name,
            sampleValues: fkValues.map(String),
            examples: {
                sampleValues: fkValues.map(String),
                sampleQueries: exampleQueries,
                relationshipInfo: {
                    fromTable: tableName,
                    fromColumn: fk.column_name,
                    toTable: fk.foreign_table_name,
                    toColumn: fk.foreign_column_name || 'id'
                }
            }
        });
    });

    return filters;
}

// Production-ready query execution with MSSQL support, sanitization, timeouts, and caching
const QUERY_TIMEOUT_MS = 5000;
const MAX_RESULTS_PER_QUERY = 3;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

// Simple in-memory cache for query examples
const queryExamplesCache = new Map<string, { timestamp: number; examples: QueryExample[] }>();

function getCacheKey(tableName: string, connectionString: string | null, schemaVersion: string): string {
    return `${tableName}:${connectionString || 'local'}:${schemaVersion}`;
}

function getCachedQueryExamples(cacheKey: string): QueryExample[] | null {
    const cached = queryExamplesCache.get(cacheKey);
    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > CACHE_TTL_MS) {
        queryExamplesCache.delete(cacheKey);
        return null;
    }

    return cached.examples;
}

function setCachedQueryExamples(cacheKey: string, examples: QueryExample[]): void {
    queryExamplesCache.set(cacheKey, {
        timestamp: Date.now(),
        examples
    });

    // Clean up old cache entries periodically
    if (queryExamplesCache.size > 100) {
        const now = Date.now();
        for (const [key, value] of queryExamplesCache.entries()) {
            if (now - value.timestamp > CACHE_TTL_MS) {
                queryExamplesCache.delete(key);
            }
        }
    }
}

function detectIsMssql(connectionString?: string | null): boolean {
    if (!connectionString) return false;
    const lower = connectionString.toLowerCase();
    return lower.startsWith("mssql://") ||
        lower.startsWith("sqlserver://") ||
        lower.includes("server=") ||
        lower.includes("data source=");
}

function sanitizeSqlValue(value: any): string {
    if (value === null || value === undefined) return 'NULL';
    const str = String(value);
    // Remove dangerous characters and limit length
    return str
        .replace(/'/g, "''")  // Escape single quotes
        .replace(/\\/g, "\\\\")  // Escape backslashes
        .replace(/\x00/g, '')  // Remove null bytes
        .substring(0, 100);  // Limit length
}

function truncateResults(results: any[], maxRows: number = MAX_RESULTS_PER_QUERY): any[] {
    if (!Array.isArray(results)) return [];
    return results.slice(0, maxRows).map(row => {
        if (typeof row !== 'object' || row === null) return row;
        const sanitized: any = {};
        Object.entries(row).forEach(([key, value]) => {
            // Sanitize keys
            const safeKey = String(key).replace(/[^a-zA-Z0-9_]/g, '_').substring(0, 64);
            // Sanitize values - mask sensitive data
            sanitized[safeKey] = sanitizeResultValue(value);
        });
        return sanitized;
    });
}

function sanitizeResultValue(value: any): any {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        // Mask potential sensitive data patterns
        if (/password|secret|token|key|auth|credential/i.test(value)) {
            return '***MASKED***';
        }
        // Truncate long strings
        if (value.length > 200) {
            return value.substring(0, 200) + '...';
        }
        return value;
    }
    if (typeof value === 'number') return value;
    if (value instanceof Date) return value.toISOString();
    return String(value).substring(0, 200);
}

async function executeTableQueryExamples(
    tableName: string,
    tableSchema: any,
    connectionString: string | null,
    sampleRows: any[]
): Promise<QueryExample[]> {
    // Check cache first
    const schemaVersion = tableSchema?.columns?.length?.toString() || 'v1';
    const cacheKey = getCacheKey(tableName, connectionString, schemaVersion);
    const cached = getCachedQueryExamples(cacheKey);
    if (cached) {
        console.log(`[QueryExamples] Using cached results for ${tableName}`);
        return cached;
    }

    const isMssql = detectIsMssql(connectionString);
    const quoteIdent = (name: string) => isMssql ? `[${name.replace(/\]/g, ']]')}]` : `"${name.replace(/"/g, '""')}"`;
    const limitClause = (count: number) => isMssql ? `TOP ${count}` : `LIMIT ${count}`;
    const dateSubtraction = (days: number) => isMssql
        ? `DATEADD(day, -${days}, GETDATE())`
        : `CURRENT_DATE - INTERVAL '${days} days'`;
    const likeOperator = () => isMssql ? 'LIKE' : 'ILIKE';

    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const examples: QueryExample[] = [];
    const foreignKeys = Array.isArray(tableSchema?.foreignKeys) ? tableSchema.foreignKeys : [];

    // Find key columns
    const dateCol = columns.find((c: any) => c.isTemporal || categorizeDataType(c.type || c.data_type || "") === "temporal");
    const numericCol = columns.find((c: any) => c.isNumeric || categorizeDataType(c.type || c.data_type || "") === "numeric");
    const textCols = columns.filter((c: any) => c.isText || categorizeDataType(c.type || c.data_type || "") === "text");
    const enumCol = textCols.find((c: any) => {
        const colName = getColumnName(c);
        const values = sampleRows.map(r => r?.[colName]).filter(v => v != null);
        const distinct = new Set(values);
        return distinct.size > 0 && distinct.size <= 12;
    });
    const searchCol = textCols.find((c: any) => {
        const colName = getColumnName(c);
        return /name|title|description|email|username|search/i.test(colName);
    }) || textCols[0];

    const runQueryWithTimeout = async (sql: string, description: string): Promise<QueryExample> => {
        const startTime = Date.now();
        try {
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Query timeout after ${QUERY_TIMEOUT_MS}ms`)), QUERY_TIMEOUT_MS);
            });

            const queryPromise = dbGateway.runQuery(sql, connectionString || undefined);
            const result = await Promise.race([queryPromise, timeoutPromise]);
            const executionTime = Date.now() - startTime;

            return {
                id: "",
                description,
                sql,
                results: truncateResults(Array.isArray(result) ? result : [result]),
                executionTime
            };
        } catch (error: any) {
            return {
                id: "",
                description,
                sql,
                error: error.message || 'Query failed'
            };
        }
    };

    // Query 1: Filter by date range (last 30 days)
    if (dateCol) {
        const colName = getColumnName(dateCol);
        const sql = isMssql
            ? `SELECT ${limitClause(10)} * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} >= ${dateSubtraction(30)}`
            : `SELECT * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} >= ${dateSubtraction(30)} ${limitClause(10)}`;

        const example = await runQueryWithTimeout(
            sql,
            `Filter "${colName}" by date range (last 30 days)`
        );
        example.id = "filter_date_range";
        examples.push(example);
    }

    // Query 2: Search/filter by text
    if (searchCol) {
        const colName = getColumnName(searchCol);
        const sampleValue = sampleRows.find(r => r?.[colName])?.[colName];
        const searchTerm = sampleValue ? sanitizeSqlValue(String(sampleValue)).substring(0, 10) : 'example';

        const sql = isMssql
            ? `SELECT ${limitClause(10)} * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} ${likeOperator()} '%${searchTerm}%'`
            : `SELECT * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} ${likeOperator()} '%${searchTerm}%' ${limitClause(10)}`;

        const example = await runQueryWithTimeout(
            sql,
            `Search "${colName}" by text pattern`
        );
        example.id = "filter_text_search";
        examples.push(example);
    }

    // Query 3: Filter by enum/categorical value
    if (enumCol) {
        const colName = getColumnName(enumCol);
        const values = sampleRows.map(r => r?.[colName]).filter(v => v != null);
        const distinctValues = Array.from(new Set(values));
        const filterValue = sanitizeSqlValue(distinctValues[0] || 'value');

        const sql = isMssql
            ? `SELECT ${limitClause(10)} * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} = '${filterValue}'`
            : `SELECT * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} = '${filterValue}' ${limitClause(10)}`;

        const example = await runQueryWithTimeout(
            sql,
            `Filter "${colName}" by enum value '${filterValue}'`
        );
        example.id = "filter_enum_value";
        examples.push(example);
    }

    // Query 4: Filter by numeric range
    if (numericCol) {
        const colName = getColumnName(numericCol);
        const values = sampleRows.map(r => r?.[colName]).filter(v => v != null && !isNaN(Number(v)));
        const numericValues = values.map(Number).sort((a, b) => a - b);
        const minVal = numericValues[Math.floor(numericValues.length * 0.25)] || 0;
        const maxVal = numericValues[Math.floor(numericValues.length * 0.75)] || 100;

        const sql = isMssql
            ? `SELECT ${limitClause(10)} * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} BETWEEN ${minVal} AND ${maxVal}`
            : `SELECT * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} BETWEEN ${minVal} AND ${maxVal} ${limitClause(10)}`;

        const example = await runQueryWithTimeout(
            sql,
            `Filter "${colName}" by numeric range (${minVal}-${maxVal})`
        );
        example.id = "filter_numeric_range";
        examples.push(example);
    }

    // Query 5: JOIN with related table (if FK exists)
    if (foreignKeys.length > 0) {
        const fk = foreignKeys[0];
        const primaryCol = columns.find((c: any) => c.isPrimary)?.name || columns[0]?.name;

        const sql = isMssql
            ? `SELECT ${limitClause(10)} t.${quoteIdent(primaryCol)}, ft.* FROM ${quoteIdent(tableName)} t JOIN ${quoteIdent(fk.foreign_table_name)} ft ON t.${quoteIdent(fk.column_name)} = ft.${quoteIdent(fk.foreign_column_name)}`
            : `SELECT t.${quoteIdent(primaryCol)}, ft.* FROM ${quoteIdent(tableName)} t JOIN ${quoteIdent(fk.foreign_table_name)} ft ON t.${quoteIdent(fk.column_name)} = ft.${quoteIdent(fk.foreign_column_name)} ${limitClause(10)}`;

        const example = await runQueryWithTimeout(
            sql,
            `JOIN with "${fk.foreign_table_name}" via ${fk.column_name}`
        );
        example.id = "join_related_table";
        examples.push(example);
    }

    // Log summary for debugging
    const successCount = examples.filter(e => !e.error).length;
    console.log(`[QueryExamples] ${tableName}: ${successCount}/${examples.length} queries succeeded`);

    // Cache the results
    setCachedQueryExamples(cacheKey, examples);

    return examples;
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
        summaryLines.push(`Categorical filters: ${categoricalColumns.slice(0, 5).map((c) => `${c.table}.${c.column}`).join(", ")}${categoricalColumns.length > 5 ? " ..." : ""}`);
    }
    if (entityColumns.length > 0) {
        summaryLines.push(`Entity filters: ${entityColumns.slice(0, 5).map((e) => e.from).join(", ")}${entityColumns.length > 5 ? " ..." : ""}`);
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
        summary: summaryLines.join("\n") || "No filterable dimensions detected."
    };
}

async function buildSemanticMatches(tableName: string, tableSchema: any): Promise<TableInsight["semanticMatches"]> {
    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const terms = [tableName, ...columns.map((col: any) => getColumnName(col)).filter(Boolean)];

    // NOTE: Mock semantic service usage removed to strictly follow agent pipeline and ground in actual schema.
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
    options: SchemaDiscoveryOptions,
    connectionString: string | null = null
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

    // Execute 5 efficient query examples with actual results
    if (connectionString) {
        try {
            insight.queryExamples = await executeTableQueryExamples(tableName, tableSchema, connectionString, sampleRows);
        } catch (error) {
            console.warn(`[buildTableInsight] Failed to execute query examples for ${tableName}:`, error);
            insight.queryExamples = [];
        }
    }

    return insight;
}

async function buildTableInsights(
    schemaInfo: Record<string, any>,
    sampleData: Record<string, any[]>,
    tableCounts: Record<string, number> | null,
    options: SchemaDiscoveryOptions,
    connectionString: string | null = null
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
            options,
            connectionString
        );
        if (insight) {
            tableInsights[tableName] = insight;
        }
    }

    return tableInsights;
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
            const colType = (col.type || col.data_type || "").toLowerCase();
            const samples = sampleData[table] || [];
            const values = samples.map((r: any) => r[colName]).filter((v: any) => v !== null && v !== undefined);

            if (isTemporalType(colType)) {
                dateColumns.push({ table, column: colName, type: colType });
            }

            if (isTextType(colType) || colType.includes("enum")) {
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
        summaryLines.push(`Categorical filters: ${categoricalColumns.slice(0, 5).map((c) => `${c.table}.${c.column}`).join(", ")}${categoricalColumns.length > 5 ? " ..." : ""}`);
    }
    if (entityColumns.length > 0) {
        summaryLines.push(`Entity filters: ${entityColumns.slice(0, 5).map((e) => e.from).join(", ")}${entityColumns.length > 5 ? " ..." : ""}`);
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
        summary: summaryLines.join("\n") || "No filterable dimensions detected."
    };
}

async function generateSchemaAnalysis(
    schemaInfo: Record<string, any>,
    sampleData: Record<string, any[]>,
    projectContext?: string
): Promise<string> {
    const tableEntries = Object.entries(schemaInfo);
    const simplifiedSchema = tableEntries.slice(0, 30).map(([table, info]: [string, any]) => {
        const pk = info.columns?.find((c: any) => c.isPrimary)?.name || "id";
        return `- ${table} (PK: ${pk}, ${info.columns?.length || 0} cols)`;
    }).join("\n");

    const limitedSampleData: Record<string, any[]> = {};
    Object.entries(sampleData).slice(0, 3).forEach(([table, rows]) => {
        if (rows && rows.length > 0) {
            const firstRow = rows[0];
            const prunedRow = Object.fromEntries(Object.entries(firstRow).slice(0, 3));
            limitedSampleData[table] = [prunedRow];
        }
    });

    const projectContextBlock = projectContext ? `PROJECT CONTEXT:\n${projectContext}\n` : "";

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
        return String(response.content || "").trim();
    } catch (err: any) {
        console.error("[SCHEMA_LLM_ERROR] Failed to generate semantic analysis:", err?.message || err);
        return "Semantic analysis failed. See raw table data below.";
    }
}

export async function runSchemaDiscovery(
    connectionString?: string,
    options: SchemaDiscoveryOptions = {},
    allowedTables?: string[]
) {
    const envUrl = process.env.POSTGRES_URL || process.env.NEXT_PUBLIC_POSTGRES_URL;
    const targetUrl = connectionString || envUrl;
    const isMssql = (() => {
        const lower = (targetUrl || "").toLowerCase();
        return lower.startsWith("mssql://") || lower.startsWith("sqlserver://") || lower.includes("server=") || lower.includes("data source=");
    })();
    const quoteIdent = (name: string) => {
        if (isMssql) return `[${name.replace(/]/g, "]]")}]`;
        return `"${name.replace(/"/g, '""')}"`;
    };

    if (!targetUrl) {
        throw new Error("Schema discovery requires a configured database connection. Set POSTGRES_URL or connect via the Data Sources panel.");
    }

    const connected = await connectToPostgres(targetUrl);
    if (!connected) {
        throw new Error("Failed to connect to the database. Please verify your connection details.");
    }

    const allTablesResult = await dbGateway.listTables(targetUrl);
    if (!allTablesResult || (allTablesResult as any).error) {
        const errorMsg = (allTablesResult as any)?.error || "Failed to retrieve tables from database.";
        return {
            tables: [],
            schemaInfo: {},
            sampleData: {},
            tableCounts: {},
            relationships: [],
            rawAnalysis: `Database Connection Error: ${errorMsg}. Please check your connection settings.`
        };
    }

    let allTables = Array.isArray(allTablesResult) ? allTablesResult : [];
    if (Array.isArray(allowedTables) && allowedTables.length > 0) {
        const allowedLower = new Set(allowedTables.map((t) => t.toLowerCase()));
        allTables = allTables.filter((t) => t && allowedLower.has(t.toLowerCase()));
    }

    if (!Array.isArray(allTables) || allTables.length === 0) {
        return {
            tables: [],
            schemaInfo: {},
            sampleData: {},
            tableCounts: {},
            relationships: [],
            rawAnalysis: "No tables found in the database. Please verify your connection and ensure tables exist in the 'public' schema."
        };
    }

    const schemaInfo: Record<string, any> = {};
    const sampleData: Record<string, any[]> = {};
    const tableCounts: Record<string, number> = {};
    const relationships: any[] = [];

    for (const tableName of allTables) {
        try {
            const tableSchema = await dbGateway.getTableSchema(tableName, targetUrl);
            if (tableSchema && tableSchema.columns) {
                tableSchema.columns = tableSchema.columns.map((column: any) => ({
                    ...column,
                    name: column.column_name || column.name,
                    type: column.data_type || column.type,
                    category: categorizeDataType(column.data_type || column.type || ""),
                    isNumeric: isNumericType(column.data_type || column.type || ""),
                    isTemporal: isTemporalType(column.data_type || column.type || ""),
                    isText: isTextType(column.data_type || column.type || "")
                }));
            }

            schemaInfo[tableName] = tableSchema;

            const countResult = await dbGateway.runQuery(`SELECT COUNT(*) as count FROM ${quoteIdent(tableName)}`, targetUrl);
            const rawCount = (Array.isArray(countResult) && countResult.length > 0) ? countResult[0].count : 0;
            tableCounts[tableName] = rawCount ? Number(rawCount) : 0;

            const preview = await dbGateway.getTablePreview(tableName, targetUrl);
            sampleData[tableName] = Array.isArray(preview) ? preview : [];

            if (tableSchema.foreignKeys && tableSchema.foreignKeys.length > 0) {
                for (const fk of tableSchema.foreignKeys) {
                    relationships.push({
                        from: { table: tableName, column: fk.column_name },
                        to: { table: fk.foreign_table_name, column: fk.foreign_column_name },
                        type: "many-to-one"
                    });
                }
            }
        } catch {
            schemaInfo[tableName] = { columns: [] };
            sampleData[tableName] = [];
            tableCounts[tableName] = 0;
        }
    }

    const filterCandidates = detectFilterCandidates(schemaInfo, sampleData, tableCounts, relationships);

    const tableInsights = await buildTableInsights(schemaInfo, sampleData, tableCounts, options, targetUrl);
    const visibleColumns: Record<string, string[]> = {};
    const filterableColumns: Record<string, string[]> = {};
    Object.entries(schemaInfo).forEach(([tableName, tableSchema]) => {
        visibleColumns[tableName] = computeVisibleColumns(tableSchema);
        const insight = tableInsights ? tableInsights[tableName] : null;
        filterableColumns[tableName] = computeFilterableColumnsFromInsights(insight);
    });
    const filterCandidatesFromColumns = buildFilterCandidatesFromColumns(schemaInfo, filterableColumns);

    let rawAnalysis = "";
    if (options.enableSemanticSearch) {
        rawAnalysis = await generateSchemaAnalysis(schemaInfo, sampleData, options.projectContext);
    } else {
        rawAnalysis = options.projectContext
            ? `Project context: ${options.projectContext}\nSemantic analysis disabled. Schema profiling only.`
            : "Semantic analysis disabled. Schema profiling only.";
    }

    return {
        tables: allTables,
        schemaInfo,
        sampleData,
        tableCounts,
        relationships,
        tableInsights,
        filterCandidates: filterCandidatesFromColumns || filterCandidates,
        rawAnalysis,
        filterSummary: (filterCandidatesFromColumns || filterCandidates).summary,
        projectContext: options.projectContext || "",
        visibleColumns,
        filterableColumns
    };
}

export async function schemaAgent(state: typeof AgentState.State) {
    const manualSchema = state.context?.manualSchema;
    const schemaSnapshot = state.context?.schemaSnapshot;
    const schemaOptions: SchemaDiscoveryOptions = state.context?.schemaOptions || {};
    const connectionString = state.context?.connectionString || state.context?.dbUrl || state.context?.postgresUrl || null;

    const effectiveOptions: SchemaDiscoveryOptions = {
        ...schemaOptions,
        enableTableKpis: schemaOptions.enableTableKpis ?? true,
        enableTableMatrix: schemaOptions.enableTableMatrix ?? true,
        enableTableFilters: schemaOptions.enableTableFilters ?? true
    };

    if (schemaSnapshot) {
        const schemaInfo = (schemaSnapshot.schemaInfo || schemaSnapshot.schema || {}) as Record<string, any>;
        const sampleData = (schemaSnapshot.sampleData || {}) as Record<string, any[]>;
        const snapshotInsights = schemaSnapshot.tableInsights || schemaSnapshot.dataProfile || null;
        const rawRelationships = schemaSnapshot.relationships || schemaSnapshot.schemaRelationships || [];
        const normalizedRelationships = Array.isArray(rawRelationships)
            ? rawRelationships.map((rel: any) => {
                if (rel?.from?.table && rel?.to?.table) {
                    return {
                        fromTable: rel.from.table,
                        toTable: rel.to.table,
                        via: rel.from.column,
                        type: rel.type || "many-to-one",
                        targetColumn: rel.to.column
                    };
                }
                return rel;
            })
            : [];

        const tableInsights = snapshotInsights || await buildTableInsights(schemaInfo, sampleData, null, effectiveOptions, connectionString);

        return {
            schemaInfo,
            sampleData,
            schemaRelationships: normalizedRelationships,
            dataProfile: tableInsights,
            status: "Using schema snapshot from context.",
            messages: [new AIMessage(`[SCHEMA] Grounded in schema snapshot with ${Object.keys(schemaInfo).length} tables.`)]
        };
    }

    if (manualSchema) {
        const normalizedSchema: Record<string, any> = {};
        const sampleData: Record<string, any[]> = {};
        const relationships: any[] = [];

        Object.entries(manualSchema as Record<string, any>).forEach(([tableName, info]) => {
            if (!info) return;

            const rawColumns =
                Array.isArray(info.columns)
                    ? info.columns
                    : Array.isArray(info.columns?.columns)
                        ? info.columns.columns
                        : Array.isArray(info.schema?.columns)
                            ? info.schema.columns
                            : [];

            const normalizedColumns = rawColumns.map((col: any) => ({
                ...col,
                name: col.name || col.column_name,
                type: col.type || col.data_type,
            }));

            const foreignKeys =
                Array.isArray(info.foreignKeys)
                    ? info.foreignKeys
                    : Array.isArray(info.columns?.foreignKeys)
                        ? info.columns.foreignKeys
                        : [];

            normalizedSchema[tableName] = {
                columns: normalizedColumns,
                primaryKeys: info.primaryKeys || info.columns?.primaryKeys || [],
                foreignKeys,
            };

            if (Array.isArray(info.sampleRows)) {
                sampleData[tableName] = info.sampleRows;
            } else if (Array.isArray(info.sampleData)) {
                sampleData[tableName] = info.sampleData;
            } else {
                sampleData[tableName] = [];
            }

            if (foreignKeys.length > 0) {
                foreignKeys.forEach((fk: any) => {
                    if (!fk?.foreign_table_name || !fk?.foreign_column_name) return;
                    relationships.push({
                        fromTable: tableName,
                        toTable: fk.foreign_table_name,
                        via: fk.column_name,
                        type: "1-to-many",
                        targetColumn: fk.foreign_column_name,
                    });
                });
            }
        });

        const tableInsights = await buildTableInsights(normalizedSchema, sampleData, null, effectiveOptions, connectionString);

        return {
            schemaInfo: normalizedSchema,
            sampleData,
            schemaRelationships: relationships,
            dataProfile: tableInsights,
            status: "Using manual grounding.",
            messages: [new AIMessage(`[SCHEMA] Grounded in manually selected tables: ${Object.keys(normalizedSchema).join(", ")}`)]
        };
    }

    try {
        const focusTable = state.context?.focusTable;
        const allTablesResult = await dbGateway.listTables(connectionString || undefined);
        let allTables: string[] = Array.isArray(allTablesResult) ? allTablesResult : [];

        if (focusTable && allTables.includes(focusTable)) {
            allTables = [focusTable];
        }

        const schemaInfo: Record<string, any> = {};
        const sampleData: Record<string, any[]> = {};
        const relationships: any[] = [];
        const processedTables = new Set<string>();

        const profileTable = async (tableName: string) => {
            if (processedTables.has(tableName)) return;
            processedTables.add(tableName);

            try {
                const [tableSchema, samples] = await Promise.all([
                    dbGateway.getTableSchema(tableName, connectionString || undefined),
                    dbGateway.getTablePreview(tableName, connectionString || undefined)
                ]);

                schemaInfo[tableName] = tableSchema;
                sampleData[tableName] = Array.isArray(samples) ? samples : [];

                if (tableSchema.foreignKeys) {
                    for (const fk of tableSchema.foreignKeys) {
                        relationships.push({
                            fromTable: tableName,
                            toTable: fk.foreign_table_name,
                            via: fk.column_name,
                            type: "1-to-many",
                            targetColumn: fk.foreign_column_name
                        });
                    }
                }
            } catch {
                // noop
            }
        };

        const BATCH_SIZE = 5;
        for (let i = 0; i < allTables.length; i += BATCH_SIZE) {
            const chunk = allTables.slice(i, i + BATCH_SIZE);
            await Promise.all(chunk.map((t) => profileTable(t)));
        }

        const relatedTables = new Set<string>();
        Object.values(schemaInfo).forEach((schema: any) => {
            schema.foreignKeys?.forEach((fk: any) => {
                if (!processedTables.has(fk.foreign_table_name)) {
                    relatedTables.add(fk.foreign_table_name);
                }
            });
        });

        const relatedArray = Array.from(relatedTables);
        for (let i = 0; i < relatedArray.length; i += BATCH_SIZE) {
            const chunk = relatedArray.slice(i, i + BATCH_SIZE);
            await Promise.all(chunk.map((t) => profileTable(t)));
        }

        for (const tableName of Array.from(processedTables)) {
            const schema = schemaInfo[tableName];
            if (schema.foreignKeys && schema.foreignKeys.length >= 2) {
                const isJunction = schema.columns.length <= (schema.foreignKeys.length + 2);
                if (isJunction) {
                    const table1 = schema.foreignKeys[0].foreign_table_name;
                    const table2 = schema.foreignKeys[1].foreign_table_name;
                    relationships.push({
                        fromTable: table1,
                        toTable: table2,
                        via: tableName,
                        type: "many-to-many"
                    });
                }
            }
        }

        const tableInsights = await buildTableInsights(schemaInfo, sampleData, null, schemaOptions, connectionString);

        return {
            schemaInfo,
            sampleData,
            schemaRelationships: relationships,
            dataProfile: tableInsights,
            status: `Canonical database intelligence gathered. Profiled ${processedTables.size} tables and identified ${relationships.length} relationships.`,
            messages: [new AIMessage(`[SCHEMA] Deep profiled ${processedTables.size} entities with full schema and 5-record snapshots. identified junction tables and M:M relations.`)]
        };
    } catch (error: any) {
        return { errors: [`Exhaustive schema grounding failed: ${error.message}`] };
    }
}

export async function schemaDiscoveryAgent(state: typeof AgentState.State) {
    return schemaAgent(state);
}

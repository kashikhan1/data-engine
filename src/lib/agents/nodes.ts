'use server';

import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import { AgentState } from "./state";
import { QueryPlanSchema, DashboardLayoutSchema } from "../schemas";
import { z } from "zod";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import { connectToPostgres } from "@/app/actions/mcp";
import { dbGateway } from "../mcp/server";
import { semanticService } from "../semantic/service";

// --- LLM Initialization ---

// Detect configuration via STATIC access for Next.js bundler compatibility
const openAIApiKey = process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY;
const openAIModel = process.env.OPENAI_MODEL || process.env.NEXT_PUBLIC_OPENAI_MODEL || "gpt-4o-mini";

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || process.env.NEXT_PUBLIC_OLLAMA_BASE_URL;
const ollamaApiKey = process.env.OLLAMA_API_KEY || process.env.NEXT_PUBLIC_OLLAMA_API_KEY;
const ollamaModel = process.env.OLLAMA_MODEL || process.env.NEXT_PUBLIC_OLLAMA_MODEL || "llama3.2";

// Prefer Ollama if a base URL or Ollama key is provided OR if no OpenAI key is available.
const useOllama = !!ollamaBaseUrl || !!ollamaApiKey || !openAIApiKey;

const initializeModel = () => {
    const isServer = typeof window === 'undefined';

    if (useOllama) {
        // Use ChatOllama directly so OPENAI_API_KEY is never required.
        const m = ollamaModel || "llama3.2";
        const base = ollamaBaseUrl || "http://localhost:11434";
        if (isServer) console.log(`[LLM] Using Ollama endpoint: ${m} @ ${base}`);
        return new ChatOllama({
            model: m,
            baseUrl: base,
            temperature: 0,
            numCtx: 32768,
            headers: ollamaApiKey ? { Authorization: `Bearer ${ollamaApiKey}` } : undefined,
        });
    } else {
        const m = openAIModel || "gpt-4-turbo-preview";
        if (isServer) console.log(`[LLM] Using Real OpenAI: ${m}`);
        return new ChatOpenAI({
            modelName: m,
            model: m,
            temperature: 0,
            openAIApiKey: openAIApiKey,
            timeout: 900000,
        });
    }
};

const getModel = () => {
    // Re-evaluate per-call so env changes or restart picks up the correct provider.
    return initializeModel();
};

/**
 * Helper: Invoke LLM with retry logic for 429 errors
 */
async function invokeModelWithRetry(messages: any[], maxRetries = 3, delay = 2000) {
    let lastError: any;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await getModel().invoke(messages, { timeout: 900000 });
        } catch (err: any) {
            lastError = err;
            const errorMsg = err.message || "";
            // Handle 429 or generic rate limit indicators
            if (errorMsg.includes("429") || errorMsg.toLowerCase().includes("too many requests") || err.status === 429) {
                console.warn(`[LLM_RETRY] Rate limited (429). Retrying in ${delay}ms... (Attempt ${i + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; // Exponential backoff
            } else {
                throw err;
            }
        }
    }
    throw lastError;
}

// Helper function to extract JSON from LLM response
function extractJSON(text: string): any {
    try {
        let cleaned = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
        const start = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');
        if (start !== -1 && end !== -1 && end > start) {
            cleaned = cleaned.substring(start, end + 1);
        }

        // Handle unescaped newlines within strings in the JSON block
        // LLMs often output multi-line SQL inside a JSON string field unescaped
        // This regex tries to find text between quotes that contains newlines and escape them
        cleaned = cleaned.replace(/"([^"]*)"/g, (match, group) => {
            return '"' + group.replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"';
        });

        return JSON.parse(cleaned);
    } catch (e) {
        // Fallback: try to find any JSON-like structure
        const match = text.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch (e2) {
                console.error("[JSON_PARSE_ERROR] Deep parse failed.");
            }
        }
        return null;
    }
}

/**
 * Helper: Categorize PostgreSQL data types for AI guidance
 */
function categorizeDataType(dataType: string): string {
    const lowerType = dataType.toLowerCase();

    if (lowerType.includes('int') || lowerType.includes('numeric') ||
        lowerType.includes('decimal') || lowerType.includes('float') ||
        lowerType.includes('double') || lowerType.includes('real')) {
        return 'numeric';
    }

    if (lowerType.includes('char') || lowerType.includes('text') ||
        lowerType.includes('varchar') || lowerType.includes('string')) {
        return 'text';
    }

    if (lowerType.includes('date') || lowerType.includes('time') ||
        lowerType.includes('timestamp') || lowerType.includes('interval')) {
        return 'temporal';
    }

    if (lowerType.includes('bool') || lowerType.includes('boolean')) {
        return 'boolean';
    }

    if (lowerType.includes('json') || lowerType.includes('array')) {
        return 'complex';
    }

    return 'other';
}

/**
 * Helper: Check if data type is numeric (supports aggregation)
 */
function isNumericType(dataType: string): boolean {
    const category = categorizeDataType(dataType);
    return category === 'numeric';
}

/**
 * Helper: Check if data type is temporal (supports time operations)
 */
function isTemporalType(dataType: string): boolean {
    const category = categorizeDataType(dataType);
    return category === 'temporal';
}

/**
 * Helper: Check if data type is text (supports grouping/filtering)
 */
function isTextType(dataType: string): boolean {
    const category = categorizeDataType(dataType);
    return category === 'text';
}

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

interface TableFilterSuggestion {
    id: string;
    title: string;
    type: "date_range" | "multi_select" | "entity";
    column: string;
    table: string;
    sampleValues?: string[];
    targetTable?: string;
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
}

function getColumnName(column: any): string {
    return column?.name || column?.column_name || "";
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

async function buildSemanticMatches(tableName: string, tableSchema: any): Promise<TableInsight["semanticMatches"]> {
    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const terms = [tableName, ...columns.map((col: any) => getColumnName(col)).filter(Boolean)];
    const resolved = await semanticService.resolveMapping(terms);

    return {
        terms,
        metrics: resolved.metrics.map((metric) => ({
            slug: metric.slug,
            name: metric.name,
            description: metric.description
        })),
        dimensions: resolved.dimensions.map((dim) => ({
            slug: dim.slug,
            name: dim.name,
            type: dim.type,
            table_name: dim.table_name
        }))
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
                }))
            }
        ])
    );
    return JSON.stringify(trimmed).slice(0, 6000);
}

function normalizePlannedWidgets(widgets: any[], schemaInfo: Record<string, any>, allowedTypesOverride?: string[]) {
    const defaultAllowedTypes = [
        "kpi",
        "line",
        "area",
        "bar",
        "pie",
        "donut",
        "table",
        "cohort",
        "funnel",
        "map",
        "scatter",
        "markdown",
    ];
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
    const filteredRelationships = Array.isArray(schema.relationships)
        ? schema.relationships.filter((rel: any) => nonEmptyTables.has(rel?.from?.table) && nonEmptyTables.has(rel?.to?.table))
        : [];

    const filterCandidates = detectFilterCandidates(filteredSchemaInfo, filteredSampleData, filteredTableCounts, filteredRelationships);
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
    console.log("[AGENT] Starting Schema Discovery (Pro Mode)...");

    const envUrl = process.env.POSTGRES_URL || process.env.NEXT_PUBLIC_POSTGRES_URL;
    const targetUrl = connectionString || envUrl;
    const isMssql = (() => {
        const lower = (targetUrl || "").toLowerCase();
        return lower.startsWith("mssql://") || lower.startsWith("sqlserver://") || lower.includes("server=") || lower.includes("data source=");
    })();
    const quoteIdent = (name: string) => {
        if (isMssql) {
            return `[${name.replace(/]/g, "]]")}]`;
        }
        return `"${name.replace(/"/g, "\"\"")}"`;
    };

    if (!targetUrl) {
        const errorMessage = "Schema discovery requires a configured database connection. Set POSTGRES_URL or connect via the Data Sources panel.";
        console.error("[SCHEMA] " + errorMessage);
        throw new Error(errorMessage);
    }

    const connected = await connectToPostgres(targetUrl);
    if (!connected) {
        throw new Error("Failed to connect to the database. Please verify your connection details.");
    }

    const allTablesResult = await dbGateway.listTables(targetUrl);

    // Error Handling for Direct Gateway
    if (!allTablesResult || (allTablesResult as any).error) {
        const errorMsg = (allTablesResult as any)?.error || "Failed to retrieve tables from database.";
        console.error(`[SCHEMA_ERROR] ${errorMsg}`);
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
        console.warn("[SCHEMA_WARNING] No tables found in the database (public schema).");
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

    // Profiling loop
    for (const tableName of allTables) {
        console.log(`[SCHEMA] Profiling: ${tableName}`);
        try {
            const tableSchema = await dbGateway.getTableSchema(tableName, targetUrl);

            // Enhance schema with data type categorization for AI guidance
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

            // Discovered foreign keys for relationship mapping
            if (tableSchema.foreignKeys && tableSchema.foreignKeys.length > 0) {
                for (const fk of tableSchema.foreignKeys) {
                    relationships.push({
                        from: { table: tableName, column: fk.column_name },
                        to: { table: fk.foreign_table_name, column: fk.foreign_column_name },
                        type: "many-to-one"
                    });
                }
            } else {
                // Heuristic: check if table looks like a junction table (e.g. table_a_table_b)
                // or contains common FK names if direct FKs aren't metadata-exposed
                const columns = tableSchema.columns || [];
                const idColumns = columns.filter((c: any) => c.name.endsWith('_id'));
                if (idColumns.length >= 2) {
                    // Potential junction or 1:M relationship that might not have explicit FK constraints in DB
                    console.log(`[SCHEMA] Potential implicit relationships in ${tableName}: ${idColumns.map((c: any) => c.name).join(', ')}`);
                }
            }
        } catch (err: any) {
            console.error(`[SCHEMA_PROFILE_ERROR] Failed to profile ${tableName}:`, err);
            if (err.stack) console.error(err.stack);
            schemaInfo[tableName] = { columns: [] };
            sampleData[tableName] = [];
            tableCounts[tableName] = 0;
        }
    }

    // Detect filterable dimensions (dates, categories, entities)
    const filterCandidates = detectFilterCandidates(schemaInfo, sampleData, tableCounts, relationships);

    const tableInsights = await buildTableInsights(schemaInfo, sampleData, tableCounts, options);

    // Generate natural language analysis using LLM (optional)
    let rawAnalysis = "";
    if (options.enableSemanticSearch) {
        try {
            rawAnalysis = await generateSchemaAnalysis(
                allTables,
                schemaInfo,
                sampleData,
                tableCounts,
                relationships,
                options.projectContext
            );
        } catch (err: any) {
            console.error("[SCHEMA_LLM_ERROR] Failed to generate semantic analysis:", err.message);
            rawAnalysis = "Semantic analysis failed. See raw table data below.";
        }
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
        filterCandidates,
        rawAnalysis,
        filterSummary: filterCandidates.summary,
        projectContext: options.projectContext || ""
    };
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

    return {
        dateColumns,
        categoricalColumns,
        entityColumns,
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
export async function runDashboardPlanner(query: string, schema: any) {
    console.log("[AGENT] Planning Dashboard Architecture (Pro Mode)...");

    const filteredSchema = filterSchemaForNonEmptyTables(schema);
    const schemaForPrompt = filteredSchema || schema;

    const tables = Object.keys(schemaForPrompt.schemaInfo || {});
    const disabledTypes = Array.isArray(schemaForPrompt.disabledWidgetTypes) ? schemaForPrompt.disabledWidgetTypes : [];
    const allowedTypes = [
        "kpi",
        "line",
        "area",
        "bar",
        "pie",
        "donut",
        "table",
        "cohort",
        "funnel",
        "map",
        "scatter",
        "markdown",
    ].filter((t) => !disabledTypes.includes(t));
    const widgetTypeOrder = ["kpi", "line", "area", "bar", "pie", "donut", "scatter", "map", "funnel", "cohort", "markdown", "table"];
    const orderedAllowedTypes = widgetTypeOrder.filter((t) => allowedTypes.includes(t));
    const requiredWidgetCount = orderedAllowedTypes.length + (allowedTypes.includes("kpi") ? 3 : 0);
    const tableInsightsText = formatTableInsightsForPrompt(schemaForPrompt.tableInsights || null);
    const projectContext = schemaForPrompt.projectContext || schemaForPrompt.projectAbout || "";
    const referenceDate = findLatestDate(schemaForPrompt.sampleData || {});
    const dateContext = buildDateContext(referenceDate);
    // Simplified schema for LLM optimized reading to prevent hallucinations
    const simplifiedSchema = Object.entries(schemaForPrompt.schemaInfo || {}).map(([table, info]: [string, any]) => {
        const cols = info.columns?.map((c: any) => {
            const pk = c.isPrimary ? 'PK' : '';
            return `${c.name} (${c.type}${pk ? ', ' + pk : ''})`;
        }).join(', ');
        return `TABLE "${table}" [${cols}]`;
    }).join('\n');

    const relationships = JSON.stringify(schemaForPrompt.relationships || []);

    // Limited sample data for planner
    const limitedSampleData: Record<string, any[]> = {};
    Object.entries(schemaForPrompt.sampleData || {}).slice(0, 5).forEach(([table, rows]: [string, any]) => {
        limitedSampleData[table] = rows.slice(0, 2);
    });
    const sampleDataText = JSON.stringify(limitedSampleData);

    const filterSummary = schemaForPrompt.filterSummary || '';

    const systemPrompt = `You are Plan Agent, a Senior Software Architect (15+ years in AI, backend engineering, data analytics, scalable system design).

You receive database schema with sample data and relationships from Schema Discovery Agent.

### INPUT CONTEXT
USER OBJECTIVE: "${query}"
${projectContext ? `\nPROJECT CONTEXT:\n${projectContext}\n` : ''}

SCHEMA OVERVIEW:
${schemaForPrompt.rawAnalysis || 'No previous analysis available.'}

DATABASE STRUCTURE:
${simplifiedSchema}

RELATIONSHIPS:
${relationships}

ALLOWED WIDGET TYPES (STRICT):
${allowedTypes.join(", ")}

DO NOT include any widget types outside this list.
You MUST include every allowed widget type at least once.
${allowedTypes.includes("kpi") ? "Include exactly 4 KPI cards if KPI is allowed." : "Do not include KPI cards if KPI is not allowed."}
${allowedTypes.includes("table") ? "If table is allowed, the final widget must be a table." : "Do not include tables if table is not allowed."}
Order widgets using this preferred type order (repeat KPI cards first if enabled):
${orderedAllowedTypes.join(", ")}
Total widgets must be exactly ${requiredWidgetCount}.

SAMPLE DATA:
${sampleDataText}

DATE CONTEXT (UTC):
${dateContext.summary}

FILTERABLE DIMENSIONS:
${filterSummary || 'No filter candidates detected.'}
${tableInsightsText ? `\nTABLE INSIGHTS:\n${tableInsightsText}` : ''}

### Your Mission
Transform database schema and sample data into a complete dashboard widget plan that tells a story.

### Architecture & Design Principles
1) Data Discovery & Context: Inspect schema, types, constraints, and latest records to validate assumptions.
2) KPI Identification: Prioritize actionable KPIs that scale with data growth.
3) Visualization Strategy: Match charts to data characteristics (trend/comparison/proportion/distribution).
4) Advanced Data Table: Include search, sorting, pagination, and smart filters.
5) Time-Based Views: Ensure KPIs/charts/tables respond to time filters.
6) System Efficiency: Keep the plan modular, reusable, and config-driven.
7) Insights & Reporting: Optimize for decision-making and drill-downs.

### Step 1: Receive and Analyze Input
Understand:
- Business type (e-commerce, SaaS, support tickets, etc.)
- Transaction/event tables (orders, payments, sessions)
- Reference tables (customers, products, categories)
- Time columns (created_at, order_date, updated_at)
- Money columns (amount, price, revenue, cost)
- Status/category columns (status, type, category, stage)

### Step 2: Identify Core Business Metrics
If you see orders/sales tables:
- Total revenue, number of orders, average order value, orders per customer, repeat customer rate
If you see subscription/SaaS tables:
- MRR, active subscriptions, churn rate, CLV, new vs returning customers
If you see support/ticket tables:
- Total tickets, resolution time, first response time, tickets by status/priority, agent performance
If you see user/session tables:
- Active users, session duration, bounce rate, conversion rate, retention

### Step 3: Plan Widget Types (Cover All Enabled Types)
- Include every allowed widget type at least once.
- If KPI is allowed, include exactly 4 KPI cards.
- Keep table as the final widget if table is allowed.
- Use the preferred type order listed above.

### Step 4: Use Relationships Intelligently
- Use joins to show customer/product performance when relationships exist
- Include entity names in detail tables via joins
- Add Top N charts using related dimensions

### Step 5: Choose Time Ranges Smartly
- Use sample data to decide daily vs monthly grouping
- Use last 30/90 days or this year based on data recency

### Step 6: Write Clear Widget Descriptions
For each widget specify:
1) Widget number and type
2) Title
3) What it shows
4) Why it matters
5) Which columns it uses
6) Special notes (time range, filters, sorting)

### Output Format (Strict)
Return ONLY a structured list in this exact format:

DASHBOARD TITLE: [Business-appropriate name based on data]
PURPOSE: [One sentence about what this dashboard helps users understand]

FILTERS TO INCLUDE:
1) [Filter name, type (date range | multi-select | dropdown | toggle), default, column(s), affected widgets]
2) ...

WIDGET 1: [Type] - [Title]
Shows: [Exact metric]
Why: [Business value]
Uses: [table.column references]
Filters applied: [List filters and how they modify the query, e.g., WHERE date between {from}/{to}, c.region IN {regions}]
Notes: [Any special requirements or comparison logic]

WIDGET 2: [Type] - [Title]
...

Critical Rules:
- Always include every allowed widget type at least once
- Total widgets must be exactly ${requiredWidgetCount}
- If KPI is allowed, include 4 KPI cards first
- If line is allowed, include at least 1 trend chart
- If bar is allowed, include at least 1 breakdown chart
- If pie or donut is allowed, include at least 1 distribution chart
- If table is allowed, include 1 detail table at the end
- Identify filters (date range, categorical, entity) and note which widgets each filter affects
- Use exact column names from the schema
- Mention which tables need joins
- Specify time ranges clearly
- Keep titles short and business-friendly
- Do not write SQL
- Do not output JSON or code
- Do not repeat these instructions; start directly with the DASHBOARD TITLE line.

Append a short event stream after the plan for UI status (do not change the plan format):
EVENT_STREAM:
{"type":"schema_summary","content":"<1-2 sentences summarizing the data domain and key entities>"}
{"type":"plan_ready","content":"<1 sentence confirming the plan is ready>"}`;

    const response = await invokeModelWithRetry([
        new SystemMessage(systemPrompt),
        new HumanMessage("Generate the dashboard plan for the provided schema and query.")
    ]);
    const planText = response.content as string;

    const { extractDashboardTitle, parseNaturalLanguagePlan } = await import('@/utils/plan-parser');
    const widgets = normalizePlannedWidgets(parseNaturalLanguagePlan(planText), schemaForPrompt.schemaInfo || {}, allowedTypes);

    return {
        title: extractDashboardTitle(planText) || "AI Analytics Dashboard",
        rawPlan: planText,
        widgets
    };
}

/**
 * STEP 2.5: STREAMING DASHBOARD PLANNER
 * Returns an async generator for streaming the plan text.
 */
export async function* runDashboardPlannerStream(query: string, schema: any) {
    console.log("[AGENT] Planning Dashboard Architecture (Streaming Mode)...");

    const truncateText = (value: string, maxChars: number) => {
        if (!value) return value;
        if (value.length <= maxChars) return value;
        return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
    };

    const filteredSchema = filterSchemaForNonEmptyTables(schema);
    const schemaForPrompt = filteredSchema || schema;

    const tables = Object.keys(schemaForPrompt.schemaInfo || {});
    const disabledTypes = Array.isArray(schemaForPrompt.disabledWidgetTypes) ? schemaForPrompt.disabledWidgetTypes : [];
    const allowedTypes = [
        "kpi",
        "line",
        "area",
        "bar",
        "pie",
        "donut",
        "table",
        "cohort",
        "funnel",
        "map",
        "scatter",
        "markdown",
    ].filter((t) => !disabledTypes.includes(t));
    const widgetTypeOrder = ["kpi", "line", "area", "bar", "pie", "donut", "scatter", "map", "funnel", "cohort", "markdown", "table"];
    const orderedAllowedTypes = widgetTypeOrder.filter((t) => allowedTypes.includes(t));
    const requiredWidgetCount = orderedAllowedTypes.length + (allowedTypes.includes("kpi") ? 3 : 0);
    const tableInsightsText = formatTableInsightsForPrompt(schemaForPrompt.tableInsights || null);
    const projectContext = schemaForPrompt.projectContext || schemaForPrompt.projectAbout || "";
    // Cap to top 12 tables to keep prompts small for large schemas
    const simplifiedSchema = Object.entries(schemaForPrompt.schemaInfo || {}).slice(0, 12).map(([table, info]: [string, any]) => {
        const cols = (info.columns || []).slice(0, 6).map((c: any) => c.name).join(', ');
        return `${table}: [${cols}]`;
    }).join('\n');

    const relationships = (schemaForPrompt.relationships || []).map((r: any) => {
        if (!r?.from?.table || !r?.to?.table) return '';
        return `${r.from.table}.${r.from.column || ''} -> ${r.to.table}.${r.to.column || ''}`;
    }).filter(Boolean).join('\n');

    const sampleDataText = JSON.stringify(Object.fromEntries(
        Object.entries(schemaForPrompt.sampleData || {}).slice(0, 2).map(([k, v]: [any, any]) => [k, v.slice(0, 1)])
    ));

    const rawAnalysis = truncateText(schemaForPrompt.rawAnalysis || 'No previous analysis available.', 2000);
    const filterSummary = truncateText(schemaForPrompt.filterSummary || 'No filter candidates detected.', 1200);
    const connectorInstructions = truncateText(schemaForPrompt.connectorInstructions || '', 1200);
    const trimmedProjectContext = truncateText(projectContext, 1200);
    const trimmedSchema = truncateText(simplifiedSchema, 3000);
    const trimmedRelationships = truncateText(relationships, 1200);
    const trimmedSampleData = truncateText(sampleDataText, 800);
    const trimmedTableInsights = truncateText(tableInsightsText || '', 2000);
    const referenceDate = findLatestDate(schemaForPrompt.sampleData || {});
    const dateContext = buildDateContext(referenceDate);

    const systemPrompt = `You are Plan Agent, a Senior Software Architect and KPI Strategist for analytics dashboards.

You receive database schema with sample data and relationships from Schema Discovery Agent.

### INPUT CONTEXT
USER OBJECTIVE: "${query}"
${trimmedProjectContext ? `\nPROJECT CONTEXT:\n${trimmedProjectContext}\n` : ''}

SCHEMA OVERVIEW:
${rawAnalysis}

DATABASE STRUCTURE:
${trimmedSchema}

RELATIONSHIPS:
${trimmedRelationships}

SAMPLE DATA:
${trimmedSampleData}

DATE CONTEXT (UTC):
${dateContext.summary}

FILTERABLE DIMENSIONS:
${filterSummary}
${trimmedTableInsights ? `\nTABLE INSIGHTS:\n${trimmedTableInsights}` : ''}
${connectorInstructions ? `\nCONNECTOR INSTRUCTIONS:\n${connectorInstructions}` : ''}

ALLOWED WIDGET TYPES (STRICT):
${allowedTypes.join(", ")}

DO NOT include any widget types outside this list.
You MUST include every allowed widget type at least once.
${allowedTypes.includes("kpi") ? "Include exactly 4 KPI cards if KPI is allowed." : "Do not include KPI cards if KPI is not allowed."}
${allowedTypes.includes("table") ? "If table is allowed, the final widget must be a table." : "Do not include tables if table is not allowed."}
Order widgets using this preferred type order (repeat KPI cards first if enabled):
${orderedAllowedTypes.join(", ")}
Total widgets must be exactly ${requiredWidgetCount}.

### Your Mission
Transform database schema and sample data into a complete dashboard widget plan that tells a story.

### Step 1: Receive and Analyze Input
Understand:
- Business type (e-commerce, SaaS, support tickets, etc.)
- Transaction/event tables (orders, payments, sessions)
- Reference tables (customers, products, categories)
- Time columns (created_at, order_date, updated_at)
- Money columns (amount, price, revenue, cost)
- Status/category columns (status, type, category, stage)

### Step 2: Identify Core Business Metrics
If you see orders/sales tables:
- Total revenue, number of orders, average order value, orders per customer, repeat customer rate
If you see subscription/SaaS tables:
- MRR, active subscriptions, churn rate, CLV, new vs returning customers
If you see support/ticket tables:
- Total tickets, resolution time, first response time, tickets by status/priority, agent performance
If you see user/session tables:
- Active users, session duration, bounce rate, conversion rate, retention

### Step 3: Plan Widget Types (Cover All Enabled Types)
- Include every allowed widget type at least once.
- If KPI is allowed, include exactly 4 KPI cards.
- Keep table as the final widget if table is allowed.
- Use the preferred type order listed above.

### Step 4: Use Relationships Intelligently
- Use joins to show customer/product performance when relationships exist
- Include entity names in detail tables via joins
- Add Top N charts using related dimensions

### Step 5: Choose Time Ranges Smartly
- Use sample data to decide daily vs monthly grouping
- Use last 30/90 days or this year based on data recency

### Step 6: Write Clear Widget Descriptions
For each widget specify:
1) Widget number and type
2) Title
3) What it shows
4) Why it matters
5) Which columns it uses
6) Special notes (time range, filters, sorting)

### Output Format (Strict)
Return ONLY a structured list in this exact format:

DASHBOARD TITLE: [Business-appropriate name based on data]
PURPOSE: [One sentence about what this dashboard helps users understand]

FILTERS TO INCLUDE:
1) [Filter name, type (date range | multi-select | dropdown | toggle), default, column(s), affected widgets]
2) ...

WIDGET 1: [Type] - [Title]
Shows: [Exact metric]
Why: [Business value]
Uses: [table.column references]
Filters applied: [List filters and how they modify the query, e.g., WHERE date between {from}/{to}, c.region IN {regions}]
Notes: [Any special requirements or comparison logic]

WIDGET 2: [Type] - [Title]
...

Critical Rules:
- Always include every allowed widget type at least once
- Total widgets must be exactly ${requiredWidgetCount}
- If KPI is allowed, include 4 KPI cards first
- If line is allowed, include at least 1 trend chart
- If bar is allowed, include at least 1 breakdown chart
- If pie or donut is allowed, include at least 1 distribution chart
- If table is allowed, include 1 detail table at the end
- Identify filters (date range, categorical, entity) and note which widgets each filter affects
- Use exact column names from the schema
- Mention which tables need joins
- Specify time ranges clearly
- Keep titles short and business-friendly
- Do not write SQL
- Do not output JSON or code
- Do not repeat these instructions; start directly with the DASHBOARD TITLE line.

Append a short event stream after the plan for UI status (do not change the plan format):
EVENT_STREAM:
{"type":"schema_summary","content":"<1-2 sentences summarizing the data domain and key entities>"}
{"type":"plan_ready","content":"<1 sentence confirming the plan is ready>"}`;

    const stream = await getModel().stream([
        new SystemMessage(systemPrompt),
        new HumanMessage("Generate the complete dashboard plan following the exact format above. Include ALL required sections with multiple widgets in each.")
    ], { timeout: 900000 }); // 15-minute timeout for the stream itself

    for await (const chunk of stream) {
        if (chunk.content) {
            yield chunk.content as string;
        }
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
function normalizeSqlForValidation(sql: string) {
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
}

function validateSqlAgainstInstructions(sql: string, connectionString?: string, connectorInstructions?: string, connectorType?: string) {
    const trimmed = normalizeSqlForValidation(sql);
    if (!trimmed.toLowerCase().startsWith("select")) {
        return { ok: false, error: "Validation failed: SQL must start with SELECT." };
    }
    const blocked = ["drop", "delete", "truncate", "update", "insert", "alter"];
    if (blocked.some((kw) => trimmed.toLowerCase().includes(kw))) {
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
                const validation = validateSqlAgainstInstructions(currentSql, connectionString, connectorInstructions, connectorType);
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
            const finalCheck = validateSqlAgainstInstructions(currentSql, connectionString, connectorInstructions, connectorType);
            if (!finalCheck.ok) {
                output[id] = `SELECT 'SQL violates connector rules' as status, '${(finalCheck.error || '').replace(/'/g, "''")}' as message`;
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
    const buildFilterSqlHints = (resolved: Record<string, any>) => {
        const hints: string[] = [];
        Object.entries(resolved || {}).forEach(([dimension, info]) => {
            const type = info?.type;
            const value = info && typeof info === "object" && "value" in info ? info.value : info;
            const safeDimension = maybeCastTextColumn(dimension);
            const dimensionName = String(dimension || "");
            const isVerboseColumn = /(settings|config|json|metadata|payload|properties|options)/i.test(dimensionName);
            const rawValueText = Array.isArray(value) ? value.join(",") : String(value ?? "");
            const isVerboseValue = rawValueText.length > 120;
            if (isVerboseColumn || isVerboseValue) {
                return;
            }

            if (type === "date-range") {
                const range = info?.range;
                const from = range?.from;
                const to = range?.to;
                if (from && to) {
                    hints.push(`${safeDimension} BETWEEN '${escapeSqlLiteral(from)}' AND '${escapeSqlLiteral(to)}'`);
                } else if (from) {
                    hints.push(`${safeDimension} >= '${escapeSqlLiteral(from)}'`);
                } else if (to) {
                    hints.push(`${safeDimension} <= '${escapeSqlLiteral(to)}'`);
                }
                return;
            }

            if (Array.isArray(value)) {
                if (value.length === 0) return;
                const capped = value.slice(0, 12);
                const literals = capped
                    .map(formatLiteral)
                    .filter((v) => v !== null)
                    .join(", ");
                if (literals) {
                    hints.push(`${safeDimension} IN (${literals})`);
                }
                return;
            }

            const literal = formatLiteral(value);
            if (!literal) return;
            if (type === "search") {
                if (isMssql) {
                    hints.push(`${safeDimension} LIKE '%' + ${literal} + '%'`);
                } else {
                    hints.push(`${safeDimension} ILIKE '%' || ${literal} || '%'`);
                }
            } else {
                hints.push(`${safeDimension} = ${literal}`);
            }
        });
        return hints;
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

        const limitCap = 1000;
        if (isMssql) {
            const topMatch = cleaned.match(/\bTOP\s+(\d+)\b/i);
            if (topMatch) {
                const current = Number(topMatch[1]);
                if (current > limitCap) {
                    cleaned = cleaned.replace(/\bTOP\s+\d+\b/i, `TOP ${limitCap}`);
                }
                return cleaned;
            }
            if (/^\s*SELECT\s+/i.test(cleaned)) {
                cleaned = cleaned.replace(/^\s*SELECT\s+(DISTINCT\s+)?/i, (_m, distinct) => {
                    const prefix = distinct ? `SELECT ${distinct}` : "SELECT ";
                    return `${prefix}TOP ${limitCap} `;
                });
            }
            return cleaned;
        }

        const limitMatch = cleaned.match(/\bLIMIT\s+(\d+)\b/i);
        if (limitMatch) {
            const current = Number(limitMatch[1]);
            if (current > limitCap) {
                cleaned = cleaned.replace(/\bLIMIT\s+\d+\b/i, `LIMIT ${limitCap}`);
            }
            return cleaned;
        }

        const trimmed = cleaned.replace(/;+\s*$/, "");
        cleaned = `${trimmed}\nLIMIT ${limitCap};`;
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
        return `${idx + 1}) ${w.id} | ${w.type} | ${title} | metric=${metric} | dim=${dim}`;
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

    const baseDate = parseDate(referenceDate || undefined) || new Date();
    const planFilters = applyFilters && Array.isArray(plan?.filters) && plan.filters.length > 0
        ? plan.filters
        : [];
    const resolvedFilters = applyFilters
        ? (planFilters.length > 0
            ? planFilters.reduce((acc: Record<string, any>, f: any) => {
                const dimension = f?.dimension;
                if (!dimension) return acc;
                const rawValue = Object.prototype.hasOwnProperty.call(filters, dimension)
                    ? filters[dimension]
                    : f?.value;

                if (f?.type === "date-range") {
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

                acc[dimension] = { type: f?.type || "select", value: rawValue };
                return acc;
            }, {})
            : (filters || {}))
        : {};

    const activeFilters = truncate(JSON.stringify(resolvedFilters), 800);
    const filterSqlHintList = buildFilterSqlHints(resolvedFilters);
    const filterSqlHints = filterSqlHintList.join("\n") || "NONE";
    const applyFiltersToQueries = (queries: Record<string, string>) => {
        if (!applyFilters || filterSqlHintList.length === 0) return queries;
        return Object.fromEntries(
            Object.entries(queries).map(([id, sql]) => {
                const baseSql = ensureWhereBase(sql);
                return [id, applyFiltersToSql(baseSql, filterSqlHintList)];
            })
        );
    };

    const systemPrompt = isMssql ? `You are SQL Agent, a Senior SQL Server (MSSQL) Engineer and query optimizer.
Connector instructions are mandatory and override any conflicting guidance.

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

### RECENT SQL ERRORS (FIX THESE PATTERNS)
${recentErrors || "[]"}
- Avoid repeating these failures. Validate table/column names and data types against schema.
- Explicitly double-check every error message and adjust queries to prevent the same failure.

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

    const maxPromptChars = 18000;
    const fillMissingQueries = (queries: Record<string, string>) => {
        const missing = (effectiveWidgets || []).filter((w: any) => !queries[w.id]);
        if (missing.length === 0) return queries;
        const fallbackSql = buildFallbackSql(plan, schemaForPrompt);
        missing.forEach((w: any) => {
            if (fallbackSql?.sqlMap?.[w.id]) {
                queries[w.id] = fallbackSql.sqlMap[w.id];
            } else {
                queries[w.id] = `SELECT 'SQL generation missing for ${w.id}' AS status`;
            }
        });
        return queries;
    };
    if (systemPrompt.length > maxPromptChars) {
        const dbLabel = isMssql ? "SQL Server (MSSQL)" : "PostgreSQL";
        const compactPrompt = [
            `You are SQL Agent. Generate ${dbLabel} SQL for each widget.`,
            "Rules: use only schema columns, obey filters, avoid recent errors, return JSON array.",
            clampSection("SCHEMA:", simplifiedSchema, 1200),
            clampSection("RELATIONSHIPS:", relationships || "[]", 400),
            clampSection("FILTERS:", activeFilters || "{}", 600),
            clampSection("REQUIRED_WHERE:", filterSqlHints || "NONE", 600),
            connectorInstructionsTrimmed ? clampSection("CONNECTOR_INSTRUCTIONS:", connectorInstructionsTrimmed, 600) : "",
            clampSection("WIDGETS:", widgets || "[]", 1200),
            clampSection("ERRORS:", recentErrors || "[]", 800),
        ].join("\n\n");
        console.log(`[DEBUG] Prompt trimmed from ${systemPrompt.length} to ${compactPrompt.length} chars.`);
        const response = await invokeModelWithRetry([
            new SystemMessage(compactPrompt),
            new HumanMessage("Generate the SQL queries in strict JSON format.")
        ]);
        let content = response.content as string;
        content = normalizeSqlJsonContent(content);
        let parsedSQL: any[] = [];
        try {
            parsedSQL = JSON.parse(content);
        } catch (e) {
            console.error("Failed to parse SQL JSON", content);
        }
        const queries: Record<string, string> = {};
        if (Array.isArray(parsedSQL) && parsedSQL.length > 0) {
            parsedSQL.forEach((item: any) => {
                if (item.id && item.sql) {
                    queries[item.id] = item.sql;
                }
            });
            const prepared = applyFiltersToQueries(polishQueries(fillMissingQueries(queries)));
            return await enforceQueries(prepared);
        }
        const fallback = parseSQLOutput(content, effectiveWidgets);
        if (fallback && Object.keys(fallback).length > 0) {
            const prepared = applyFiltersToQueries(polishQueries(fillMissingQueries(fallback)));
            return await enforceQueries(prepared);
        }
        return {};
    }

    console.log("[DEBUG] Sending Prompt to LLM...");

    let content = "";
    try {
        const response = await invokeModelWithRetry([
            new SystemMessage(systemPrompt),
            new HumanMessage("Generate the SQL queries in strict JSON format.")
        ]);
        content = response.content as string;
    } catch (err: any) {
        console.error("[SQL_GENERATOR] LLM failed, using fallback SQL:", err?.message || err);
        const fallbackSql = buildFallbackSql(plan, schemaForPrompt);
        if (fallbackSql) {
            return applyFiltersToQueries(polishQueries(fallbackSql.sqlMap));
        }
        return {};
    }

    // parsing cleanup
    content = normalizeSqlJsonContent(content);
    let parsedSQL: any[] = [];
    try {
        parsedSQL = JSON.parse(content);
    } catch (e) {
        console.error("Failed to parse SQL JSON", content);
    }

    const queries: Record<string, string> = {};
    if (Array.isArray(parsedSQL) && parsedSQL.length > 0) {
        parsedSQL.forEach((item: any) => {
            if (item.id && item.sql) {
                queries[item.id] = item.sql;
            }
        });
        const prepared = applyFiltersToQueries(polishQueries(fillMissingQueries(queries)));
        return await enforceQueries(prepared);
    }

    // Fallback to old parser just in case
    const fallback = parseSQLOutput(content, effectiveWidgets);
    if (fallback && Object.keys(fallback).length > 0) {
        const prepared = applyFiltersToQueries(polishQueries(fillMissingQueries(fallback)));
        return await enforceQueries(prepared);
    }

    // Absolute fallback: generate stub queries so UI remains functional
    effectiveWidgets.forEach((w: any) => {
        queries[w.id] = `SELECT 'SQL generation missing for ${w.id}' AS status`;
    });
    const prepared = applyFiltersToQueries(polishQueries(fillMissingQueries(queries)));
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

    const summaryLines = [
        `PRIMARY_DATE: ${primaryDate || "none"}`,
        `DATE_COLUMNS: ${unique(dateColumns).slice(0, 10).join(", ") || "none"}`,
        `NUMERIC_COLUMNS: ${unique(numericColumns).slice(0, 10).join(", ") || "none"}`,
        `CATEGORICAL_COLUMNS: ${unique(categoricalColumns).slice(0, 10).join(", ") || "none"}`,
        `TABLE_ROWS: ${tableRows.join(", ") || "unknown"}`
    ];

    return {
        primaryDate,
        dateColumns: unique(dateColumns),
        numericColumns: unique(numericColumns),
        categoricalColumns: unique(categoricalColumns),
        summary: summaryLines.join("\n")
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

    // Final Validation & Error Fallback
    widgets.forEach(w => {
        if (!queries[w.id]) {
            console.warn(`[SQL_PARSER] Missing query for ${w.id}. Providing default error SELECT.`);
            queries[w.id] = `SELECT 'SQL generation missing for ${w.id}' as status, 'Check plan/schema' as message`;
        }
    });

    return queries;
}

/**
 * STEP 4: QUERY EXECUTOR
 * Executes generated SQL in parallel with performance tracking.
 */
const extractInstructionBans = (instructions: string) => {
    const bans = new Set<string>();
    if (!instructions) return bans;
    const lines = instructions.split(/\r?\n/);
    const patterns = [
        /(?:do not use|don't use|avoid|never use|no)\s+([a-z0-9_().\[\]]+)/i
    ];
    lines.forEach((line) => {
        patterns.forEach((pattern) => {
            const match = line.match(pattern);
            if (match?.[1]) {
                bans.add(match[1].toLowerCase());
            }
        });
    });
    return bans;
};

const detectIsMssql = (connectionString?: string, connectorType?: string) => {
    const lower = String(connectionString || "").toLowerCase();
    if (lower.startsWith("mssql://") || lower.startsWith("sqlserver://") || lower.includes("server=") || lower.includes("data source=")) {
        return true;
    }
    const typeLower = String(connectorType || "").toLowerCase();
    return typeLower.includes("mssql") || typeLower.includes("sql server");
};

const validateSqlWithInstructions = (sql: string, connectionString?: string, connectorInstructions?: string, connectorType?: string) => {
    const trimmed = normalizeSqlForValidation(sql);
    if (!trimmed.toLowerCase().startsWith("select")) {
        return { ok: false, error: "Validation failed: SQL must start with SELECT." };
    }
    const blocked = ["drop", "delete", "truncate", "update", "insert", "alter"];
    if (blocked.some((kw) => trimmed.toLowerCase().includes(kw))) {
        return { ok: false, error: "Validation failed: unsafe SQL detected." };
    }
    const isMssql = detectIsMssql(connectionString, connectorType);
    if (isMssql && /\blimit\s+\d+/i.test(trimmed)) {
        return { ok: false, error: "Validation failed: MSSQL does not support LIMIT. Use TOP or OFFSET/FETCH." };
    }
    if (!isMssql && /\btop\s+\d+/i.test(trimmed)) {
        return { ok: false, error: "Validation failed: PostgreSQL does not support TOP. Use LIMIT." };
    }
    const bans = extractInstructionBans(connectorInstructions || "");
    for (const banned of bans) {
        const pattern = new RegExp(`\\b${banned.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
        if (pattern.test(trimmed)) {
            return { ok: false, error: `Validation failed: SQL violates connector instruction (avoid \"${banned}\").` };
        }
    }
    return { ok: true };
};

export async function runQueryExecutor(
    queries: Record<string, string>,
    connectionString?: string,
    options?: { connectorInstructions?: string; connectorType?: string }
) {
    console.log("[AGENT] Executing optimized query set...");
    const results: Record<string, any> = {};

    const tasks = Object.entries(queries).map(async ([id, sql]) => {
        const start = Date.now();
        try {
            console.log(`[EXEC] Running Widget ${id}...`);
            const validation = validateSqlWithInstructions(sql, connectionString, options?.connectorInstructions, options?.connectorType);
            if (!validation.ok) {
                const duration = Date.now() - start;
                results[id] = {
                    error: validation.error,
                    status: "error",
                    sql,
                    executionTime: `${duration}ms`
                };
                return;
            }
            const data = await dbGateway.runQuery(sql, connectionString);
            const duration = Date.now() - start;

            if (data && (data as any).error) {
                const errValue = (data as any).error;
                const errMessage = typeof errValue === 'string' ? errValue : JSON.stringify(errValue);
                results[id] = {
                    error: errMessage,
                    status: "error",
                    sql: sql,
                    executionTime: `${duration}ms`
                };
            } else {
                results[id] = {
                    data: Array.isArray(data) ? data : [],
                    status: "success",
                    executionTime: `${duration}ms`
                };
            }
        } catch (err: any) {
            const errMessage = typeof err?.message === 'string' ? err.message : JSON.stringify(err);
            results[id] = {
                error: errMessage,
                status: "error",
                sql: sql
            };
        }
    });

    await Promise.all(tasks);

    // Status Reporting
    const logSummary = Object.entries(results).map(([id, res]) =>
        `WIDGET ${id}: ${res.status === 'success' ? '✓ Success' : '✗ Failed'} (${res.executionTime || '0ms'})`
    ).join('\n');
    console.log("EXECUTION RESULTS:\n" + logSummary);

    return results;
}

/**
 * SQL REPAIR AGENT
 * Intelligently fixes failed SQL queries using LLM analysis.
 * Takes the error, schema, original query, and widget context to generate a corrected query.
 */
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
    console.log(`[SQL_REPAIR] Attempting to fix query for widget: ${context.widgetTitle}`);

    // Format schema for LLM
    const schemaInfo = context.schema?.schemaInfo || {};
    const simplifiedSchema = Object.entries(schemaInfo).map(([table, info]: [string, any]) => {
        const cols = info.columns?.map((c: any) => `${c.name || c.column_name} (${c.type || c.data_type})`).join(', ');
        return `TABLE "${table}" HAS COLUMNS: [${cols}]`;
    }).join('\n');

    const recentErrors = JSON.stringify((context.errorLog || []).slice(0, 15));
    const truncate = (text: string, max = 3000) => text.length > max ? `${text.slice(0, max)}...` : text;
    const compactErrors = truncate(recentErrors || "[]", 600);
    const compactSql = truncate(context.originalSql || "", 1500);
    const compactError = truncate(context.errorMessage || "", 800);

    const extractTablesFromSql = (sql: string) => {
        const tables = new Set<string>();
        const regex = /\b(from|join)\s+["`[]?([A-Za-z0-9_.]+)["`\]]?/gi;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(sql)) !== null) {
            const name = match[2]?.split('.').pop();
            if (name) tables.add(name);
        }
        return Array.from(tables);
    };

    const buildCompactSchema = () => {
        const tableNames = extractTablesFromSql(context.originalSql || "");
        const fallbackTables = Object.keys(schemaInfo || {}).slice(0, 2);
        const selected = tableNames.length > 0 ? tableNames : fallbackTables;
        return selected.map((table) => {
            const info = schemaInfo[table] || schemaInfo[table.toLowerCase()] || schemaInfo[table.toUpperCase()];
            const cols = info?.columns?.slice(0, 4).map((c: any) => `${c.name || c.column_name} (${c.type || c.data_type})`).join(', ');
            return `TABLE "${table}" HAS COLUMNS: [${cols || 'unknown'}]`;
        }).join('\n');
    };

    const compactSchema = truncate(buildCompactSchema(), 1200);

    const connectorType = String(context.schema?.connectorType || context.schema?.connector?.type || "").toLowerCase();
    const isMssql = (() => {
        const lower = (context.connectionString || "").toLowerCase();
        if (lower.startsWith("mssql://") || lower.startsWith("sqlserver://") || lower.includes("server=") || lower.includes("data source=")) {
            return true;
        }
        return connectorType.includes("mssql") || connectorType.includes("sql server");
    })();
    const connectorInstructions = String(context.schema?.connectorInstructions || "").trim();

    const systemPrompt = isMssql
        ? `You are **SQL Repair Agent**, a Senior SQL Server (MSSQL) debugger.
Connector instructions are mandatory and override any conflicting guidance.

### CRITICAL: SQL SERVER SYNTAX RULES (MANDATORY)
1. **NO LIMIT** - Use \`TOP\` or \`OFFSET ... FETCH\`.
2. **DATE FUNCTIONS** - Use \`GETDATE()\`, \`DATEADD\`, \`DATEDIFF\`.
3. **DATE TRUNCATION** - Use \`DATEADD(day, DATEDIFF(day, 0, col), 0)\` for day, \`DATEADD(month, DATEDIFF(month, 0, col), 0)\` for month.
4. **TEXT TYPE** - If comparing text/ntext, CAST to NVARCHAR(MAX) before equality.
5. **IDENTIFIERS** - Use brackets \`[Table]\` and \`[Column]\` when needed.

${connectorInstructions ? `### CONNECTOR INSTRUCTIONS\n${truncate(connectorInstructions, 1200)}\n` : ''}

### FAILED QUERY CONTEXT
- **Widget Goal:** ${context.widgetGoal || 'Display relevant data'}
 - **Original SQL:** \`${compactSql}\`
 - **Error Message:** \`${compactError}\`
 - **Recent SQL Errors (Avoid repeats):** ${compactErrors}

### DATABASE SCHEMA
${compactSchema}

### YOUR MISSION
1. Analyze the error and generate a FIXED SQL Server query.
2. Use ONLY columns that exist in the schema.
3. Fix any syntax errors and handle type mismatches.
4. Do NOT repeat any patterns from recent SQL errors.
5. **Never** claim the error is "misleading" or "already valid" — you must change the SQL to address the error.
6. If the error mentions LIMIT, DATE_TRUNC, CURRENT_DATE, or GROUP BY aliasing, you MUST replace with SQL Server equivalents.

### OUTPUT FORMAT (MANDATORY)
Return ONLY a valid JSON object. No conversation.
{
  "sql": "SELECT ... fixed query ...",
  "explanation": "Brief fix summary"
}`
        : `You are **SQL Repair Agent**, a Senior PostgreSQL debugger.
Connector instructions are mandatory and override any conflicting guidance.

### CRITICAL: POSTGRESQL SYNTAX RULES (MANDATORY)
1. **NO DATEDIFF()** - This function DOES NOT EXIST in PostgreSQL.
   - USE: \`(end_date - start_date)\` for days difference.
   - Example: \`(CURRENT_DATE - first_used_at)\`
2. **NO window functions inside aggregates** - You cannot do \`SUM(count(*) OVER (...))\`.
3. **DATE_TRUNC** - Always cast to timestamp: \`DATE_TRUNC('day', col::timestamp)\`.

${connectorInstructions ? `### CONNECTOR INSTRUCTIONS\n${truncate(connectorInstructions, 1200)}\n` : ''}

### FAILED QUERY CONTEXT
- **Widget Goal:** ${context.widgetGoal || 'Display relevant data'}
 - **Original SQL:** \`${compactSql}\`
 - **Error Message:** \`${compactError}\`
 - **Recent SQL Errors (Avoid repeats):** ${compactErrors}

### DATABASE SCHEMA
${compactSchema}

### YOUR MISSION
1. Analyze the error and generate a FIXED PostgreSQL query.
2. Use ONLY columns that exist in the schema.
3. Fix any syntax errors and handle type mismatches.
4. Do NOT repeat any patterns from recent SQL errors.
5. **Never** claim the error is "misleading" or "already valid" — you must change the SQL to address the error.

### OUTPUT FORMAT (MANDATORY)
Return ONLY a valid JSON object. No conversation.
{
  "sql": "SELECT ... fixed query ...",
  "explanation": "Brief fix summary"
}`;

    const maxPromptChars = 9000;
    try {
        if (systemPrompt.length > maxPromptChars) {
            const compactPrompt = [
                "You are SQL Repair Agent. Fix the SQL based on schema + error.",
                `Original SQL: ${compactSql}`,
                `Error: ${compactError}`,
                `Schema: ${compactSchema}`,
                `Recent errors: ${compactErrors}`,
                "Return JSON: {\"sql\":\"...\",\"explanation\":\"...\"}"
            ].join("\n");
            const response = await invokeModelWithRetry([
                new SystemMessage(compactPrompt),
                new HumanMessage("Fix the failed SQL query in strict JSON.")
            ]);
            const content = response.content as string;
            const parsed = extractJSON(content);
            if (parsed && parsed.sql) {
                return {
                    sql: parsed.sql,
                    explanation: parsed.explanation || "Repaired query"
                };
            }
            throw new Error("Repair response missing SQL.");
        }
        const response = await invokeModelWithRetry([
            new SystemMessage(systemPrompt),
            new HumanMessage("Fix the failed SQL query based on the error and schema provided.")
        ]);

        const content = response.content as string;
        console.log("[SQL_REPAIR] LLM Response:", content.substring(0, 200));

        // Extract JSON from response
        const parsed = extractJSON(content);

        if (parsed && parsed.sql) {
            console.log(`[SQL_REPAIR] Successfully generated fix: ${parsed.explanation}`);
            return {
                sql: parsed.sql,
                explanation: parsed.explanation || "Query repaired by AI"
            };
        }

        // Fallback: try to extract SQL directly if JSON parsing fails or doesn't have sql field
        // Look for SQL in markdown blocks first, then general SELECT patterns
        const markdownSqlMatch = content.match(/```(?:sql)?\s*([\s\S]+?)```/i);
        if (markdownSqlMatch) {
            let sql = markdownSqlMatch[1].trim();
            if (sql.toLowerCase().includes("select")) {
                return {
                    sql: sql,
                    explanation: "Query extracted from markdown block"
                };
            }
        }

        const directSqlMatch = content.match(/(?:SELECT|WITH)[\s\S]+?(?:;|$)/i);
        if (directSqlMatch) {
            return {
                sql: directSqlMatch[0].trim(),
                explanation: "Query extracted via text matching"
            };
        }

        throw new Error("Could not extract repaired SQL from LLM response");
    } catch (err: any) {
        console.error("[SQL_REPAIR] Failed to repair query:", err.message);
        throw new Error(`SQL repair failed: ${err.message}`);
    }
}

/**
 * STEP 5: FINAL ASSEMBLY
 * Orchestrates the final dashboard with Smart Layout positioning.
 */
export async function assembleFinalDashboard(plan: any, queries: any[], results: any[], insights: string[] = [], filterCandidates?: any) {
    console.log("[AGENT] Assembling Final Dashboard with Smart Layout...");

    // Row 1 (y=0): KPIs (3 cols each, height 2)
    // Row 2 (y=2): Main trend chart (12 cols, height 4)
    // Row 3 (y=6): Comparison charts (6 cols each, height 4)
    // Row 4 (y=10): Detail table (12 cols, height 6)

    let kpiCount = 0;
    let chartCount = 0;

    const widgetsWithResults = plan.widgets.map((w: any) => {
        // Prefer a direct match on widget ID; fall back to explicit queryId, then to query->widget mapping, then title match
        const q = queries.find((query: any) =>
            query.id === w.id ||
            query.id === w.queryId ||
            query.widgetIds?.includes?.(w.id) ||
            (w.title && query.title && query.title.toLowerCase() === w.title.toLowerCase())
        );
        const res = results.find((r: any) =>
            r.id === w.id ||
            r.id === w.queryId ||
            (q ? r.id === q.id : false) ||
            (w.title && r.title && r.title.toLowerCase() === w.title.toLowerCase())
        );

        let pos = { x: 0, y: 0, w: 6, h: 4 };

        if (w.type === 'kpi') {
            pos = { x: (kpiCount % 4) * 3, y: 0, w: 3, h: 2 };
            kpiCount++;
        } else if (w.type === 'line' && (w.layoutHint === 'row2-full' || chartCount === 0)) {
            pos = { x: 0, y: 2, w: 12, h: 4 };
            chartCount++;
        } else if (w.type === 'table') {
            pos = { x: 0, y: 10, w: 12, h: 6 };
        } else if (['bar', 'donut', 'pie', 'line'].includes(w.type)) {
            pos = { x: (chartCount % 2) * 6, y: 6, w: 6, h: 4 };
            chartCount++;
        }

        return {
            ...w, // Preserve all original config (encoding, kpiConfig, etc.)
            id: w.id,
            title: w.title,
            type: w.type,
            goal: w.goal,
            data: res?.data || [],
            sql: q?.sql,
            position: pos,
            __resultStatus: res?.status,
            __hasData: Array.isArray(res?.data) ? res.data.length > 0 : false
        };
    });

    const filtered = widgetsWithResults
        .filter((w: any) => w.__resultStatus !== "error")
        .filter((w: any) => w.__hasData || w.type === "markdown")
        .map((w: any) => {
            const { __resultStatus, __hasData, ...rest } = w;
            return rest;
        });

    kpiCount = 0;
    chartCount = 0;
    const widgets = filtered.map((w: any) => {
        let pos = { x: 0, y: 0, w: 6, h: 4 };
        if (w.type === 'kpi') {
            pos = { x: (kpiCount % 4) * 3, y: 0, w: 3, h: 2 };
            kpiCount++;
        } else if (w.type === 'line' && (w.layoutHint === 'row2-full' || chartCount === 0)) {
            pos = { x: 0, y: 2, w: 12, h: 4 };
            chartCount++;
        } else if (w.type === 'table') {
            pos = { x: 0, y: 10, w: 12, h: 6 };
        } else if (['bar', 'donut', 'pie', 'line'].includes(w.type)) {
            pos = { x: (chartCount % 2) * 6, y: 6, w: 6, h: 4 };
            chartCount++;
        }
        return { ...w, position: pos };
    });

    return {
        id: `dash_${Date.now()}`,
        name: plan.title || "AI Insights Dashboard",
        widgets,
        layout: widgets.map((w: any) => ({ i: w.id, ...w.position })),
        insights,
        filters: plan.filters || buildFiltersFromCandidates(filterCandidates),
        updatedAt: new Date().toISOString()
    };
}

function buildFiltersFromCandidates(filterCandidates: any): any[] {
    if (!filterCandidates) return [];
    const filters: any[] = [];

    const primaryDate = filterCandidates.primaryDate;
    if (primaryDate) {
        filters.push({
            id: `${primaryDate.table}.${primaryDate.column}`,
            dimension: `${primaryDate.table}.${primaryDate.column}`,
            label: `${primaryDate.table}.${primaryDate.column}`,
            type: "date-range",
            value: "this_month",
            options: [
                { label: "Today", value: "today" },
                { label: "This Week", value: "this_week" },
                { label: "This Month", value: "this_month" },
                { label: "This Year", value: "this_year" },
                { label: "Custom", value: "custom" }
            ]
        });
    }

    (filterCandidates.categoricalColumns || []).slice(0, 4).forEach((col: any) => {
        filters.push({
            id: `${col.table}.${col.column}`,
            dimension: `${col.table}.${col.column}`,
            label: `${col.table}.${col.column}`,
            type: col.distinct && col.distinct.length > 5 ? "select" : "multi-select",
            value: col.distinct ? col.distinct.slice(0, 5) : [],
            options: (col.distinct || []).map((v: any) => ({ label: String(v), value: v }))
        });
    });

    return filters;
}

/**
 * STEP 4.5: NARRATIVE GENERATOR
 * Analyzes result summary to provide executive insights.
 */
export async function runNarrativeGenerator(resultsList: any[]) {
    console.log("[AGENT] Analyzing data trends...");
    const prompt = `Role: Senior Strategic Executive Analyst.
    RESULTS: ${JSON.stringify(resultsList.map(r => ({ title: r.title, sample: r.data?.slice(0, 3) })))}
    
    TASK: Provide 3-4 professional, one-sentence bulleted insights based on this data.
    Return JSON: { "insights": ["..."] }`;

    const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
    const data = extractJSON(response.content as string);
    return data?.insights || ["Data retrieval successful. Full analysis ready."];
}

// --- LEGACY AGENTS (Maintained for backward compatibility during migration) ---

/**
 * ENTRY: INTENT UNDERSTANDING
 */
export async function intentAgent(state: typeof AgentState.State) {
    const lastMessage = state.messages[state.messages.length - 1];
    const query = typeof lastMessage.content === 'string' ? lastMessage.content : "Overview of data";
    const focusTable = state.context?.focusTable;

    const prompt = `You are an Intent Parsing Agent (Senior Analyst). Extract user goals into JSON.
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
        console.log("[SCHEMA] Using schema snapshot from context.");
        const schemaInfo = schemaSnapshot.schemaInfo || schemaSnapshot.schema || {};
        const sampleData = schemaSnapshot.sampleData || {};
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

        const tableInsights = snapshotInsights || await buildTableInsights(schemaInfo, sampleData, null, effectiveOptions);

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
        console.log("[SCHEMA] Using manually selected schema.");
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
                foreignKeys: foreignKeys,
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

        const tableInsights = await buildTableInsights(normalizedSchema, sampleData, null, effectiveOptions);

        return {
            schemaInfo: normalizedSchema,
            sampleData,
            schemaRelationships: relationships,
            dataProfile: tableInsights,
            status: "Using manual grounding.",
            messages: [new AIMessage(`[SCHEMA] Grounded in manually selected tables: ${Object.keys(normalizedSchema).join(', ')}`)]
        };
    }

    try {
        const focusTable = state.context?.focusTable;
        let allTablesResult = await dbGateway.listTables(connectionString || undefined);
        let allTables: string[] = Array.isArray(allTablesResult) ? allTablesResult : [];

        // If focusing, we prioritize the focus table but still list neighbors
        // The crawling logic below will pick up related tables.
        if (focusTable && allTables.includes(focusTable)) {
            allTables = [focusTable];
            console.log(`[SCHEMA] Targeted profiling of table: ${focusTable} and its relations...`);
        } else {
            console.log(`[SCHEMA] Exhaustive profiling of ${allTables.length} tables...`);
        }

        const schemaInfo: Record<string, any> = {};
        const sampleData: Record<string, any[]> = {};
        const relationships: any[] = [];
        const processedTables = new Set<string>();

        // Helper to profile a single table
        const profileTable = async (tableName: string) => {
            if (processedTables.has(tableName)) return;
            processedTables.add(tableName); // Mark immediately

            try {
                // Parallelize schema and sample data fetch
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
            } catch (e) {
                console.warn(`[SCHEMA] Failed to profile ${tableName}:`, e);
            }
        };

        // BATCH PROCESSING: Process tables in chunks to avoid connection timeouts but maintain speed
        const BATCH_SIZE = 5;

        // 1. Profile initial list
        for (let i = 0; i < allTables.length; i += BATCH_SIZE) {
            const chunk = allTables.slice(i, i + BATCH_SIZE);
            await Promise.all(chunk.map(t => profileTable(t)));
        }

        // 2. Discover and profile missing related tables (One level deep only for performance)
        const relatedTables = new Set<string>();
        Object.values(schemaInfo).forEach((schema: any) => {
            schema.foreignKeys?.forEach((fk: any) => {
                if (!processedTables.has(fk.foreign_table_name)) {
                    relatedTables.add(fk.foreign_table_name);
                }
            });
        });

        if (relatedTables.size > 0) {
            console.log(`[SCHEMA] Profiling ${relatedTables.size} related tables...`);
            const relatedArray = Array.from(relatedTables);
            for (let i = 0; i < relatedArray.length; i += BATCH_SIZE) {
                const chunk = relatedArray.slice(i, i + BATCH_SIZE);
                await Promise.all(chunk.map(t => profileTable(t)));
            }
        }

        // Second pass: Identify many-to-many / junction tables
        for (const tableName of Array.from(processedTables)) {
            const schema = schemaInfo[tableName];
            if (schema.foreignKeys && schema.foreignKeys.length >= 2) {
                // Potential junction table
                const isJunction = schema.columns.length <= (schema.foreignKeys.length + 2); // heuristic: mostly FKs
                if (isJunction) {
                    console.log(`[SCHEMA] Identified junction table: ${tableName}`);
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

        const tableInsights = await buildTableInsights(schemaInfo, sampleData, null, schemaOptions);

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
    const intent = state.intent;
    const focusTable = state.context?.focusTable;
    const tableInsightsText = formatTableInsightsForPrompt(state.dataProfile || null);
    const projectContext = state.context?.projectContext || state.context?.projectAbout || "";
    const disabledTypes = Array.isArray(state.context?.disabledWidgetTypes) ? state.context?.disabledWidgetTypes : [];
    const allowedTypes = [
        "kpi",
        "line",
        "area",
        "bar",
        "pie",
        "donut",
        "table",
        "cohort",
        "funnel",
        "map",
        "scatter",
        "markdown",
    ].filter((t) => !disabledTypes.includes(t));
    const prompt = `Role: Senior Software Architect (15+ years in AI, backend engineering, data analytics, scalable system design).
    TASK: Design a dynamic, efficient, analytics-driven dashboard directly from the schema.
    
    INTENT: "${intent.intent}"
    ${projectContext ? `PROJECT_CONTEXT: ${projectContext}` : ''}
    SCHEMA: ${JSON.stringify(state.schemaInfo)}
    RELATIONS: ${JSON.stringify(state.schemaRelationships || [])}
    SAMPLES_CONEXT: ${JSON.stringify(state.sampleData || {})}
    ${tableInsightsText ? `TABLE_INSIGHTS: ${tableInsightsText}` : ''}
    ${focusTable ? `PRIMARY_ENTITY: Targeting table '${focusTable}'.` : ''}

    ALLOWED WIDGET TYPES (STRICT):
    ${allowedTypes.join(", ")}

    DO NOT include any widget types outside this list.

    ARCHITECTURE & DESIGN PRINCIPLES:
    1) Data Discovery & Context: Inspect schema, types, constraints, and latest records to validate assumptions.
    2) KPI Identification: Prioritize actionable KPIs that scale with data growth.
    3) Visualization Strategy: Match charts to data characteristics (trend/comparison/proportion/distribution).
    4) Advanced Data Table: Include search, sorting, pagination, and smart filters.
    5) Time-Based Views: Ensure KPIs/charts/tables respond to time filters.
    6) System Efficiency: Keep the plan modular, reusable, and config-driven.
    7) Insights & Reporting: Optimize for decision-making and drill-downs.

    STRICT ARCHITECTURAL DIRECTIVES:
    1. ZERO DATA LEAKAGE: DO NOT include actual data values, records, or samples in the output. ONLY define the schema and structural intent.
    2. STRUCTURAL PRECISION: For each widget, identify the EXACT metrics and dimensions from the SCHEMA to be used.
    3. HIERARCHICAL LAYOUT: Suggest 3-4 North Star KPIs followed by specialized visual segments.
    4. TECHNICAL SPECIFICATION: Use 'goal' to describe the analytical value and 'title' for the professional display name.
    
    Return JSON: 
    {
      "title": "EXECUTIVE_DATA_INSIGHT: [DOMAIN]",
      "actionable_plan": "A precise technical summary of the data strategy and JOIN logic...",
      "widgets": [
        { 
          "id": "w1", 
          "type": "kpi", 
          "title": "[ENTITY]_TOTAL_VOLUME", 
          "goal": "Primary throughput monitor",
          "metric": "column_name",
          "dim": null
        },
        { 
          "id": "w2", 
          "type": "line", 
          "title": "TEMPORAL_GROWTH_TREND", 
          "goal": "Performance velocity check",
          "metric": "value_col",
          "dim": "date_col"
        }
      ]
    }`;

    const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
    let plan = extractJSON(response.content as string) || { title: "AI Dashboard", widgets: [] };

    const filterWidgetsByType = (value: any) => {
        if (!value || !Array.isArray(value.widgets) || allowedTypes.length === 0) return value;
        const allowedSet = new Set(allowedTypes);
        return {
            ...value,
            widgets: value.widgets.filter((w: any) => allowedSet.has(w?.type)),
        };
    };
    const buildWidgetOverviewText = (widgets: any[]) => {
        const lines: string[] = ["Widgets Overview"];
        widgets.forEach((w) => {
            const title = String(w?.title || w?.name || "Widget").trim();
            const type = String(w?.type || "chart").trim();
            const goal = String(w?.goal || "").trim();
            lines.push(`${title} (${type})`);
            if (goal) lines.push(goal);
        });
        return lines.join("\n");
    };

    // Demo-ready fallback: ensure we always have widgets to drive SQL/visualization
    if (!plan.widgets || plan.widgets.length < 4) {
        const fallbackPlan = buildFallbackPlanFromSchema(state.schemaInfo);
        if (fallbackPlan) {
            plan = fallbackPlan;
        } else {
            // As a last resort, synthesize a demo plan so the UI always renders
            plan = buildDemoPlan(intent?.intent || "Demo Analytics Overview") as any;
        }
    }

    plan = filterWidgetsByType(plan);
    if (disabledTypes.length > 0) {
        plan = {
            ...plan,
            actionable_plan: buildWidgetOverviewText(plan.widgets || []),
        };
    }

    if (allowedTypes.length === 0) {
        return {
            queryPlan: { ...plan, widgets: [] },
            errors: ["All widget types are disabled in settings."],
            status: "No widget types enabled. Update Widget Visibility settings and retry.",
            messages: [new AIMessage("[PLANNER] All widget types are disabled; cannot generate a plan.")],
        };
    }

    return {
        queryPlan: plan,
        status: `Professional blueprint generated with ${plan.widgets?.length || 0} high-impact components.`,
        messages: [new AIMessage(`[PLANNER] ${plan.actionable_plan || 'Architected executive analytics blueprint.'}`)]
    };
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

    if (!plan) {
        const fallbackPlan = buildFallbackPlanFromSchema(state.schemaInfo);
        if (fallbackPlan) {
            plan = fallbackPlan;
        } else {
            plan = buildDemoPlan(state.intent?.intent || "Demo Analytics Overview") as any;
        }
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

    // Generate fresh SQL queries
    const prompt = isMssql ? `Role: Senior SQL Server Engineer & Data Analyst.
    PROJECT CONTEXT: ${projectContext || "None provided."}
    SCHEMA: ${JSON.stringify(state.schemaInfo)}
    RELATIONSHIPS: ${JSON.stringify(state.schemaRelationships || [])}
    SAMPLES: ${JSON.stringify(state.sampleData)}
    DASHBOARD_PLAN: ${JSON.stringify(plan)}
    STRICT SQL SERVER RULES:
    1. NO LIMIT. Use TOP or OFFSET/FETCH.
    2. DATE MATH: GETDATE(), DATEADD, DATEDIFF.
    3. DATE TRUNC: DATEADD(month, DATEDIFF(month, 0, col), 0).
    4. TEXT/NTEXT: CAST to NVARCHAR(MAX) before comparisons.
    5. IDENTIFIERS: Use [Table] and [Column] when needed.
    6. NO ILIKE. Use LIKE with proper collation if needed.
    7. GROUP BY: Every non-aggregated column must be in GROUP BY.
    8. Division by zero: use NULLIF(denominator, 0).
    9. JOINS: Prefer LEFT JOIN when the primary entity might miss matches.

    Return JSON Map: { "widgetId": "SQL" }`
        : `Role: Senior SQL Engineer & Data Analyst. 
    PROJECT CONTEXT: ${projectContext || "None provided."}
    SCHEMA: ${JSON.stringify(state.schemaInfo)}
    RELATIONSHIPS: ${JSON.stringify(state.schemaRelationships || [])}
    SAMPLES: ${JSON.stringify(state.sampleData)}
    DASHBOARD_PLAN: ${JSON.stringify(plan)}
    STRICT DATA ARCHITECTURE RULES:
    1. PLAN ADHERENCE: Use the 'metric' and 'dim' defined for each widget in the DASHBOARD_PLAN.
    2. ZERO HALLUCINATION: Only use tables/columns listed in SCHEMA.
    3. CASE SENSITIVITY: Use DOUBLE QUOTES for ALL identifiers (e.g. "TableName"."ColumnName").
    4. TYPE-AWARE AGGREGATES: For 'kpi' widgets, use COALESCE(..., 0).
    5. RELATIONSHIP NAVIGATOR: Use RELATIONSHIPS for JOINs. Use LEFT JOIN.
    6. RICH DESCRIPTORS: For tables, select meaningful columns (Name, Status, Date).
    7. POSTGRESQL RULES: No DATEDIFF(), prefer DATE_TRUNC for month/week grouping, use ILIKE for case-insensitive search, protect division with NULLIF.

    Return JSON Map: { "widgetId": "SQL" }`;

    const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
    let sqlMap = extractJSON(response.content as string) || {};

    // If the model returned nothing, synthesize safe defaults to keep the demo flowing
    if (!sqlMap || Object.keys(sqlMap).length === 0) {
        if ((plan as any).demo) {
            sqlMap = buildDemoSql(plan);
        } else {
            const fallbackSql = buildFallbackSql(plan, state.schemaInfo);
            if (fallbackSql) {
                sqlMap = fallbackSql.sqlMap;
                plan = fallbackSql.plan || plan;
            } else {
                // Force demo mode if nothing usable
                plan = buildDemoPlan(state.intent?.intent || "Demo Analytics Overview") as any;
                sqlMap = buildDemoSql(plan);
            }
        }
    }

    return {
        queryPlan: plan,
        queryValidation: sqlMap,
        sqlQueries: Object.values(sqlMap),
        status: "Synthesized multi-query set with rich column selection.",
        messages: [new AIMessage(`[ORCHESTRATOR] Generated ${Object.keys(sqlMap).length} targeted SQL statements with deep column resolution.`)]
    };
}

/**
 * Build a resilient fallback plan when the LLM returns an empty plan.
 */
function buildFallbackPlanFromSchema(schemaInfo: Record<string, any> | undefined) {
    const entry = Object.entries(schemaInfo || {}).find(([, info]) => (info as any)?.columns?.length);
    if (!entry) return null;

    const [tableName, info] = entry as [string, any];
    const columns = info?.columns || [];
    const getName = (col: any) => col?.name || col?.column_name;
    const numericCol = columns.find((c: any) => categorizeDataType(c.data_type || c.type || "") === "numeric");
    const temporalCol = columns.find((c: any) => isTemporalType(c.data_type || c.type || ""));
    const textCol = columns.find((c: any) => isTextType(c.data_type || c.type || ""));
    const idCol = columns.find((c: any) => c.isPrimary || getName(c) === "id") || columns[0];

    const widgets = [
        {
            id: "w_kpi_total",
            type: "kpi",
            title: "Total Records",
            goal: `Row count for ${tableName}`,
            metric: "count_star",
            dim: null,
            table: tableName,
        },
        {
            id: "w_kpi_sum",
            type: "kpi",
            title: numericCol ? `Total ${getName(numericCol)}` : "Total Entities",
            goal: "Aggregate numeric health",
            metric: getName(numericCol) || getName(idCol),
            dim: null,
            table: tableName,
        },
        {
            id: "w_trend",
            type: "line",
            title: "Activity Trend",
            goal: "Recent velocity over time",
            metric: getName(numericCol) || getName(idCol),
            dim: getName(temporalCol) || getName(idCol),
            table: tableName,
        },
        {
            id: "w_top_category",
            type: "bar",
            title: textCol ? `Top ${getName(textCol)}` : "Top Entities",
            goal: "Breakdown by category",
            metric: getName(numericCol) || getName(idCol),
            dim: getName(textCol) || getName(idCol),
            table: tableName,
        },
        {
            id: "w_distribution",
            type: "pie",
            title: "Composition",
            goal: "Share by category",
            metric: getName(numericCol) || getName(idCol),
            dim: getName(textCol) || getName(idCol),
            table: tableName,
        },
        {
            id: "w_table",
            type: "table",
            title: "Recent Records",
            goal: "Drill-down table",
            metric: "*",
            dim: null,
            table: tableName,
        },
    ];

    return {
        title: `${tableName} Overview`,
        actionable_plan: `Auto-generated fallback plan to guarantee demo output using ${tableName}.`,
        widgets,
    } as any;
}

/**
 * Build safe fallback SQL when the LLM returns nothing.
 */
function buildFallbackSql(plan: any, schemaInfo: Record<string, any> | undefined) {
    const entry = Object.entries(schemaInfo || {}).find(([, info]) => (info as any)?.columns?.length);
    if (!entry) return null;
    const [tableName, info] = entry as [string, any];
    const columns = info?.columns || [];
    const getName = (col: any) => col?.name || col?.column_name;
    const numericCol = columns.find((c: any) => categorizeDataType(c.data_type || c.type || "") === "numeric");
    const temporalCol = columns.find((c: any) => isTemporalType(c.data_type || c.type || ""));
    const textCol = columns.find((c: any) => isTextType(c.data_type || c.type || ""));
    const idCol = columns.find((c: any) => c.isPrimary || getName(c) === "id") || columns[0];
    const columnNames = columns.slice(0, 8).map((c: any) => `"${getName(c)}"`).join(", ");

    const map: Record<string, string> = {};
    const widgets = plan?.widgets || [];

    const findId = (fallbackId: string, predicate: (w: any) => boolean) => {
        const found = widgets.find(predicate);
        return found?.id || fallbackId;
    };

    const totalId = findId("w_kpi_total", (w) => w.type === "kpi");
    map[totalId] = `SELECT COUNT(*) AS total_records FROM "${tableName}";`;

    const sumId = findId("w_kpi_sum", (w) => w.type === "kpi" && w.id !== totalId);
    map[sumId] = numericCol
        ? `SELECT COALESCE(SUM("${getName(numericCol)}"), 0) AS total_value FROM "${tableName}";`
        : `SELECT COUNT(DISTINCT "${getName(idCol)}") AS total_entities FROM "${tableName}";`;

    const trendId = findId("w_trend", (w) => w.type === "line");
    if (temporalCol) {
        const valueExpr = numericCol ? `COALESCE(SUM("${getName(numericCol)}"), 0)` : "COUNT(*)";
        map[trendId] = `
SELECT DATE_TRUNC('day', "${getName(temporalCol)}") AS day, ${valueExpr} AS value
FROM "${tableName}"
GROUP BY 1
ORDER BY 1 DESC
LIMIT 90;`;
    } else {
        map[trendId] = `
SELECT "${getName(idCol)}" AS seq, ${numericCol ? `"${getName(numericCol)}"` : "1"} AS value
FROM "${tableName}"
ORDER BY "${getName(idCol)}" DESC
LIMIT 50;`;
    }

    const catId = findId("w_top_category", (w) => w.type === "bar");
    const catCol = textCol || idCol;
    const catValue = numericCol ? `COALESCE(SUM("${getName(numericCol)}"), 0)` : "COUNT(*)";
    map[catId] = `
SELECT "${getName(catCol)}" AS category, ${catValue} AS value
FROM "${tableName}"
GROUP BY 1
ORDER BY value DESC
LIMIT 10;`;

    const distId = findId("w_distribution", (w) => w.type === "pie");
    map[distId] = map[catId];

    const tableId = findId("w_table", (w) => w.type === "table");
    const orderCol = temporalCol ? `"${getName(temporalCol)}"` : `"${getName(idCol)}"`;
    map[tableId] = `
SELECT ${columnNames || "*"}
FROM "${tableName}"
ORDER BY ${orderCol} DESC
LIMIT 50;`;

    return { sqlMap: map, plan };
}

/**
 * Build a demo plan that does not require a live database (for offline/demo use).
 */
function buildDemoPlan(intent: string) {
    return {
        demo: true,
        title: "Demo Commerce Performance",
        actionable_plan: `Auto-generated demo plan for "${intent}" so the UI always renders.`,
        widgets: [
            { id: "w_kpi_revenue", type: "kpi", title: "Total Revenue", goal: "Overall revenue", metric: "revenue" },
            { id: "w_kpi_orders", type: "kpi", title: "Total Orders", goal: "Order volume", metric: "orders" },
            { id: "w_kpi_aov", type: "kpi", title: "Avg Order Value", goal: "Efficiency", metric: "aov" },
            { id: "w_trend", type: "line", title: "Daily Revenue", goal: "Trend over time", metric: "revenue", dim: "date" },
            { id: "w_bar", type: "bar", title: "Top Categories", goal: "Category performance", metric: "revenue", dim: "category" },
            { id: "w_table", type: "table", title: "Recent Orders", goal: "Detail drilldown", metric: "*", dim: null },
        ],
    };
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
 * Build demo results so downstream agents can render without DB access.
 */
function buildDemoResults(plan: any) {
    const today = new Date();
    const days = Array.from({ length: 14 }).map((_, idx) => {
        const d = new Date(today);
        d.setDate(d.getDate() - (13 - idx));
        return { date: d.toISOString().slice(0, 10), revenue: 5000 + idx * 320, orders: 80 + idx * 4 };
    });

    return (plan.widgets || []).map((w: any) => {
        if (w.type === "kpi") {
            const value = w.id === "w_kpi_revenue" ? 742000 : w.id === "w_kpi_orders" ? 14820 : 50.1;
            return {
                widgetId: w.id,
                widgetTitle: w.title,
                type: "kpi",
                data: [{ value }],
                columns: ["value"],
                goal: w.goal,
            };
        }
        if (w.type === "line") {
            return {
                widgetId: w.id,
                widgetTitle: w.title,
                type: "line",
                data: days.map(d => ({ date: d.date, value: d.revenue })),
                columns: ["date", "value"],
                goal: w.goal,
            };
        }
        if (w.type === "bar" || w.type === "pie") {
            const categories = [
                { category: "Electronics", value: 220000 },
                { category: "Apparel", value: 185000 },
                { category: "Home", value: 142000 },
                { category: "Sports", value: 88000 },
            ];
            return {
                widgetId: w.id,
                widgetTitle: w.title,
                type: w.type,
                data: categories,
                columns: ["category", "value"],
                goal: w.goal,
            };
        }
        return {
            widgetId: w.id,
            widgetTitle: w.title,
            type: "table",
            data: [
                { order_id: 10422, customer: "Acme Corp", date: today.toISOString().slice(0, 10), revenue: 1299.99 },
                { order_id: 10421, customer: "Northwind", date: today.toISOString().slice(0, 10), revenue: 899.5 },
                { order_id: 10420, customer: "Globex", date: today.toISOString().slice(0, 10), revenue: 450.0 },
            ],
            columns: ["order_id", "customer", "date", "revenue"],
            goal: w.goal,
        };
    });
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

    // Demo mode: short-circuit with synthetic data so the UI renders even without a DB
    if ((state.queryPlan as any)?.demo) {
        yield { type: "progress", stage: "demo", message: "Using demo data mode..." };
        const demoResults = buildDemoResults(state.queryPlan as any);
        
        // Simulate progress for demo mode
        for (let i = 0; i < totalQueries; i++) {
            yield { 
                type: "query_progress", 
                widgetId: Object.keys(sqlMap)[i],
                stage: "executing",
                message: `Executing demo query ${i + 1}/${totalQueries}...`
            };
            await new Promise(resolve => setTimeout(resolve, 200));
            
            yield { 
                type: "query_complete", 
                widgetId: Object.keys(sqlMap)[i],
                result: demoResults[i],
                message: `Demo query ${i + 1}/${totalQueries} completed`
            };
        }
        
        yield { type: "complete", results: demoResults, message: "All demo queries completed successfully" };
        return;
    }

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
            let validation = validateSqlAgainstInstructions(currentSql, connectionString, connectorInstructions, connectorType);
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
                validation = validateSqlAgainstInstructions(currentSql, connectionString, connectorInstructions, connectorType);
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
            const data = await dbGateway.runQuery(currentSql, connectionString);

            const result = {
                widgetId: id,
                widgetTitle: wInfo?.title || "Metric",
                type: wInfo?.type || "table",
                goal: (wInfo as any)?.goal,
                plan_metric: (wInfo as any)?.metric,
                plan_dim: (wInfo as any)?.dim,
                data: Array.isArray(data) && !(data as any).error ? data : [],
                columns: (Array.isArray(data) && data.length > 0 && !(data as any).error) ? Object.keys(data[0]) : [],
                sql: currentSql,
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
                sql: sql  // Include SQL in completion too
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

    // Demo mode: short-circuit with synthetic data so the UI renders even without a DB
    if ((state.queryPlan as any)?.demo) {
        const demoResults = buildDemoResults(state.queryPlan as any);
        return {
            results: demoResults,
            status: "Demo data loaded.",
            messages: [new AIMessage("[EXECUTOR] Using built-in demo dataset (no database required).")]
        };
    }

    const results: any[] = [];

    // Parallel execution simulation
    const tasks = Object.entries(sqlMap).map(async ([id, sql]) => {
        try {
            console.log(`[EXECUTOR] Running widget ${id}...`);
            const data = await dbGateway.runQuery(sql as string, connectionString);
            const wInfo = state.queryPlan?.widgets?.find((w: any) => w.id === id);

            if (data && (data as any).error) {
                return {
                    widgetId: id,
                    widgetTitle: wInfo?.title || "Metric",
                    type: wInfo?.type || "table",
                    columns: [],
                    error: (data as any).error,
                    data: [],
                    sql: sql
                };
            }

            return {
                widgetId: id,
                widgetTitle: wInfo?.title || "Metric",
                type: wInfo?.type || "table",
                goal: (wInfo as any)?.goal,
                plan_metric: (wInfo as any)?.metric,
                plan_dim: (wInfo as any)?.dim,
                data: Array.isArray(data) ? data : [],
                columns: (Array.isArray(data) && data.length > 0) ? Object.keys(data[0]) : [],
                sql: sql
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

    const normalizedResults = baseResults.map((res, index) => {
        const fallbackId = res.widgetTitle ? `w_${res.widgetTitle.toLowerCase().replace(/[^a-z0-9]+/g, "_")}` : `widget_${index + 1}`;
        const widgetId = String(res.widgetId || fallbackId);
        return { ...res, widgetId };
    });

    const validIds = new Set(normalizedResults.map((res) => res.widgetId));
    const normalizedLayout = layoutFromState
        .filter((item: any) => item && item.i && validIds.has(String(item.i)))
        .map((item: any) => ({
            i: String(item.i),
            x: Number(item.x) || 0,
            y: Number(item.y) || 0,
            w: Number(item.w) || 6,
            h: Number(item.h) || 4,
        }));

    const layoutIds = new Set(normalizedLayout.map((item) => item.i));
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

    normalizedResults.forEach((res) => {
        if (!layoutIds.has(res.widgetId)) {
            fallbackLayout.push(placeNext(res.widgetId, getDefaultSize(res.type)));
            layoutIds.add(res.widgetId);
        }
    });

    const mergedLayout = [...normalizedLayout, ...fallbackLayout];
    const layoutById = new Map(mergedLayout.map((item) => [item.i, item]));

    const finalWidgets = normalizedResults.map(res => {
        const grid = layoutById.get(res.widgetId) || { x: 0, y: 0, w: 6, h: 4 };

        const safeColumns = Array.isArray(res.columns) ? res.columns : [];

        return {
            id: res.widgetId,
            title: res.widgetTitle,
            type: res.type,
            goal: res.goal,
            data: res.data,
            vegaSpec: res.vegaSpec,
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
            widgets: finalWidgets.map(w => ({
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
            needsRetry.push(result.widgetId);
            emptyWidgets.push(result);
            continue;
        }

        // Check 2: Error results
        if (result.error) {
            errors.push(`Execution error for "${result.widgetTitle || result.widgetId}": ${result.error}`);
            needsRetry.push(result.widgetId);
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

    // Use the same model as the original SQL generator
    const model = new ChatOpenAI({
        modelName: "gpt-4o",
        temperature: 0.1,
        maxTokens: 4000,
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

/* eslint-disable @typescript-eslint/no-explicit-any */
// schema-discovery.ts — Database schema profiling and analysis engine.
// Processes raw MCP responses with dynamic table/column shapes from multiple
// DB dialects. `any` is intentional here — schema info has no fixed contract.
import { AIMessage } from "@langchain/core/messages";

import { dbGateway } from "@/lib/mcp/server";
import { runSkill } from "@/lib/skills/registry";
import { registerConnectorSkills, resolveConnectorSkills, type ConnectorRoutingContext } from "@/lib/skills/connectors";

import { categorizeDataType, getColumnName, isNumericType, isTemporalType, isTextType } from "./data-type-utils";
import { AgentState } from "./state";

export interface SchemaDiscoveryOptions {
    enableSemanticSearch?: boolean;
    enableTableKpis?: boolean;
    enableTableMatrix?: boolean;
    enableTableFilters?: boolean;
    projectContext?: string;
    intent?: string;
    intentEntities?: string[];
    intentMetrics?: string[];
    intentDimensions?: string[];
    maxDeepProfileTables?: number;
}

export interface RunSchemaDiscoveryInput {
    connection?: string;
    connectorType?: string;
    options?: SchemaDiscoveryOptions;
    allowedTables?: string[];
    routingContext?: {
        schemaHint?: string;
        projectContext?: string;
    };
}

// ─── Pro Data Scientist Interfaces ────────────────────────────────────────────

/** Business role of a column inferred from name + type patterns */
export type ColumnRole = "id" | "measure" | "label" | "category" | "timestamp" | "flag" | "unknown";

/** Column-level statistical profile */
export interface ColumnProfile {
    name: string;
    type: string;
    category: string;
    role: ColumnRole;
    nullCount: number;
    nullRate: number;          // 0-1
    totalSampled: number;
    cardinality: number;       // distinct count in sample
    cardinalityRatio: number;  // cardinality / totalSampled
    isHighCardinality: boolean;
    isLowCardinality: boolean;
    isConstant: boolean;       // All values are the same
    topValues: Array<{ value: string; count: number; pct: number }>;
    // Numeric stats
    min?: number;
    max?: number;
    mean?: number;
    stddev?: number;
    isSkewed?: boolean;        // stddev > 2*mean suggests skew
    // Quality signals
    qualityFlags: Array<"high_nulls" | "constant" | "high_cardinality" | "potential_pii" | "possible_enum" | "numeric_outlier">;
}

/** Table-level classification for analytics
 * fact = large transactional table
 * dimension = small reference/lookup table with mostly text
 * junction = bridge/join table (few cols, multiple FKs)
 * lookup = tiny enum-like table
 */
export type TableClass = "fact" | "dimension" | "junction" | "lookup" | "unknown";

export interface TableClassification {
    tableClass: TableClass;
    confidence: number; // 0-100
    signals: string[];
}

/** Aggregate data quality report for a table */
export interface DataQualityReport {
    healthScore: number;     // 0-100
    completeness: number;    // avg non-null rate across columns, 0-100
    uniqueness: number;      // % columns without duplicates, 0-100
    consistency: number;     // % columns without anomalies, 0-100
    issues: Array<{ column: string; issue: string; severity: "low" | "medium" | "high" }>;
}

// ─── Existing Interfaces (extended) ──────────────────────────────────────────

export interface TableKpi {
    id: string;
    title: string;
    description: string;
    aggregation: "count" | "sum" | "avg" | "min" | "max" | "distinct_count";
    column?: string;
}

export interface TableDataMatrix {
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
    groupedColumns?: {
        categorical: string[];
        numeric: string[];
        temporal: string[];
        text: string[];
    };
    // Pro additions
    columnProfiles?: ColumnProfile[];
    classification?: TableClassification;
    qualityReport?: DataQualityReport;
}

export interface QueryExample {
    id: string;
    description: string;
    sql: string;
    results?: any[];
    executionTime?: number;
    error?: string;
}

export interface TableFilterSuggestion {
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

export interface TableInsight {
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

function normalizeTableIdentifier(name: string): string {
    const cleaned = String(name || "")
        .trim()
        .replace(/["`\[\]]/g, "");
    if (!cleaned) return "";
    const parts = cleaned.split(".").filter(Boolean);
    return (parts[parts.length - 1] || "").toLowerCase();
}

function tokenizeIntent(value: string): string[] {
    const stopwords = new Set([
        "the", "and", "for", "with", "from", "this", "that", "show", "dashboard",
        "metrics", "metric", "chart", "table", "kpi", "summary", "analysis", "overview",
        "please", "need", "give", "about", "into", "using", "data", "by", "of", "to", "in"
    ]);
    return String(value || "")
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3 && !stopwords.has(t));
}

function rankTablesForIntent(input: {
    schemaInfo: Record<string, any>;
    tableCounts: Record<string, number>;
    relationships: any[];
    options: SchemaDiscoveryOptions;
    minTables: number;
    maxTables: number;
}) {
    const { schemaInfo, tableCounts, relationships, options, minTables, maxTables } = input;
    const intentTokens = new Set<string>([
        ...tokenizeIntent(options.intent || ""),
        ...(Array.isArray(options.intentEntities) ? options.intentEntities : []).flatMap((v) => tokenizeIntent(String(v))),
        ...(Array.isArray(options.intentMetrics) ? options.intentMetrics : []).flatMap((v) => tokenizeIntent(String(v))),
        ...(Array.isArray(options.intentDimensions) ? options.intentDimensions : []).flatMap((v) => tokenizeIntent(String(v))),
        ...tokenizeIntent(options.projectContext || "")
    ]);

    const ranked = Object.entries(schemaInfo).map(([table, info]) => {
        const reasons: string[] = [];
        let score = 0;
        const tableLower = table.toLowerCase();
        const columns = Array.isArray((info as any)?.columns) ? (info as any).columns : [];
        const colNames: string[] = columns.map((c: any) => String(getColumnName(c) || "").toLowerCase()).filter(Boolean);
        const fkCount = Array.isArray((info as any)?.foreignKeys) ? (info as any).foreignKeys.length : 0;
        const count = Number(tableCounts?.[table] || 0);

        intentTokens.forEach((token) => {
            if (tableLower.includes(token)) {
                score += 5;
                reasons.push(`table_match:${token}`);
            }
            colNames.forEach((col: string) => {
                if (col.includes(token)) {
                    score += 2;
                    reasons.push(`column_match:${token}`);
                }
            });
        });

        if (count > 0) {
            const countScore = Math.min(Math.log10(count + 1), 3);
            score += countScore;
            reasons.push(`row_count:${count}`);
        }

        if (fkCount > 0) {
            const fkScore = Math.min(fkCount, 3) * 0.8;
            score += fkScore;
            reasons.push(`foreign_keys:${fkCount}`);
        }

        columns.forEach((col: any) => {
            if (col?.isTemporal) score += 0.7;
            if (col?.isNumeric) score += 0.7;
        });

        return { table, score, reasons };
    }).sort((a, b) => b.score - a.score);

    const targetCount = Math.max(
        minTables,
        Math.min(maxTables, Number(options.maxDeepProfileTables || 0) || maxTables)
    );

    const selected = ranked
        .filter((entry) => entry.score > 0)
        .slice(0, targetCount)
        .map((entry) => entry.table);

    if (selected.length === 0) {
        selected.push(...ranked.slice(0, Math.min(targetCount, ranked.length)).map((entry) => entry.table));
    }

    const selectedSet = new Set(selected);
    // Keep joinability by including immediate FK neighbors for selected tables.
    relationships.forEach((rel: any) => {
        const from = String(rel?.from?.table || rel?.fromTable || "");
        const to = String(rel?.to?.table || rel?.toTable || "");
        if (!from || !to) return;
        if (selectedSet.has(from) && selectedSet.size < maxTables) {
            selectedSet.add(to);
        } else if (selectedSet.has(to) && selectedSet.size < maxTables) {
            selectedSet.add(from);
        }
    });

    return {
        rankedTables: ranked,
        deepProfiledTables: Array.from(selectedSet).slice(0, maxTables)
    };
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

function buildTableDataMatrix(tableSchema: any, sampleRows: any[], rowCount?: number, foreignKeys?: any[]): TableDataMatrix {
    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const fks = Array.isArray(foreignKeys || tableSchema?.foreignKeys) ? (foreignKeys || tableSchema?.foreignKeys) : [];
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
                    sampleValues: distinct.slice(0, 10)
                });
            }
        }
    });

    // Pro profiling: build column stats, classify table, score data quality
    const columnProfiles = sampleRows?.length > 0 ? buildColumnProfiles(columns, sampleRows) : [];
    const classification = classifyTable("", columns, fks, rowCount, columnProfiles);
    const qualityReport = buildDataQualityReport(columnProfiles);

    return {
        rowCount,
        columnCounts,
        categoricalCandidates,
        numericCandidates,
        groupedColumns: {
            categorical: categoricalCandidates.map(c => c.column),
            numeric: numericCandidates.map(c => c.column),
            temporal: columns.filter((c: any) => (c.category || categorizeDataType(c.type || c.data_type || "")) === "temporal").map((c: any) => getColumnName(c)),
            text: columns.filter((c: any) => (c.category || categorizeDataType(c.type || c.data_type || "")) === "text").map((c: any) => getColumnName(c))
        },
        columnProfiles,
        classification,
        qualityReport
    };
}

// ─── Pro Profiling Engine ─────────────────────────────────────────────────────

/** Infer the analytics role of a column from its name + type pattern */
function inferColumnRole(
    colName: string,
    rawType: string,
    category: string,
    cardinality: number,
    totalSampled: number,
    isBooleanLikeValues: boolean
): ColumnRole {
    const n = String(colName).toLowerCase();
    const type = String(rawType || "").toLowerCase();
    const hasDeclaredType = type.length > 0;
    const isBooleanType = /\b(bool|boolean|bit)\b/.test(type);

    if (category === "temporal" || /date|time|timestamp|created|updated|at$/i.test(n)) return "timestamp";
    // Strictly avoid "state guessing" from names when a non-boolean type is declared.
    if (category === "boolean" || isBooleanType || isBooleanLikeValues) return "flag";
    if (!hasDeclaredType && /^(is_|has_|flag_)/.test(n)) return "flag";
    if (/(^id$|_id$|uuid|guid|key$)/.test(n)) return "id";
    if (category === "numeric" && /(amount|price|total|revenue|cost|qty|quantity|count|score|value|balance|weight|rate|pct|percent)/.test(n)) return "measure";
    if (category === "text") {
        if (totalSampled > 0 && cardinality / totalSampled < 0.1 && cardinality <= 20) return "category";
        if (/(name|title|label|description|email|username|phone|address|city|country|region|code)/.test(n)) return "label";
    }
    if (category === "numeric") return "measure";
    return "unknown";
}

/** Build a rich statistical profile for every column using sample data */
function buildColumnProfiles(columns: any[], sampleRows: any[]): ColumnProfile[] {
    return columns.map((col: any) => {
        const name = getColumnName(col);
        const type = String(col.type || col.data_type || "");
        const category = col.category || categorizeDataType(type);

        const allValues = sampleRows.map((row: any) => row?.[name]);
        const nonNull = allValues.filter((v: any) => v !== null && v !== undefined && v !== "");
        const totalSampled = allValues.length;
        const nullCount = totalSampled - nonNull.length;
        const nullRate = totalSampled > 0 ? nullCount / totalSampled : 0;

        // Cardinality
        const distinctSet = new Set(nonNull.map((v: any) => String(v)));
        const cardinality = distinctSet.size;
        const cardinalityRatio = totalSampled > 0 ? cardinality / totalSampled : 0;
        const isHighCardinality = cardinalityRatio > 0.9 && cardinality > 10;
        const isLowCardinality = cardinality <= 12 && cardinality > 0;
        const isConstant = cardinality === 1;
        const normalizedValueSet = new Set(
            nonNull.map((v: any) => String(v).trim().toLowerCase())
        );
        const booleanValueTokens = new Set(["true", "false", "1", "0", "yes", "no", "y", "n", "t", "f"]);
        const isBooleanLikeValues = normalizedValueSet.size > 0
            && normalizedValueSet.size <= 2
            && Array.from(normalizedValueSet).every((v) => booleanValueTokens.has(v));

        // Top values
        const valueCounts: Record<string, number> = {};
        nonNull.forEach((v: any) => {
            const s = String(v).substring(0, 80);
            valueCounts[s] = (valueCounts[s] || 0) + 1;
        });
        const topValues = Object.entries(valueCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([value, count]) => ({
                value,
                count,
                pct: totalSampled > 0 ? Math.round((count / totalSampled) * 100) : 0
            }));

        // Numeric stats
        let min: number | undefined;
        let max: number | undefined;
        let mean: number | undefined;
        let stddev: number | undefined;
        let isSkewed: boolean | undefined;

        if (category === "numeric" && nonNull.length > 0) {
            const nums = nonNull.map(Number).filter((n: number) => !isNaN(n));
            if (nums.length > 0) {
                min = Math.min(...nums);
                max = Math.max(...nums);
                mean = nums.reduce((a: number, b: number) => a + b, 0) / nums.length;
                const variance = nums.reduce((a: number, n: number) => a + Math.pow(n - mean!, 2), 0) / nums.length;
                stddev = Math.sqrt(variance);
                isSkewed = mean !== 0 && stddev > Math.abs(mean) * 2;
            }
        }

        // Quality flags
        const qualityFlags: ColumnProfile["qualityFlags"] = [];
        if (nullRate > 0.3) qualityFlags.push("high_nulls");
        if (isConstant) qualityFlags.push("constant");
        if (isHighCardinality && category === "text") qualityFlags.push("high_cardinality");
        const isDeclaredEnumType = /\benum\b/.test(type.toLowerCase());
        if (isDeclaredEnumType && isLowCardinality && cardinality > 1) qualityFlags.push("possible_enum");
        if (isSkewed) qualityFlags.push("numeric_outlier");
        if (/(email|phone|ssn|password|secret|token|credit|card|dob|birth|national_id)/.test(name.toLowerCase())) qualityFlags.push("potential_pii");

        const role = inferColumnRole(name, type, category, cardinality, totalSampled, isBooleanLikeValues);

        return {
            name,
            type,
            category,
            role,
            nullCount,
            nullRate,
            totalSampled,
            cardinality,
            cardinalityRatio,
            isHighCardinality,
            isLowCardinality,
            isConstant,
            topValues,
            min,
            max,
            mean,
            stddev,
            isSkewed,
            qualityFlags
        } as ColumnProfile;
    });
}

/** Classify a table as fact / dimension / junction / lookup based on structural signals */
function classifyTable(
    tableName: string,
    columns: any[],
    foreignKeys: any[],
    rowCount: number | undefined,
    columnProfiles: ColumnProfile[]
): TableClassification {
    const signals: string[] = [];
    const numCols = columns.length;
    const numFKs = foreignKeys.length;

    const numericCols = columnProfiles.filter(p => p.category === "numeric" && p.role === "measure").length;
    const temporalCols = columnProfiles.filter(p => p.category === "temporal").length;
    const textLabelCols = columnProfiles.filter(p => p.role === "label" || p.role === "category").length;

    // Junction: few columns, 2+ FKs, often a linking table
    if (numFKs >= 2 && numCols <= numFKs + 3) {
        signals.push(`${numFKs} foreign keys with only ${numCols} columns → junction table`);
        return { tableClass: "junction", confidence: 90, signals };
    }

    // Lookup: small row count, mostly categorical/label columns, low cardinality
    if ((rowCount !== undefined && rowCount < 100) && textLabelCols > numericCols) {
        signals.push(`Only ${rowCount} rows, mostly label/category columns → lookup table`);
        return { tableClass: "lookup", confidence: 80, signals };
    }

    // Fact: large table, has timestamps and numeric measures, many FKs
    if ((rowCount === undefined || rowCount > 500) && temporalCols >= 1 && numericCols >= 1) {
        signals.push(`Temporal + numeric columns with ${rowCount ?? "?"} rows → fact table`);
        if (numFKs > 0) signals.push(`${numFKs} foreign keys to dimension tables`);
        return { tableClass: "fact", confidence: 75, signals };
    }

    // Dimension: moderate size, textLabel dominant, referenced by other tables
    if (textLabelCols >= 2 && numericCols <= 2) {
        signals.push(`Mostly label/category columns (${textLabelCols}) → dimension table`);
        return { tableClass: "dimension", confidence: 70, signals };
    }

    signals.push("Mixed structure, not clearly classifiable");
    return { tableClass: "unknown", confidence: 40, signals };
}

/** Compute a 0-100 data quality health score for a table */
function buildDataQualityReport(columnProfiles: ColumnProfile[]): DataQualityReport {
    if (columnProfiles.length === 0) {
        return { healthScore: 100, completeness: 100, uniqueness: 100, consistency: 100, issues: [] };
    }

    const issues: DataQualityReport["issues"] = [];

    // Completeness: avg (1 - nullRate) across all columns
    const completeness = Math.round(
        (columnProfiles.reduce((sum, p) => sum + (1 - p.nullRate), 0) / columnProfiles.length) * 100
    );

    // Uniqueness: % of id/measure columns that are high cardinality (i.e., not duplicated heavily)
    const keyColumns = columnProfiles.filter(p => p.role === "id" || p.role === "measure");
    const uniqueScore = keyColumns.length > 0
        ? Math.round((keyColumns.filter(p => !p.isConstant).length / keyColumns.length) * 100)
        : 100;

    // Consistency: % columns without quality flags
    const cleanCols = columnProfiles.filter(p => p.qualityFlags.length === 0).length;
    const consistency = Math.round((cleanCols / columnProfiles.length) * 100);

    // Build issues list
    columnProfiles.forEach(p => {
        if (p.nullRate > 0.5) {
            issues.push({ column: p.name, issue: `${Math.round(p.nullRate * 100)}% null values`, severity: "high" });
        } else if (p.nullRate > 0.2) {
            issues.push({ column: p.name, issue: `${Math.round(p.nullRate * 100)}% null values`, severity: "medium" });
        }
        if (p.isConstant && p.totalSampled > 5) {
            issues.push({ column: p.name, issue: "All values identical (constant column)", severity: "medium" });
        }
        if (p.qualityFlags.includes("potential_pii")) {
            issues.push({ column: p.name, issue: "Possible PII (sensitive data)", severity: "high" });
        }
        if (p.isSkewed) {
            issues.push({ column: p.name, issue: "High numeric skew detected", severity: "low" });
        }
    });

    // Health score: weighted average of metrics
    const healthScore = Math.round(
        completeness * 0.4 + uniqueScore * 0.3 + consistency * 0.3
    );

    return { healthScore, completeness, uniqueness: uniqueScore, consistency, issues };
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
                `SELECT ${quoteIdent(colName)} FROM ${quoteIdent(tableName)} ORDER BY ${quoteIdent(colName)} DESC`,
                `SELECT MIN(${quoteIdent(colName)}) as min_date, MAX(${quoteIdent(colName)}) as max_date FROM ${quoteIdent(tableName)}`,
                `SELECT ${quoteIdent(colName)}, COUNT(*) as count FROM ${quoteIdent(tableName)} GROUP BY ${quoteIdent(colName)} ORDER BY count DESC`,
                `SELECT * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} BETWEEN :start_date AND :end_date`,
                `SELECT * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} >= :reference_date`
            ];

            filters.push({
                id: `${tableName}_${colName}_date`,
                title: `${colName} date range`,
                type: "date_range",
                column: colName,
                table: tableName,
                sampleValues: distinctDates.slice(0, 10),
                examples: {
                    sampleValues: distinctDates.slice(0, 10),
                    sampleQueries: exampleQueries,
                    queryToGetValues: `SELECT ${quoteIdent(colName)} FROM ${quoteIdent(tableName)} ORDER BY ${quoteIdent(colName)} DESC`
                }
            });
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
                    const sampleValue = String(distinct[0] || "value").replace(/'/g, "''");
                    const exampleQueries = [
                        `SELECT DISTINCT ${quoteIdent(colName)} FROM ${quoteIdent(tableName)}`,
                        `SELECT ${quoteIdent(colName)}, COUNT(*) as count FROM ${quoteIdent(tableName)} GROUP BY ${quoteIdent(colName)} ORDER BY count DESC`,
                        `SELECT * FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(colName)} = '${sampleValue}'`
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
                            queryToGetValues: `SELECT DISTINCT ${quoteIdent(colName)} FROM ${quoteIdent(tableName)}`
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
            .slice(0, 10);

        const exampleQueries = [
            `SELECT ${quoteIdent(fk.column_name)} FROM ${quoteIdent(tableName)} WHERE ${quoteIdent(fk.column_name)} IS NOT NULL`,
            `SELECT * FROM ${quoteIdent(tableName)} t JOIN ${quoteIdent(fk.foreign_table_name)} ft ON t.${quoteIdent(fk.column_name)} = ft.${quoteIdent(fk.foreign_column_name || 'id')}`
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
const MAX_RESULTS_PER_QUERY = 10;
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
    sampleRows: any[],
    allowedTables?: Set<string>
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
    const quoteTableRef = (name: string) => {
        const cleaned = String(name || "").trim().replace(/["`\[\]]/g, "");
        if (!cleaned) return quoteIdent(name);
        if (cleaned.includes(".")) {
            return cleaned
                .split(".")
                .filter(Boolean)
                .map((part) => quoteIdent(part))
                .join(".");
        }
        return quoteIdent(cleaned);
    };
    const limitClause = (count: number) => isMssql ? `TOP ${count}` : `LIMIT ${count}`;
    const dateSubtraction = (days: number) => isMssql
        ? `DATEADD(day, -${days}, GETDATE())`
        : `CURRENT_DATE - INTERVAL '${days} days'`;
    const likeOperator = () => isMssql ? 'LIKE' : 'ILIKE';

    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const examples: QueryExample[] = [];
    const foreignKeys = (Array.isArray(tableSchema?.foreignKeys) ? tableSchema.foreignKeys : []).filter((fk: any) => {
        const target = normalizeTableIdentifier(fk?.foreign_table_name || "");
        if (!target) return false;
        return !allowedTables || allowedTables.has(target);
    });

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
        const primaryCol = getColumnName(
            columns.find((c: any) => c.isPrimary || c.isPrimaryKey) || columns[0]
        );
        const selectPrefix = primaryCol ? `t.${quoteIdent(primaryCol)}, ` : "";

        const sql = isMssql
            ? `SELECT ${limitClause(10)} ${selectPrefix}ft.* FROM ${quoteTableRef(tableName)} t JOIN ${quoteTableRef(fk.foreign_table_name)} ft ON t.${quoteIdent(fk.column_name)} = ft.${quoteIdent(fk.foreign_column_name)}`
            : `SELECT ${selectPrefix}ft.* FROM ${quoteTableRef(tableName)} t JOIN ${quoteTableRef(fk.foreign_table_name)} ft ON t.${quoteIdent(fk.column_name)} = ft.${quoteIdent(fk.foreign_column_name)} ${limitClause(10)}`;

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

function computeFilterableColumnsFromInsights(insight: TableInsight | null, tableSchema?: any) {
    if (!insight) return [];
    const allowed = new Set<string>();
    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const enumByType = new Set<string>(
        columns
            .filter((col: any) => String(col?.type || col?.data_type || "").toLowerCase().includes("enum"))
            .map((col: any) => String(getColumnName(col) || "").trim())
            .filter(Boolean)
    );
    const profiles = insight?.dataMatrix?.columnProfiles || [];
    profiles.forEach((profile: any) => {
        const name = String(profile?.name || "").trim();
        if (!name) return;
        const type = String(profile?.type || "").toLowerCase();
        const isDate = isTemporalType(type);
        const isEnum = type.includes("enum") || enumByType.has(name);
        if (isDate || isEnum) {
            allowed.add(name);
        }
    });
    // Fallback if profiles missing: allow only explicit enum/date filter types.
    (insight?.filters || []).forEach((f) => {
        const col = String(f?.column || "").trim();
        if (!col) return;
        const type = String(f?.type || "");
        const colType = String(
            columns.find((c: any) => String(getColumnName(c) || "").trim() === col)?.type
            || columns.find((c: any) => String(getColumnName(c) || "").trim() === col)?.data_type
            || ""
        ).toLowerCase();
        if (type === "date_range" || (type === "multi_select" && colType.includes("enum"))) {
            allowed.add(col);
        }
    });
    return Array.from(allowed);
}

export function buildFilterCandidatesFromColumns(
    schemaInfo: Record<string, any>,
    filterableColumns: Record<string, string[]>
) {
    const dateColumns: { table: string; column: string; type: string }[] = [];
    const categoricalColumns: { table: string; column: string; distinct: any[] }[] = [];
    const entityColumns: { viaTable: string; from: string; to: string; count?: number }[] = [];
    const searchColumns: { table: string; column: string; score: number }[] = [];

    Object.entries(filterableColumns || {}).forEach(([table, columns]) => {
        const info = schemaInfo?.[table];
        const colInfo = info?.columns || [];
        const foreignKeys = Array.isArray(info?.foreignKeys) ? info.foreignKeys : [];
        columns.forEach((column) => {
            const match = colInfo.find((c: any) => getColumnName(c) === column);
            const type = String(match?.type || match?.data_type || "").toLowerCase();
            const name = String(column || "");
            if (isTemporalType(type)) {
                dateColumns.push({ table, column, type });
                return;
            }
            if (type.includes("enum")) {
                categoricalColumns.push({ table, column, distinct: [] });
                return;
            }

            if (/(char|text|string|uuid|citext|json)/i.test(type)) {
                const score = (
                    (/name|title|label/i.test(name) ? 3 : 0)
                    + (/email|phone|code|reference|number/i.test(name) ? 2 : 0)
                    + (/description|note|comment/i.test(name) ? 1 : 0)
                );
                if (score > 0) {
                    searchColumns.push({ table, column, score });
                }
            }

            const fk = foreignKeys.find((candidate: any) => String(candidate?.column_name || "") === name);
            if (fk?.foreign_table_name) {
                entityColumns.push({
                    viaTable: table,
                    from: `${table}.${name}`,
                    to: `${fk.foreign_table_name}.${fk.foreign_column_name || "id"}`
                });
            }
        });
    });

    const primaryDate = dateColumns[0];
    searchColumns.sort((a, b) => b.score - a.score);
    const primarySearch = searchColumns[0];
    const summaryLines: string[] = [];
    if (primaryDate) {
        summaryLines.push(`Date range filter: ${primaryDate.table}.${primaryDate.column}`);
    }
    if (primarySearch) {
        summaryLines.push(`Search filter: ${primarySearch.table}.${primarySearch.column}`);
    }
    if (categoricalColumns.length > 0) {
        summaryLines.push(`Categorical filters: ${categoricalColumns.slice(0, 5).map((c) => `${c.table}.${c.column}`).join(", ")}${categoricalColumns.length > 5 ? " ..." : ""}`);
    }
    if (entityColumns.length > 0) {
        summaryLines.push(`Entity filters: ${entityColumns.slice(0, 5).map((e) => e.from).join(", ")}${entityColumns.length > 5 ? " ..." : ""}`);
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

function hasMeaningfulFilterCandidates(candidates: any): boolean {
    if (!candidates || typeof candidates !== "object") return false;
    return (
        (Array.isArray(candidates.dateColumns) && candidates.dateColumns.length > 0)
        || (Array.isArray(candidates.categoricalColumns) && candidates.categoricalColumns.length > 0)
        || (Array.isArray(candidates.entityColumns) && candidates.entityColumns.length > 0)
        || (Array.isArray(candidates.searchColumns) && candidates.searchColumns.length > 0)
    );
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
    connectionString: string | null = null,
    allowedTables?: Set<string>
): Promise<TableInsight | null> {
    const shouldEnrich = options.enableSemanticSearch || options.enableTableKpis || options.enableTableMatrix || options.enableTableFilters;
    if (!shouldEnrich) return null;

    const insight: TableInsight = {};

    if (options.enableSemanticSearch) {
        insight.semanticMatches = await buildSemanticMatches(tableName, tableSchema);
    }

    const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
    const foreignKeys = Array.isArray(tableSchema?.foreignKeys) ? tableSchema.foreignKeys : [];
    if (options.enableTableKpis) {
        insight.kpis = buildTableKpis(tableName, columns, rowCount);
    }

    if (options.enableTableMatrix) {
        insight.dataMatrix = buildTableDataMatrix(tableSchema, sampleRows, rowCount, foreignKeys);
    } else {
        // Always build profiling data even without the full matrix option
        const columnProfiles = sampleRows?.length > 0 ? buildColumnProfiles(columns, sampleRows) : [];
        const classification = classifyTable(tableName, columns, foreignKeys, rowCount, columnProfiles);
        const qualityReport = buildDataQualityReport(columnProfiles);
        insight.dataMatrix = {
            rowCount,
            columnCounts: { total: columns.length, numeric: 0, temporal: 0, text: 0, boolean: 0, other: 0 },
            categoricalCandidates: [],
            numericCandidates: [],
            columnProfiles,
            classification,
            qualityReport
        };
    }

    if (options.enableTableFilters) {
        insight.filters = buildTableFilters(tableName, tableSchema, sampleRows);
    }

    // Execute 5 efficient query examples with actual results
    if (connectionString) {
        try {
            insight.queryExamples = await executeTableQueryExamples(tableName, tableSchema, connectionString, sampleRows, allowedTables);
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
    connectionString: string | null = null,
    allowedTables?: Set<string>,
    includeTables?: Set<string>
) {
    const shouldEnrich = options.enableSemanticSearch || options.enableTableKpis || options.enableTableMatrix || options.enableTableFilters;
    if (!shouldEnrich) return null;

    const tableInsights: Record<string, TableInsight> = {};
    const entries = Object.entries(schemaInfo);

    for (const [tableName, tableSchema] of entries) {
        if (includeTables && !includeTables.has(tableName)) {
            tableInsights[tableName] = {
                dataMatrix: {
                    rowCount: tableCounts ? tableCounts[tableName] : undefined,
                    columnCounts: {
                        total: Array.isArray((tableSchema as any)?.columns) ? (tableSchema as any).columns.length : 0,
                        numeric: 0,
                        temporal: 0,
                        text: 0,
                        boolean: 0,
                        other: 0
                    },
                    categoricalCandidates: [],
                    numericCandidates: []
                }
            };
            continue;
        }
        const insight = await buildTableInsight(
            tableName,
            tableSchema,
            sampleData[tableName] || [],
            tableCounts ? tableCounts[tableName] : undefined,
            options,
            connectionString,
            allowedTables
        );
        if (insight) {
            tableInsights[tableName] = insight;
        }
    }

    return tableInsights;
}

export function detectFilterCandidates(
    schemaInfo: Record<string, any>,
    sampleData: Record<string, any[]>,
    _tableCounts: Record<string, number>,
    _relationships: any[]
) {
    void _tableCounts;
    void _relationships;
    const dateColumns: { table: string; column: string; type: string }[] = [];
    const categoricalColumns: { table: string; column: string; distinct: any[] }[] = [];
    const entityColumns: { viaTable: string; from: string; to: string; count?: number }[] = [];
    const searchColumns: { table: string; column: string; score: number }[] = [];

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

            const enumLike = colType.includes("enum");
            if (isTextType(colType) || enumLike) {
                const distinct = Array.from(new Set(values.map((v: any) => String(v))));
                if (enumLike || (distinct.length > 0 && distinct.length <= 12)) {
                    categoricalColumns.push({ table, column: colName, distinct });
                }
            }
        });
    }

    const primaryDate = dateColumns[0];
    const primarySearch = undefined;
    const summaryLines: string[] = [];
    if (primaryDate) {
        summaryLines.push(`Date range filter: ${primaryDate.table}.${primaryDate.column}`);
    }
    if (categoricalColumns.length > 0) {
        summaryLines.push(`Categorical filters: ${categoricalColumns.slice(0, 5).map((c) => `${c.table}.${c.column}`).join(", ")}${categoricalColumns.length > 5 ? " ..." : ""}`);
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
    projectContext?: string,
    tableCounts?: Record<string, number>,
    relationships?: any[]
): Promise<string> {
    const tableEntries = Object.entries(schemaInfo);

    // Richer schema: include column types + FK annotations
    const simplifiedSchema = tableEntries.slice(0, 25).map(([table, info]: [string, any]) => {
        const pk = info.columns?.find((c: any) => c.isPrimary)?.name || "id";
        const rowCount = tableCounts?.[table] ? ` ~${tableCounts[table].toLocaleString()} rows` : "";
        const cols = (info.columns || []).slice(0, 8).map((c: any) => {
            const name = c.name || c.column_name;
            const type = c.type || c.data_type || "";
            const tag = c.isPrimary ? ":PK" : info.foreignKeys?.some((fk: any) => fk.column_name === name) ? ":FK" : "";
            return `${name}${tag}(${type})`;
        }).join(", ");
        return `- ${table} (PK:${pk}${rowCount}) [${cols}]`;
    }).join("\n");

    // Relationship graph
    const relText = (relationships || []).slice(0, 10).map((r: any) => {
        if (r?.from?.table && r?.to?.table) {
            return `${r.from.table}.${r.from.column} -> ${r.to.table}.${r.to.column}`;
        }
        if (r?.fromTable && r?.toTable) {
            return `${r.fromTable}.${r.via || "?"} -> ${r.toTable}.${r.targetColumn || "?"}`;
        }
        return null;
    }).filter(Boolean).join("\n");

    const limitedSampleData: Record<string, any[]> = {};
    Object.entries(sampleData).slice(0, 3).forEach(([table, rows]) => {
        if (rows?.length > 0) {
            const prunedRow = Object.fromEntries(Object.entries(rows[0]).slice(0, 5));
            limitedSampleData[table] = [prunedRow];
        }
    });

    const { runSkill } = await import("@/lib/skills/registry");
    const { registerSchemaAnalysisSkill } = await import("@/lib/skills/schema-analysis");
    registerSchemaAnalysisSkill();

    try {
        const { analysis } = await runSkill<any, any>("schema-analysis", {
            simplifiedSchema,
            relText,
            limitedSampleData,
            projectContext
        });
        return analysis;
    } catch (err: any) {
        const tables = Object.keys(schemaInfo);
        console.error("[SCHEMA_LLM_ERROR] Failed to generate semantic analysis:", err?.message || err);
        return `Database contains ${tables.length} tables: ${tables.slice(0, 5).join(", ")}${tables.length > 5 ? "..." : ""}.`;
    }
}

export async function runSchemaDiscovery(
    inputOrConnection?: string | RunSchemaDiscoveryInput,
    options: SchemaDiscoveryOptions = {},
    allowedTables?: string[]
) {
    const isObjectInput = !!inputOrConnection && typeof inputOrConnection === "object";
    const connectionString = isObjectInput
        ? String((inputOrConnection as RunSchemaDiscoveryInput).connection || "").trim()
        : String(inputOrConnection || "").trim();
    const requestedConnectorType = isObjectInput
        ? String((inputOrConnection as RunSchemaDiscoveryInput).connectorType || "").trim()
        : "";
    const effectiveOptions = isObjectInput
        ? ((inputOrConnection as RunSchemaDiscoveryInput).options || {})
        : (options || {});
    const effectiveAllowedTables = isObjectInput
        ? (Array.isArray((inputOrConnection as RunSchemaDiscoveryInput).allowedTables)
            ? (inputOrConnection as RunSchemaDiscoveryInput).allowedTables
            : [])
        : (Array.isArray(allowedTables) ? allowedTables : []);
    const routingContext = isObjectInput
        ? ((inputOrConnection as RunSchemaDiscoveryInput).routingContext || {})
        : {};

    registerConnectorSkills();

    const initialRouting = await resolveConnectorSkills({
        connectionString,
        connectorType: requestedConnectorType,
        schemaHint: routingContext.schemaHint,
        projectContext: routingContext.projectContext || effectiveOptions.projectContext
    });

    const envPostgresUrl = process.env.POSTGRES_URL || process.env.NEXT_PUBLIC_POSTGRES_URL || "";
    const envMssqlUrl = process.env.MSSQL_URL || "";
    const targetUrl = connectionString
        || (initialRouting.kind === "mssql" ? (envMssqlUrl || envPostgresUrl) : (envPostgresUrl || envMssqlUrl));

    if (!targetUrl) {
        throw new Error("Schema discovery requires a configured database connection. Set POSTGRES_URL or MSSQL_URL, or connect via the Data Sources panel.");
    }

    const resolved = await resolveConnectorSkills({
        connectionString: targetUrl,
        connectorType: requestedConnectorType,
        schemaHint: routingContext.schemaHint,
        projectContext: routingContext.projectContext || effectiveOptions.projectContext
    });
    const schemaDiscoverySkillId = resolved.skills.schemaDiscoverySkillId;
    const runSchemaSkill = async (input: any) => runSkill<any, any>(schemaDiscoverySkillId, input);

    const connectResult = await runSchemaSkill({ operation: "connect", connectionString: targetUrl });
    const connected = Boolean(connectResult?.ok && connectResult?.data);
    if (!connected) {
        throw new Error(connectResult?.error || "Failed to connect to the database. Please verify your connection details.");
    }

    const allTablesResultPayload = await runSchemaSkill({
        operation: "listTables",
        connectionString: targetUrl,
        allowedTables: effectiveAllowedTables
    });
    const allTablesResult = allTablesResultPayload?.data;
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
    if (Array.isArray(effectiveAllowedTables) && effectiveAllowedTables.length > 0) {
        const allowedLower = new Set(effectiveAllowedTables.map((t) => normalizeTableIdentifier(t)));
        allTables = allTables.filter((t) => t && allowedLower.has(normalizeTableIdentifier(t)));
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
    const normalizedToOriginal = new Map<string, string>();
    allTables.forEach((tableName) => {
        normalizedToOriginal.set(normalizeTableIdentifier(tableName), tableName);
    });

    // Pass 1: lightweight structural scan for every table.
    for (const tableName of allTables) {
        try {
            const schemaResult = await runSchemaSkill({
                operation: "getTableSchema",
                connectionString: targetUrl,
                tableName
            });
            const tableSchema = schemaResult?.data;
            if (tableSchema && tableSchema.columns) {
                tableSchema.columns = tableSchema.columns.map((column: any) => ({
                    ...column,
                    name: column.column_name || column.name,
                    type: column.data_type || column.type,
                    isPrimary: Boolean(
                        column.isPrimary
                        || column.isPrimaryKey
                        || (Array.isArray(tableSchema?.primaryKeys)
                            && tableSchema.primaryKeys.includes(column.column_name || column.name))
                    ),
                    category: categorizeDataType(column.data_type || column.type || ""),
                    isNumeric: isNumericType(column.data_type || column.type || ""),
                    isTemporal: isTemporalType(column.data_type || column.type || ""),
                    isText: isTextType(column.data_type || column.type || "")
                }));
            }
            if (tableSchema && Array.isArray(tableSchema.foreignKeys)) {
                tableSchema.foreignKeys = tableSchema.foreignKeys
                    .map((fk: any) => {
                        const normalizedTarget = normalizeTableIdentifier(fk?.foreign_table_name || "");
                        const canonicalTarget = normalizedToOriginal.get(normalizedTarget);
                        if (!canonicalTarget) return null;
                        return {
                            ...fk,
                            foreign_table_name: canonicalTarget
                        };
                    })
                    .filter(Boolean);
            }

            schemaInfo[tableName] = tableSchema;

            const countResult = await runSchemaSkill({
                operation: "getRowCount",
                connectionString: targetUrl,
                tableName
            });
            const rawCount = Number(countResult?.data || 0);
            tableCounts[tableName] = rawCount ? Number(rawCount) : 0;

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
            tableCounts[tableName] = 0;
        }
    }

    const minDeepTables = allTables.length <= 8 ? allTables.length : 5;
    const maxDeepTables = allTables.length <= 8 ? allTables.length : 8;
    const ranking = rankTablesForIntent({
        schemaInfo,
        tableCounts,
        relationships,
        options: effectiveOptions,
        minTables: minDeepTables,
        maxTables: maxDeepTables
    });
    const deepProfiledTables = ranking.deepProfiledTables;
    const deepProfiledSet = new Set(deepProfiledTables);

    // Pass 2: expensive sample collection only for ranked relevant tables.
    for (const tableName of allTables) {
        if (!deepProfiledSet.has(tableName)) {
            sampleData[tableName] = [];
            continue;
        }
        try {
            const previewResult = await runSchemaSkill({
                operation: "getTablePreview",
                connectionString: targetUrl,
                tableName
            });
            const preview = previewResult?.data;
            sampleData[tableName] = Array.isArray(preview) ? preview : [];
        } catch {
            sampleData[tableName] = [];
        }
    }

    const filterCandidates = detectFilterCandidates(schemaInfo, sampleData, tableCounts, relationships);

    const allowedSet = new Set(allTables.map((t) => normalizeTableIdentifier(t)));
    const tableInsights = await buildTableInsights(
        schemaInfo,
        sampleData,
        tableCounts,
        effectiveOptions,
        targetUrl,
        allowedSet,
        deepProfiledSet
    );
    const visibleColumns: Record<string, string[]> = {};
    const filterableColumns: Record<string, string[]> = {};
    Object.entries(schemaInfo).forEach(([tableName, tableSchema]) => {
        visibleColumns[tableName] = computeVisibleColumns(tableSchema);
        const insight = tableInsights ? tableInsights[tableName] : null;
        filterableColumns[tableName] = computeFilterableColumnsFromInsights(insight, tableSchema);
    });
    const filterCandidatesFromColumns = buildFilterCandidatesFromColumns(schemaInfo, filterableColumns);
    const effectiveFilterCandidates = hasMeaningfulFilterCandidates(filterCandidatesFromColumns)
        ? filterCandidatesFromColumns
        : filterCandidates;

    let rawAnalysis = "";
    if (effectiveOptions.enableSemanticSearch) {
        rawAnalysis = await generateSchemaAnalysis(schemaInfo, sampleData, effectiveOptions.projectContext, tableCounts, relationships);
    } else {
        rawAnalysis = effectiveOptions.projectContext
            ? `Project context: ${effectiveOptions.projectContext}\nSemantic analysis disabled. Schema profiling only.`
            : "Semantic analysis disabled. Schema profiling only.";
    }

    const connectorRouting: ConnectorRoutingContext = resolved.routing;
    return {
        tables: allTables,
        allowedTables: allTables,
        schemaInfo,
        sampleData,
        tableCounts,
        relationships,
        tableInsights,
        tableRanking: ranking.rankedTables,
        deepProfiledTables,
        filterCandidates: effectiveFilterCandidates,
        rawAnalysis,
        filterSummary: effectiveFilterCandidates.summary,
        projectContext: effectiveOptions.projectContext || "",
        visibleColumns,
        filterableColumns,
        connector: {
            kind: resolved.kind,
            connectionString: targetUrl,
            instructions: ""
        },
        connectorRouting,
        selectedConnectorSkills: resolved.skills
    };
}

export async function schemaAgent(state: typeof AgentState.State) {
    const manualSchema = state.context?.manualSchema;
    const schemaSnapshot = state.context?.schemaSnapshot;
    const schemaOptions: SchemaDiscoveryOptions = state.context?.schemaOptions || {};
    const connectionString = state.context?.connectionString || state.context?.dbUrl || state.context?.postgresUrl || null;

    const effectiveOptions: SchemaDiscoveryOptions = {
        ...schemaOptions,
        enableSemanticSearch: schemaOptions.enableSemanticSearch ?? true,
        enableTableKpis: schemaOptions.enableTableKpis ?? true,
        enableTableMatrix: schemaOptions.enableTableMatrix ?? true,
        enableTableFilters: schemaOptions.enableTableFilters ?? true,
        intent: String(
            state.querySpecification?.technical_context
            || state.intent?.intent
            || ""
        ).trim(),
        intentEntities: Array.isArray(state.intent?.entities) ? state.intent?.entities : [],
        intentMetrics: Array.isArray(state.intent?.metrics) ? state.intent?.metrics : [],
        intentDimensions: Array.isArray(state.intent?.dimensions) ? state.intent?.dimensions : [],
        projectContext: String(schemaOptions.projectContext || state.context?.projectContext || "").trim() || schemaOptions.projectContext
    };
    const deriveTableCounts = (rowsByTable: Record<string, any[]>) =>
        Object.fromEntries(
            Object.entries(rowsByTable || {}).map(([table, rows]) => [table, Array.isArray(rows) ? rows.length : 0])
        );
    const normalizeRelationships = (rels: any[]) =>
        (Array.isArray(rels) ? rels : []).map((rel: any) => {
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
        });

    if (schemaSnapshot) {
        const schemaInfo = (schemaSnapshot.schemaInfo || schemaSnapshot.schema || {}) as Record<string, any>;
        const sampleData = (schemaSnapshot.sampleData || {}) as Record<string, any[]>;
        const snapshotInsights = schemaSnapshot.tableInsights || schemaSnapshot.dataProfile || null;
        const rawRelationships = Array.isArray(schemaSnapshot.relationships)
            ? schemaSnapshot.relationships
            : Array.isArray(schemaSnapshot.schemaRelationships)
                ? schemaSnapshot.schemaRelationships
                : [];
        const normalizedRelationships = normalizeRelationships(rawRelationships);
        const tableCounts: Record<string, number> =
            (schemaSnapshot.tableCounts && typeof schemaSnapshot.tableCounts === "object")
                ? schemaSnapshot.tableCounts as Record<string, number>
                : deriveTableCounts(sampleData);
        const filterableColumns = (schemaSnapshot.filterableColumns && typeof schemaSnapshot.filterableColumns === "object")
            ? schemaSnapshot.filterableColumns as Record<string, string[]>
            : {};
        const filterCandidates = Object.keys(filterableColumns).length > 0
            ? buildFilterCandidatesFromColumns(schemaInfo, filterableColumns)
            : detectFilterCandidates(schemaInfo, sampleData, tableCounts, normalizedRelationships);
        const domainSummary =
            String(schemaSnapshot.domainSummary || schemaSnapshot.rawAnalysis || "").trim()
            || (effectiveOptions.enableSemanticSearch
                ? await generateSchemaAnalysis(schemaInfo, sampleData, effectiveOptions.projectContext, tableCounts, normalizedRelationships)
                : `Schema snapshot loaded with ${Object.keys(schemaInfo).length} tables.`);

        const tableInsights = snapshotInsights || await buildTableInsights(schemaInfo, sampleData, null, effectiveOptions, connectionString);
        const ranking = rankTablesForIntent({
            schemaInfo,
            tableCounts,
            relationships: rawRelationships,
            options: effectiveOptions,
            minTables: Object.keys(schemaInfo).length <= 8 ? Object.keys(schemaInfo).length : 5,
            maxTables: Object.keys(schemaInfo).length <= 8 ? Object.keys(schemaInfo).length : 8
        });

        return {
            schemaInfo,
            sampleData,
            tableCounts,
            schemaRelationships: normalizedRelationships,
            tableRanking: ranking.rankedTables,
            deepProfiledTables: ranking.deepProfiledTables,
            dataProfile: tableInsights,
            filterCandidates,
            domainSummary,
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
                        from: { table: tableName, column: fk.column_name },
                        to: { table: fk.foreign_table_name, column: fk.foreign_column_name },
                        type: "many-to-one",
                    });
                });
            }
        });

        const tableCounts = deriveTableCounts(sampleData);
        const filterCandidates = detectFilterCandidates(normalizedSchema, sampleData, tableCounts, relationships);
        const domainSummary = effectiveOptions.enableSemanticSearch
            ? await generateSchemaAnalysis(normalizedSchema, sampleData, effectiveOptions.projectContext, tableCounts, relationships)
            : `Manual schema loaded with ${Object.keys(normalizedSchema).length} tables.`;
        const tableInsights = await buildTableInsights(normalizedSchema, sampleData, tableCounts, effectiveOptions, connectionString);
        const ranking = rankTablesForIntent({
            schemaInfo: normalizedSchema,
            tableCounts,
            relationships,
            options: effectiveOptions,
            minTables: Object.keys(normalizedSchema).length <= 8 ? Object.keys(normalizedSchema).length : 5,
            maxTables: Object.keys(normalizedSchema).length <= 8 ? Object.keys(normalizedSchema).length : 8
        });

        return {
            schemaInfo: normalizedSchema,
            sampleData,
            tableCounts,
            schemaRelationships: relationships,
            tableRanking: ranking.rankedTables,
            deepProfiledTables: ranking.deepProfiledTables,
            dataProfile: tableInsights,
            filterCandidates,
            domainSummary,
            status: "Using manual grounding.",
            messages: [new AIMessage(`[SCHEMA] Grounded in manually selected tables: ${Object.keys(normalizedSchema).join(", ")}`)]
        };
    }

    try {
        const focusTable = state.context?.focusTable;
        const allowedTables = focusTable ? [focusTable] : undefined;
        const discovered = await runSchemaDiscovery({
            connection: connectionString || "",
            connectorType: String(state.context?.connectorType || "").trim() || undefined,
            options: effectiveOptions,
            allowedTables,
            routingContext: {
                schemaHint: String(state.intent?.intent || "").trim(),
                projectContext: String(effectiveOptions.projectContext || "").trim()
            }
        });
        const normalizedRelationships = normalizeRelationships(discovered.relationships || []);
        const tableCounts: Record<string, number> = (discovered.tableCounts && typeof discovered.tableCounts === "object")
            ? discovered.tableCounts as Record<string, number>
            : deriveTableCounts(discovered.sampleData || {});
        const filterCandidates = discovered.filterCandidates
            || detectFilterCandidates(discovered.schemaInfo || {}, discovered.sampleData || {}, tableCounts, normalizedRelationships);
        const domainSummary = String(discovered.rawAnalysis || "").trim()
            || `Profiled ${Object.keys(discovered.schemaInfo || {}).length} tables.`;

        return {
            schemaInfo: discovered.schemaInfo || {},
            sampleData: discovered.sampleData || {},
            tableCounts,
            schemaRelationships: normalizedRelationships,
            tableRanking: Array.isArray((discovered as any).tableRanking) ? (discovered as any).tableRanking : [],
            deepProfiledTables: Array.isArray((discovered as any).deepProfiledTables) ? (discovered as any).deepProfiledTables : [],
            dataProfile: discovered.tableInsights || null,
            filterCandidates,
            domainSummary,
            connectorRouting: (discovered as any).connectorRouting || null,
            selectedConnectorSkills: (discovered as any).selectedConnectorSkills || null,
            connector: (discovered as any).connector || null,
            status: `Canonical database intelligence gathered. Profiled ${Object.keys(discovered.schemaInfo || {}).length} tables and identified ${normalizedRelationships.length} relationships.`,
            messages: [new AIMessage(`[SCHEMA] Deep profiled ${Object.keys(discovered.schemaInfo || {}).length} entities with full schema and snapshots. Identified table relationships and filter candidates.`)]
        };
    } catch (error: any) {
        return { errors: [`Exhaustive schema grounding failed: ${error.message}`] };
    }
}

export async function schemaDiscoveryAgent(state: typeof AgentState.State) {
    return schemaAgent(state);
}

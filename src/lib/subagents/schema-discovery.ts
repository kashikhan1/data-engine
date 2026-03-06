/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLogger } from "../observability";
import type { SubagentWithReflection, SubagentWithConfig } from "./types";

import type {
  SchemaDiscoveryOptions,
  ColumnProfile,
  TableClassification,
  DataQualityReport,
  TableInsight,
} from "../agents/schema-discovery";
import { runSkill } from "../skills/registry";
import { registerConnectorSkills, resolveConnectorSkills, type ConnectorRoutingContext } from "../skills/connectors";
import { registerSchemaAnalysisSkill } from "../skills/schema-analysis";
import { categorizeDataType, getColumnName, isNumericType, isTemporalType, isTextType } from "../agents/data-type-utils";

const log = createLogger("subagents.schema-discovery");

export type SchemaDiscoverySubagentInput = {
  connectionString?: string;
  connectorType?: string;
  options?: SchemaDiscoveryOptions;
  allowedTables?: string[];
  routingContext?: {
    schemaHint?: string;
    projectContext?: string;
  };
};

export type SchemaDiscoverySubagentOutput = {
  tables: string[];
  schemaInfo: Record<string, any>;
  sampleData: Record<string, any[]>;
  tableCounts: Record<string, number>;
  relationships: any[];
  tableInsights: Record<string, TableInsight> | null;
  tableRanking: Array<{ table: string; score: number; reasons: string[] }>;
  deepProfiledTables: string[];
  filterCandidates: any;
  rawAnalysis: string;
  connectorRouting: ConnectorRoutingContext | null;
  selectedConnectorSkills: any;
};

export interface ConnectorSkillSet {
  schemaDiscoverySkillId: string;
  sqlValidatorSkillId: string;
}

function normalizeTableIdentifier(name: string): string {
  const cleaned = String(name || "").trim().replace(/["`\[\]]/g, "");
  if (!cleaned) return "";
  const parts = cleaned.split(".").filter(Boolean);
  return (parts[parts.length - 1] || "").toLowerCase();
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
    ...(Array.isArray(options.intentEntities) ? options.intentEntities : []).flatMap((v: any) => tokenizeIntent(String(v))),
    ...(Array.isArray(options.intentMetrics) ? options.intentMetrics : []).flatMap((v: any) => tokenizeIntent(String(v))),
    ...(Array.isArray(options.intentDimensions) ? options.intentDimensions : []).flatMap((v: any) => tokenizeIntent(String(v))),
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
  }).sort((a: any, b: any) => b.score - a.score);

  const targetCount = Math.max(minTables, Math.min(maxTables, Number(options.maxDeepProfileTables || 0) || maxTables));

  const selected = ranked.filter((entry) => entry.score > 0).slice(0, targetCount).map((entry) => entry.table);

  if (selected.length === 0) {
    selected.push(...ranked.slice(0, Math.min(targetCount, ranked.length)).map((entry) => entry.table));
  }

  const selectedSet = new Set(selected);
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

function tokenizeIntent(value: string): string[] {
  const stopwords = new Set([
    "the", "and", "for", "with", "from", "this", "that", "show", "dashboard",
    "metrics", "metric", "chart", "table", "kpi", "summary", "analysis", "overview",
    "please", "need", "give", "about", "into", "using", "data", "by", "of", "to", "in"
  ]);
  return String(value || "").toLowerCase().split(/[^a-z0-9_]+/g).map((t) => t.trim()).filter((t) => t.length >= 3 && !stopwords.has(t));
}

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

    const distinctSet = new Set(nonNull.map((v: any) => String(v)));
    const cardinality = distinctSet.size;
    const cardinalityRatio = totalSampled > 0 ? cardinality / totalSampled : 0;
    const isHighCardinality = cardinalityRatio > 0.9 && cardinality > 10;
    const isLowCardinality = cardinality <= 12 && cardinality > 0;
    const isConstant = cardinality === 1;

    const normalizedValueSet = new Set(nonNull.map((v: any) => String(v).trim().toLowerCase()));
    const booleanValueTokens = new Set(["true", "false", "1", "0", "yes", "no", "y", "n", "t", "f"]);
    const isBooleanLikeValues = normalizedValueSet.size > 0 && normalizedValueSet.size <= 2 && Array.from(normalizedValueSet).every((v) => booleanValueTokens.has(v));

    const valueCounts: Record<string, number> = {};
    nonNull.forEach((v: any) => {
      const s = String(v).substring(0, 80);
      valueCounts[s] = (valueCounts[s] || 0) + 1;
    });
    const topValues = Object.entries(valueCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({
      value,
      count,
      pct: totalSampled > 0 ? Math.round((count / totalSampled) * 100) : 0
    }));

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

    const qualityFlags: Array<"high_nulls" | "constant" | "high_cardinality" | "potential_pii" | "possible_enum" | "numeric_outlier"> = [];
    if (nullRate > 0.3) qualityFlags.push("high_nulls");
    if (isConstant) qualityFlags.push("constant");
    if (isHighCardinality && category === "text") qualityFlags.push("high_cardinality");
    const isDeclaredEnumType = /\benum\b/.test(type.toLowerCase());
    if (isDeclaredEnumType && isLowCardinality && cardinality > 1) qualityFlags.push("possible_enum");
    if (isSkewed) qualityFlags.push("numeric_outlier");
    if (/(email|phone|ssn|password|secret|token|credit|card|dob|birth|national_id)/.test(name.toLowerCase())) qualityFlags.push("potential_pii");

    const role = inferColumnRole(name, type, category, cardinality, totalSampled, isBooleanLikeValues);

    return { name, type, category, role, nullCount, nullRate, totalSampled, cardinality, cardinalityRatio, isHighCardinality, isLowCardinality, isConstant, topValues, min, max, mean, stddev, isSkewed, qualityFlags } as ColumnProfile;
  });
}

function inferColumnRole(colName: string, rawType: string, category: string, cardinality: number, totalSampled: number, isBooleanLikeValues: boolean): "id" | "measure" | "label" | "category" | "timestamp" | "flag" | "unknown" {
  const n = String(colName).toLowerCase();
  const type = String(rawType || "").toLowerCase();
  const hasDeclaredType = type.length > 0;
  const isBooleanType = /\b(bool|boolean|bit)\b/.test(type);

  if (category === "temporal" || /date|time|timestamp|created|updated|at$/i.test(n)) return "timestamp";
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

function classifyTable(tableName: string, columns: any[], foreignKeys: any[], rowCount: number | undefined, columnProfiles: ColumnProfile[]): TableClassification {
  const signals: string[] = [];
  const numCols = columns.length;
  const numFKs = foreignKeys.length;
  const numericCols = columnProfiles.filter(p => p.category === "numeric" && p.role === "measure").length;
  const temporalCols = columnProfiles.filter(p => p.category === "temporal").length;
  const textLabelCols = columnProfiles.filter(p => p.role === "label" || p.role === "category").length;

  if (numFKs >= 2 && numCols <= numFKs + 3) {
    signals.push(`${numFKs} foreign keys with only ${numCols} columns → junction table`);
    return { tableClass: "junction", confidence: 90, signals };
  }

  if ((rowCount !== undefined && rowCount < 100) && textLabelCols > numericCols) {
    signals.push(`Only ${rowCount} rows, mostly label/category columns → lookup table`);
    return { tableClass: "lookup", confidence: 80, signals };
  }

  if ((rowCount === undefined || rowCount > 500) && temporalCols >= 1 && numericCols >= 1) {
    signals.push(`Temporal + numeric columns with ${rowCount ?? "?"} rows → fact table`);
    if (numFKs > 0) signals.push(`${numFKs} foreign keys to dimension tables`);
    return { tableClass: "fact", confidence: 75, signals };
  }

  if (textLabelCols >= 2 && numericCols <= 2) {
    signals.push(`Mostly label/category columns (${textLabelCols}) → dimension table`);
    return { tableClass: "dimension", confidence: 70, signals };
  }

  signals.push("Mixed structure, not clearly classifiable");
  return { tableClass: "unknown", confidence: 40, signals };
}

function buildDataQualityReport(columnProfiles: ColumnProfile[]): DataQualityReport {
  if (columnProfiles.length === 0) {
    return { healthScore: 100, completeness: 100, uniqueness: 100, consistency: 100, issues: [] };
  }

  const issues: DataQualityReport["issues"] = [];
  const completeness = Math.round((columnProfiles.reduce((sum, p) => sum + (1 - p.nullRate), 0) / columnProfiles.length) * 100);
  const keyColumns = columnProfiles.filter(p => p.role === "id" || p.role === "measure");
  const uniqueScore = keyColumns.length > 0 ? Math.round((keyColumns.filter(p => !p.isConstant).length / keyColumns.length) * 100) : 100;
  const cleanCols = columnProfiles.filter(p => p.qualityFlags.length === 0).length;
  const consistency = Math.round((cleanCols / columnProfiles.length) * 100);

  columnProfiles.forEach(p => {
    if (p.nullRate > 0.5) issues.push({ column: p.name, issue: `${Math.round(p.nullRate * 100)}% null values`, severity: "high" });
    else if (p.nullRate > 0.2) issues.push({ column: p.name, issue: `${Math.round(p.nullRate * 100)}% null values`, severity: "medium" });
    if (p.isConstant && p.totalSampled > 5) issues.push({ column: p.name, issue: "All values identical (constant column)", severity: "medium" });
    if (p.qualityFlags.includes("potential_pii")) issues.push({ column: p.name, issue: "Possible PII (sensitive data)", severity: "high" });
    if (p.isSkewed) issues.push({ column: p.name, issue: "High numeric skew detected", severity: "low" });
  });

  const healthScore = Math.round(completeness * 0.4 + uniqueScore * 0.3 + consistency * 0.3);
  return { healthScore, completeness, uniqueness: uniqueScore, consistency, issues };
}

function buildTableDataMatrix(tableSchema: any, sampleRows: any[], rowCount?: number, foreignKeys?: any[]) {
  const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
  const fks = Array.isArray(foreignKeys || tableSchema?.foreignKeys) ? (foreignKeys || tableSchema?.foreignKeys) : [];
  const columnCounts = { total: columns.length, numeric: 0, temporal: 0, text: 0, boolean: 0, other: 0 };
  const categoricalCandidates: any[] = [];
  const numericCandidates: any[] = [];

  columns.forEach((col: any) => {
    const category = col.category || categorizeDataType(col.type || col.data_type || "");
    if (category === "numeric") columnCounts.numeric += 1;
    else if (category === "temporal") columnCounts.temporal += 1;
    else if (category === "text") columnCounts.text += 1;
    else if (category === "boolean") columnCounts.boolean += 1;
    else columnCounts.other += 1;

    if (category === "numeric") {
      numericCandidates.push({ column: getColumnName(col), type: col.type || col.data_type || "" });
    }

    if (category === "text" && sampleRows?.length) {
      const values = sampleRows.map((row) => row?.[getColumnName(col)]).filter((val) => val !== null && val !== undefined).map((val) => String(val));
      const distinct = Array.from(new Set(values));
      if (distinct.length > 0 && distinct.length <= 12) {
        categoricalCandidates.push({ column: getColumnName(col), sampleDistinct: distinct.length, sampleValues: distinct.slice(0, 10) });
      }
    }
  });

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

export const connectorRouterSubagent: SubagentWithConfig<{
  connectionString?: string;
  connectorType?: string;
  schemaHint?: string;
  projectContext?: string;
}, {
  kind: "postgres" | "mssql";
  skills: ConnectorSkillSet;
  routing: ConnectorRoutingContext;
}> = {
  id: "connector-router",
  config: { maxRetries: 2, timeoutMs: 30000, enableFallback: true },
  run: async (input) => {
    registerConnectorSkills();
    const resolved = await resolveConnectorSkills({
      connectionString: input.connectionString,
      connectorType: input.connectorType,
      schemaHint: input.schemaHint,
      projectContext: input.projectContext
    });
    return {
      kind: resolved.kind,
      skills: resolved.skills,
      routing: resolved.routing
    };
  }
};

export const tableScannerSubagent: SubagentWithConfig<{
  tables: string[];
  connectionString: string;
  skillId: string;
  allowedTables?: string[];
}, {
  schemaInfo: Record<string, any>;
  tableCounts: Record<string, number>;
  relationships: any[];
}> = {
  id: "table-scanner",
  config: { maxRetries: 2, timeoutMs: 120000, enableFallback: true },
  run: async (input) => {
    const schemaInfo: Record<string, any> = {};
    const tableCounts: Record<string, number> = {};
    const relationships: any[] = [];
    const normalizedToOriginal = new Map<string, string>();

    input.tables.forEach((tableName) => {
      normalizedToOriginal.set(normalizeTableIdentifier(tableName), tableName);
    });

    for (const tableName of input.tables) {
      try {
        const schemaResult = await runSkill<any, any>(input.skillId, {
          operation: "getTableSchema",
          connectionString: input.connectionString,
          tableName
        });
        const tableSchema = schemaResult?.data;
        if (tableSchema && tableSchema.columns) {
          tableSchema.columns = tableSchema.columns.map((column: any) => ({
            ...column,
            name: column.column_name || column.name,
            type: column.data_type || column.type,
            isPrimary: Boolean(column.isPrimary || column.isPrimaryKey || (Array.isArray(tableSchema?.primaryKeys) && tableSchema.primaryKeys.includes(column.column_name || column.name))),
            category: categorizeDataType(column.data_type || column.type || ""),
            isNumeric: isNumericType(column.data_type || column.type || ""),
            isTemporal: isTemporalType(column.data_type || column.type || ""),
            isText: isTextType(column.data_type || column.type || "")
          }));
        }
        if (tableSchema && Array.isArray(tableSchema.foreignKeys)) {
          tableSchema.foreignKeys = tableSchema.foreignKeys.map((fk: any) => {
            const normalizedTarget = normalizeTableIdentifier(fk?.foreign_table_name || "");
            const canonicalTarget = normalizedToOriginal.get(normalizedTarget);
            if (!canonicalTarget) return null;
            return { ...fk, foreign_table_name: canonicalTarget };
          }).filter(Boolean);
        }

        schemaInfo[tableName] = tableSchema;

        const countResult = await runSkill<any, any>(input.skillId, {
          operation: "getRowCount",
          connectionString: input.connectionString,
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
      } catch (error) {
        log.warn("table_scan_error", { table: tableName, error: error instanceof Error ? error.message : String(error) });
        schemaInfo[tableName] = { columns: [] };
        tableCounts[tableName] = 0;
      }
    }

    return { schemaInfo, tableCounts, relationships };
  }
};

export const columnProfilerSubagent: SubagentWithConfig<{
  tableName: string;
  sampleRows: any[];
  columns: any[];
  foreignKeys: any[];
  rowCount?: number;
}, {
  dataMatrix: ReturnType<typeof buildTableDataMatrix>;
}> = {
  id: "column-profiler",
  config: { maxRetries: 1, timeoutMs: 30000, enableFallback: true },
  run: async (input) => {
    const dataMatrix = buildTableDataMatrix(
      { columns: input.columns, foreignKeys: input.foreignKeys },
      input.sampleRows,
      input.rowCount,
      input.foreignKeys
    );
    return { dataMatrix };
  }
};

export const filterDetectorSubagent: SubagentWithConfig<{
  schemaInfo: Record<string, any>;
  sampleData: Record<string, any[]>;
  tableCounts: Record<string, number>;
  relationships: any[];
}, {
  dateColumns: any[];
  categoricalColumns: any[];
  entityColumns: any[];
  searchColumns: any[];
  summary: string;
}> = {
  id: "filter-detector",
  config: { maxRetries: 1, timeoutMs: 15000, enableFallback: true },
  run: async (input) => {
    const dateColumns: any[] = [];
    const categoricalColumns: any[] = [];
    const entityColumns: any[] = [];
    const searchColumns: any[] = [];

    for (const [table, info] of Object.entries(input.schemaInfo)) {
      const columns = (info as any)?.columns || [];
      columns.forEach((col: any) => {
        const colName = col.name || col.column_name;
        const colType = (col.type || col.data_type || "").toLowerCase();
        const samples = input.sampleData[table] || [];
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
    const summaryLines: string[] = [];
    if (primaryDate) summaryLines.push(`Date range filter: ${primaryDate.table}.${primaryDate.column}`);
    if (categoricalColumns.length > 0) summaryLines.push(`Categorical filters: ${categoricalColumns.slice(0, 5).map((c) => `${c.table}.${c.column}`).join(", ")}`);

    return {
      dateColumns,
      categoricalColumns,
      entityColumns,
      searchColumns,
      summary: summaryLines.join("\n") || "No filterable dimensions detected."
    };
  }
};

export const semanticAnalyzerSubagent: SubagentWithConfig<{
  schemaInfo: Record<string, any>;
  sampleData: Record<string, any[]>;
  relationships: any[];
  projectContext?: string;
  tableCounts?: Record<string, number>;
}, { analysis: string }> = {
  id: "semantic-analyzer",
  config: { maxRetries: 2, timeoutMs: 60000, enableFallback: true },
  run: async (input) => {
    registerSchemaAnalysisSkill();

    const tableEntries = Object.entries(input.schemaInfo);
    const simplifiedSchema = tableEntries.slice(0, 25).map(([table, info]: [string, any]) => {
      const pk = info.columns?.find((c: any) => c.isPrimary)?.name || "id";
      const rowCount = input.tableCounts?.[table] ? ` ~${input.tableCounts[table].toLocaleString()} rows` : "";
      const cols = (info.columns || []).slice(0, 8).map((c: any) => {
        const name = c.name || c.column_name;
        const type = c.type || c.data_type || "";
        const tag = c.isPrimary ? ":PK" : info.foreignKeys?.some((fk: any) => fk.column_name === name) ? ":FK" : "";
        return `${name}${tag}(${type})`;
      }).join(", ");
      return `- ${table} (PK:${pk}${rowCount}) [${cols}]`;
    }).join("\n");

    const relText = (input.relationships || []).slice(0, 10).map((r: any) => {
      if (r?.from?.table && r?.to?.table) return `${r.from.table}.${r.from.column} -> ${r.to.table}.${r.to.column}`;
      if (r?.fromTable && r?.toTable) return `${r.fromTable}.${r.via || "?"} -> ${r.toTable}.${r.targetColumn || "?"}`;
      return null;
    }).filter(Boolean).join("\n");

    const limitedSampleData: Record<string, any[]> = {};
    Object.entries(input.sampleData).slice(0, 3).forEach(([table, rows]) => {
      if (rows?.length > 0) {
        const prunedRow = Object.fromEntries(Object.entries(rows[0]).slice(0, 5));
        limitedSampleData[table] = [prunedRow];
      }
    });

    try {
      const { analysis } = await runSkill<any, any>("schema-analysis", {
        simplifiedSchema,
        relText,
        limitedSampleData,
        projectContext: input.projectContext
      });
      return { analysis: analysis || "" };
    } catch (error) {
      log.warn("semantic_analysis_failed", { error: error instanceof Error ? error.message : String(error) });
      return { analysis: `Database contains ${Object.keys(input.schemaInfo).length} tables.` };
    }
  }
};

export const tablePreviewSubagent: SubagentWithConfig<{
  tableName: string;
  connectionString: string;
  skillId: string;
}, { sampleRows: any[] }> = {
  id: "table-preview",
  config: { maxRetries: 2, timeoutMs: 30000, enableFallback: true },
  run: async (input) => {
    try {
      const previewResult = await runSkill<any, any>(input.skillId, {
        operation: "getTablePreview",
        connectionString: input.connectionString,
        tableName: input.tableName
      });
      const preview = previewResult?.data;
      return { sampleRows: Array.isArray(preview) ? preview : [] };
    } catch (error) {
      log.warn("table_preview_failed", { table: input.tableName, error: error instanceof Error ? error.message : String(error) });
      return { sampleRows: [] };
    }
  }
};

export const schemaDiscoverySubagent: SubagentWithReflection<SchemaDiscoverySubagentInput, SchemaDiscoverySubagentOutput> = {
  id: "schema-discovery-master",
  config: { maxRetries: 1, timeoutMs: 300000, enableFallback: true },
  reflection: { enabled: true, maxIterations: 3, acceptanceThreshold: 0.8 },
  run: async (input) => {
    const connectionString = input.connectionString || "";
    const connectorType = input.connectorType || "";
    const options = input.options || {};
    const allowedTables = input.allowedTables || [];
    const routingContext = input.routingContext || {};

    registerConnectorSkills();

    const resolved = await resolveConnectorSkills({
      connectionString,
      connectorType,
      schemaHint: routingContext.schemaHint,
      projectContext: routingContext.projectContext || options.projectContext
    });

    const schemaDiscoverySkillId = resolved.skills.schemaDiscoverySkillId;

    const connectResult = await runSkill<any, any>(schemaDiscoverySkillId, { operation: "connect", connectionString });
    if (!connectResult?.ok) {
      throw new Error(connectResult?.error || "Failed to connect to database");
    }

    const tablesResult = await runSkill<any, any>(schemaDiscoverySkillId, { operation: "listTables", connectionString, allowedTables });
    let allTables = Array.isArray(tablesResult?.data) ? tablesResult.data : [];

    if (allowedTables.length > 0) {
      const allowedLower = new Set(allowedTables.map((t: string) => normalizeTableIdentifier(t)));
      allTables = allTables.filter((t: string) => t && allowedLower.has(normalizeTableIdentifier(t)));
    }

    if (allTables.length === 0) {
      return {
        tables: [],
        schemaInfo: {},
        sampleData: {},
        tableCounts: {},
        relationships: [],
        tableInsights: null,
        tableRanking: [],
        deepProfiledTables: [],
        filterCandidates: { summary: "No tables found" },
        rawAnalysis: "No tables found",
        connectorRouting: resolved.routing,
        selectedConnectorSkills: resolved.skills
      };
    }

    const scannerResult = await tableScannerSubagent.run({
      tables: allTables,
      connectionString,
      skillId: schemaDiscoverySkillId,
      allowedTables
    });

    const minDeepTables = allTables.length <= 8 ? allTables.length : 5;
    const maxDeepTables = allTables.length <= 8 ? allTables.length : 8;
    const ranking = rankTablesForIntent({
      schemaInfo: scannerResult.schemaInfo,
      tableCounts: scannerResult.tableCounts,
      relationships: scannerResult.relationships,
      options,
      minTables: minDeepTables,
      maxTables: maxDeepTables
    });

    const deepProfiledTables = ranking.deepProfiledTables;
    const sampleData: Record<string, any[]> = {};

    for (const tableName of allTables) {
      if (!deepProfiledTables.includes(tableName)) {
        sampleData[tableName] = [];
        continue;
      }
      const preview = await tablePreviewSubagent.run({ tableName, connectionString, skillId: schemaDiscoverySkillId });
      sampleData[tableName] = preview.sampleRows;
    }

    const tableInsights: Record<string, TableInsight> = {};
    for (const tableName of deepProfiledTables) {
      const tableSchema = scannerResult.schemaInfo[tableName];
      const rows = sampleData[tableName] || [];
      const rowCount = scannerResult.tableCounts[tableName];
      const foreignKeys = tableSchema?.foreignKeys || [];

      const shouldEnrich = options.enableSemanticSearch || options.enableTableKpis || options.enableTableMatrix || options.enableTableFilters;

      if (shouldEnrich) {
        const dataMatrix = buildTableDataMatrix(tableSchema, rows, rowCount, foreignKeys);
        tableInsights[tableName] = { dataMatrix };
      } else {
        const columnProfiles = rows.length > 0 ? buildColumnProfiles(tableSchema?.columns || [], rows) : [];
        const classification = classifyTable(tableName, tableSchema?.columns || [], foreignKeys, rowCount, columnProfiles);
        const qualityReport = buildDataQualityReport(columnProfiles);
        tableInsights[tableName] = {
          dataMatrix: { 
            rowCount, 
            columnCounts: { total: 0, numeric: 0, temporal: 0, text: 0, boolean: 0, other: 0 }, 
            categoricalCandidates: [],
            numericCandidates: [],
            columnProfiles, 
            classification, 
            qualityReport 
          }
        };
      }
    }

    const filterResult = await filterDetectorSubagent.run({
      schemaInfo: scannerResult.schemaInfo,
      sampleData,
      tableCounts: scannerResult.tableCounts,
      relationships: scannerResult.relationships
    });

    let rawAnalysis = "";
    if (options.enableSemanticSearch) {
      const semanticResult = await semanticAnalyzerSubagent.run({
        schemaInfo: scannerResult.schemaInfo,
        sampleData,
        relationships: scannerResult.relationships,
        projectContext: options.projectContext,
        tableCounts: scannerResult.tableCounts
      });
      rawAnalysis = semanticResult.analysis;
    }

    return {
      tables: allTables,
      schemaInfo: scannerResult.schemaInfo,
      sampleData,
      tableCounts: scannerResult.tableCounts,
      relationships: scannerResult.relationships,
      tableInsights,
      tableRanking: ranking.rankedTables,
      deepProfiledTables,
      filterCandidates: filterResult,
      rawAnalysis,
      connectorRouting: resolved.routing,
      selectedConnectorSkills: resolved.skills
    };
  }
};

export type WidgetType = "kpi" | "table" | "chart" | "line" | "bar" | "area" | "pie" | "scatter";

export const WIDGET_PRIORITY_ORDER: WidgetType[] = ["kpi", "table", "chart", "line", "bar", "area", "pie", "scatter"];

export function validateWidgetPriority(
  widgets: Array<{ type?: string }>,
  allowedTypes: string[]
): { isValid: boolean; missing: string[]; score: number } {
  const widgetTypes = new Set(widgets.map(w => w.type).filter(Boolean));
  
  const required: string[] = [];
  const recommended: string[] = [];
  
  if (allowedTypes.includes("kpi")) required.push("kpi");
  if (allowedTypes.includes("table")) required.push("table");
  if (allowedTypes.some(t => ["chart", "line", "bar", "area"].includes(t))) recommended.push("chart");
  
  const missing: string[] = [];
  let score = 100;
  
  for (const r of required) {
    if (!widgetTypes.has(r)) {
      missing.push(r);
      score -= r === "kpi" ? 20 : 15;
    }
  }
  
  for (const rec of recommended) {
    if (!widgetTypes.has(rec)) {
      score -= 10;
    }
  }
  
  return {
    isValid: missing.length === 0,
    missing,
    score: Math.max(0, score)
  };
}

export function suggestMissingWidgets(
  schemaInfo: Record<string, any>,
  currentWidgets: Array<{ type?: string }>,
  allowedTypes: string[]
): Array<{ type: string; title: string; goal: string; suggestedTable: string }> {
  const suggestions: Array<{ type: string; title: string; goal: string; suggestedTable: string }> = [];
  const currentTypes = new Set(currentWidgets.map(w => w.type).filter(Boolean));
  
  const tables = Object.keys(schemaInfo);
  const firstTable = tables[0] || "unknown";
  const tableInfo = schemaInfo[firstTable] as any;
  const columns = tableInfo?.columns || [];
  const numericCols = columns.filter((c: any) => c.isNumeric || c.category === "numeric");
  const textCols = columns.filter((c: any) => c.isText || c.category === "text");
  
  if (allowedTypes.includes("kpi") && !currentTypes.has("kpi")) {
    const metricCol = numericCols[0]?.name || columns[0]?.name || "id";
    suggestions.push({
      type: "kpi",
      title: "Key Metric",
      goal: `COUNT(${firstTable}.${metricCol})`,
      suggestedTable: firstTable
    });
  }
  
  if (allowedTypes.includes("table") && !currentTypes.has("table")) {
    suggestions.push({
      type: "table",
      title: "Data Overview",
      goal: "Show all records",
      suggestedTable: firstTable
    });
  }
  
  const chartTypes = ["line", "bar", "area", "chart"].filter(t => allowedTypes.includes(t));
  if (chartTypes.length > 0 && !currentTypes.has("chart") && !currentTypes.has("line") && !currentTypes.has("bar") && !currentTypes.has("area")) {
    const groupCol = textCols[0]?.name || columns[0]?.name || "id";
    suggestions.push({
      type: chartTypes[0],
      title: "Trend Chart",
      goal: `COUNT by ${groupCol}`,
      suggestedTable: firstTable
    });
  }
  
  return suggestions;
}

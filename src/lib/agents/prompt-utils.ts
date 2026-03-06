/* eslint-disable @typescript-eslint/no-explicit-any */
// prompt-utils.ts — LLM prompt construction from raw runtime schema objects.
// The schemaForPrompt input is a flexible dynamic object; `any` is intentional.
import { TableInsight } from "./schema-discovery";

/**
 * SQL-engineer-grade table insights digest.
 * Exposes column roles, null rates, enum values, table classification, and 
 * validated query examples so downstream agents can write optimal SQL.
 */
export function formatTableInsightsForPrompt(tableInsights: Record<string, TableInsight> | null) {
    if (!tableInsights) return "";
    const lines: string[] = [];

    // Sort tables to keep output deterministic
    const tables = Object.keys(tableInsights).sort();

    tables.slice(0, 15).forEach((table) => {
        const insight = tableInsights[table];
        if (!insight) return;

        const cls = insight.dataMatrix?.classification?.tableClass || "unknown";
        const clsLabel = cls !== "unknown" ? ` [${cls.toUpperCase()}]` : "";
        const health = insight.dataMatrix?.qualityReport?.healthScore;
        const healthLabel = health !== undefined ? ` (Health: ${health}%)` : "";

        lines.push(`TABLE ${table}${clsLabel}${healthLabel}`);

        // Column Profiles (the most important part for the SQL engineer)
        const profiles = insight.dataMatrix?.columnProfiles || [];
        const colLines: string[] = [];
        profiles.slice(0, 12).forEach((p) => {
            const roleAnnot = p.role && p.role !== "unknown" ? ` @${p.role}` : "";
            const nullHint = p.nullRate > 0.05 ? ` [null:${Math.round(p.nullRate * 100)}%]` : "";
            const enumHint = (p.isLowCardinality && p.topValues?.length)
                ? ` [values:${p.topValues.slice(0, 3).map(v => v.value).join("|")}]`
                : "";
            const numHint = (p.role === "measure" && p.mean !== undefined)
                ? ` [avg:${Math.round(p.mean)}]`
                : "";
            const piiHint = p.qualityFlags?.includes("potential_pii") ? " [PII]" : "";
            const constHint = p.isConstant ? " [CONSTANT]" : "";

            colLines.push(`    ${p.name}(${p.type})${roleAnnot}${nullHint}${enumHint}${numHint}${piiHint}${constHint}`);
        });

        if (colLines.length > 0) {
            lines.push("  COLUMNS:");
            lines.push(...colLines);
        }

        // Quality Issues
        const issues = (insight.dataMatrix?.qualityReport?.issues || [])
            .filter(i => i.severity === "high" || i.severity === "medium");
        if (issues.length > 0) {
            lines.push("  ISSUES:");
            issues.slice(0, 3).forEach(i => lines.push(`    - ${i.column}: ${i.issue}`));
        }

        // Verified SQL Examples
        const examples = insight.queryExamples || [];
        const validExamples = examples.filter(ex => !ex.error && ex.sql);
        if (validExamples.length > 0) {
            lines.push("  VERIFIED QUERIES:");
            validExamples.slice(0, 2).forEach(ex => {
                lines.push(`    - ${ex.description}: ${ex.sql.replace(/\n/g, " ")}`);
            });
        }
        lines.push("");
    });

    return lines.join("\n").slice(0, 10000);
}

/**
 * Enhanced schema text with PK/FK/Role annotations.
 */
export function buildSchemaTextForTables(schemaForPrompt: any, tables: string[]) {
    return tables.map((table) => {
        const info = schemaForPrompt?.schemaInfo?.[table];
        const profiles: any[] = schemaForPrompt?.tableInsights?.[table]?.dataMatrix?.columnProfiles || [];
        const profileMap = new Map(profiles.map((p: any) => [p.name, p]));
        const cls = schemaForPrompt?.tableInsights?.[table]?.dataMatrix?.classification?.tableClass;
        const clsTag = cls ? ` [${cls}]` : "";

        const cols = (info?.columns || [])
            .map((c: any) => {
                const name = c?.name || c?.column_name || '';
                const type = c?.type || c?.data_type || '';
                const tags: string[] = [];
                if (c.isPrimary) tags.push('PK');
                if (c.isForeignKey || info?.foreignKeys?.some((fk: any) => fk.column_name === name)) tags.push('FK');

                const prof = profileMap.get(name);
                if (prof) {
                    if (prof.role && prof.role !== 'unknown') tags.push(`@${prof.role}`);
                    if (prof.nullRate > 0.1) tags.push(`null:${Math.round(prof.nullRate * 100)}%`);
                    if (prof.isConstant) tags.push('CONST');
                    if (prof.isLowCardinality && !prof.isHighCardinality)
                        tags.push(`enum:${prof.topValues?.slice(0, 3).map((v: any) => v.value).join('|')}`);
                }

                const annotation = tags.length > 0 ? ` [${tags.join(',')}]` : '';
                return `${name} (${type})${annotation}`;
            }).join(', ');

        return `TABLE "${table}"${clsTag} [${cols}]`;
    }).join('\n');
}

/**
 * Synthesize SQL-specific coaching notes from insights.
 */
export function buildSqlHintsFromInsights(tableInsights: Record<string, TableInsight> | null, tables: string[]): string {
    if (!tableInsights) return "";
    const hints: string[] = [];

    tables.forEach(table => {
        const insight = tableInsights[table];
        if (!insight) return;

        const tableHints: string[] = [];
        const cls = insight.dataMatrix?.classification?.tableClass;
        if (cls === "dimension" || cls === "lookup") {
            tableHints.push(`${table}: dimension table — prefer INNER JOIN when used as a filter; LEFT JOIN when optional`);
        } else if (cls === "fact") {
            tableHints.push(`${table}: fact table — use as the primary FROM table; LEFT JOIN dimensions onto it`);
        } else if (cls === "junction") {
            tableHints.push(`${table}: junction table — always JOIN both referenced tables; rarely SELECT * directly`);
        }

        const profiles = insight.dataMatrix?.columnProfiles || [];
        const groupableTextEnum = profiles
            .filter((p: any) => (p.role === "category" || p.role === "label") && (p.isLowCardinality || p.qualityFlags?.includes("possible_enum")))
            .map((p: any) => p.name);
        const groupableDate = profiles
            .filter((p: any) => p.role === "timestamp")
            .map((p: any) => p.name);
        const measureCols = profiles
            .filter((p: any) => p.role === "measure" || p.category === "numeric")
            .map((p: any) => p.name);

        if (groupableTextEnum.length > 0) {
            tableHints.push(`  GROUP BY dimensions (text/enum): ${groupableTextEnum.slice(0, 4).join(", ")}`);
        }
        if (groupableDate.length > 0) {
            tableHints.push(`  GROUP BY dates using DATE_TRUNC granularity: ${groupableDate.slice(0, 3).join(", ")}`);
        }
        if (measureCols.length > 0) {
            tableHints.push(`  Aggregate numeric measures (SUM/AVG/COUNT): ${measureCols.slice(0, 4).join(", ")}`);
        }

        profiles.forEach(p => {
            if (p.nullRate > 0.2 && (p.role === "measure" || p.role === "id")) {
                tableHints.push(`  COALESCE("${p.name}", 0) — ${Math.round(p.nullRate * 100)}% null`);
            }
            if (p.isSkewed && p.role === "measure") {
                tableHints.push(`  "${p.name}" is SKEWED (stddev > 2*mean) — median/percentile may be better than AVG`);
            }
            if (p.qualityFlags?.includes("potential_pii")) {
                tableHints.push(`  "${p.name}" contains PII — avoid GROUP BY, use aggregated counts only`);
            }
        });

        if (tableHints.length > 0) {
            hints.push(tableHints.join("\n"));
        }
    });

    return hints.length > 0 ? hints.join("\n\n") : "";
}

/**
 * Build human-readable join candidates with recommended join types.
 */
export function buildJoinCandidatesText(relationships: any[], tableInsights?: Record<string, TableInsight> | null) {
    return (relationships || [])
        .map((rel: any) => {
            const from = rel?.from?.table || rel?.fromTable;
            const to = rel?.to?.table || rel?.toTable;
            const fromCol = rel?.from?.column || rel?.via;
            const toCol = rel?.to?.column || rel?.targetColumn;

            if (!from || !to) return null;

            const fromClass = tableInsights?.[from]?.dataMatrix?.classification?.tableClass;
            const toClass = tableInsights?.[to]?.dataMatrix?.classification?.tableClass;

            let joinHint = "";
            if (toClass === "dimension" || toClass === "lookup") joinHint = " → LEFT JOIN (dim)";
            else if (fromClass === "junction") joinHint = " → INNER JOIN (junction)";
            else joinHint = rel?.type ? ` (${rel.type})` : "";

            return `${from}.${fromCol} -> ${to}.${toCol}${joinHint}`;
        })
        .filter(Boolean)
        .join("\n");
}

export function truncatePlannerText(value: string, maxChars: number) {
    if (!value) return value;
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

export function buildPlannerRulesBlock(allowedTypes: string[], orderedAllowedTypes: string[], requiredWidgetCount: number) {
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

export function buildStrategySchemaSummary(schemaForPrompt: any) {
    const tables = Object.keys(schemaForPrompt?.schemaInfo || {});
    const relationships = Array.isArray(schemaForPrompt?.relationships) ? schemaForPrompt.relationships : [];
    const dateColumns = schemaForPrompt?.filterCandidates?.dateColumns || [];
    const insights = schemaForPrompt?.tableInsights || {};

    // Classify tables by role
    const factTables = tables.filter(t => insights[t]?.dataMatrix?.classification?.tableClass === "fact");
    const dimTables = tables.filter(t => insights[t]?.dataMatrix?.classification?.tableClass === "dimension");
    const junctionTables = tables.filter(t => insights[t]?.dataMatrix?.classification?.tableClass === "junction");

    // Tables with real data
    const nonempty = tables.filter(t => (schemaForPrompt?.tableCounts?.[t] || 0) > 0);

    return [
        `Tables: ${tables.length} (non-empty: ${nonempty.length})`,
        factTables.length > 0 ? `Fact tables: ${factTables.join(", ")}` : null,
        dimTables.length > 0 ? `Dimension tables: ${dimTables.join(", ")}` : null,
        junctionTables.length > 0 ? `Junction tables: ${junctionTables.join(", ")}` : null,
        `Relationships: ${relationships.length}`,
        `Date columns: ${dateColumns.length}`,
    ].filter(Boolean).join("\n");
}

export function buildFocusedPlannerContext(input: {
    schemaInfo: Record<string, any>;
    tableInsights?: Record<string, TableInsight> | null;
    sampleData?: Record<string, any[]>;
    tableCounts?: Record<string, number>;
    relationships?: any[];
    deepProfiledTables?: string[];
    maxTopTables?: number;
}) {
    const schemaInfo = input.schemaInfo || {};
    const tableInsights = input.tableInsights || null;
    const sampleData = input.sampleData || {};
    const tableCounts = input.tableCounts || {};
    const relationships = Array.isArray(input.relationships) ? input.relationships : [];
    const ranked = Array.isArray(input.deepProfiledTables) ? input.deepProfiledTables : [];
    const maxTopTables = Math.max(1, Number(input.maxTopTables || 6));

    const topTables = ranked.length > 0
        ? ranked.slice(0, maxTopTables)
        : Object.keys(schemaInfo).slice(0, maxTopTables);
    const topSet = new Set(topTables);

    const fullProfiles = topTables
        .map((table) => {
            if (!schemaInfo[table]) return null;
            const schemaLine = buildSchemaTextForTables({ schemaInfo, tableInsights }, [table]);
            const sampleRows = Array.isArray(sampleData?.[table]) ? sampleData[table].slice(0, 1) : [];
            const count = Number(tableCounts?.[table] || 0);
            return [
                schemaLine,
                count > 0 ? `ROW_COUNT: ${count}` : null,
                sampleRows.length > 0 ? `SAMPLE: ${JSON.stringify(sampleRows)}` : null
            ].filter(Boolean).join("\n");
        })
        .filter(Boolean)
        .join("\n\n");

    const stubLines = Object.keys(schemaInfo)
        .filter((table) => !topSet.has(table))
        .map((table) => {
            const info = schemaInfo[table];
            const columns = Array.isArray(info?.columns) ? info.columns : [];
            const keyCols = columns
                .slice(0, 4)
                .map((c: any) => `${c?.name || c?.column_name}(${c?.type || c?.data_type || "?"})`)
                .join(", ");
            const count = Number(tableCounts?.[table] || 0);
            return `- ${table}: ${columns.length} cols${count > 0 ? `, ${count} rows` : ""}${keyCols ? `, key cols: ${keyCols}` : ""}`;
        })
        .join("\n");

    const focusedRelationships = relationships.filter((rel: any) => {
        const from = rel?.from?.table || rel?.fromTable;
        const to = rel?.to?.table || rel?.toTable;
        return topSet.has(String(from || "")) || topSet.has(String(to || ""));
    });

    return {
        topTables,
        fullProfiles,
        stubLines,
        focusedRelationships
    };
}

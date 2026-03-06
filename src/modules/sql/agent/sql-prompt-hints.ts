/* eslint-disable @typescript-eslint/no-explicit-any */

export function findLatestDate(sampleData: Record<string, any[]>): string | null {
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

    const diffDays = (Date.now() - maxTimestamp) / (1000 * 60 * 60 * 24);
    if (diffDays > 30) {
        return new Date(maxTimestamp).toISOString().split('T')[0];
    }
    return null;
}

export function buildDateContext(referenceDate?: string | null) {
    const base = referenceDate ? new Date(`${referenceDate}T00:00:00Z`) : new Date();
    const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
    const format = (date: Date) => date.toISOString().slice(0, 10);
    const startOfWeekUtc = (date: Date) => {
        const day = date.getUTCDay();
        const diff = (day + 6) % 7;
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

function findBestQueryPatterns(
    widgetGoal: string,
    widgetTable: string,
    queryExamples: any[]
): any[] {
    if (!queryExamples || queryExamples.length === 0) return [];

    const goalLower = widgetGoal.toLowerCase();
    const patterns: Array<{ example: any; score: number; reasons: string[] }> = [];

    queryExamples.forEach((ex: any) => {
        let score = 0;
        const reasons: string[] = [];
        const descLower = ex.description?.toLowerCase() || '';
        const sqlLower = ex.sql?.toLowerCase() || '';

        if (ex.table?.toLowerCase() === widgetTable?.toLowerCase()) {
            score += 50;
            reasons.push('Same table');
        }

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

        if (ex.results && ex.results.length > 0) {
            score += 10;
            reasons.push('Verified working');
        }

        if (ex.executionTime && ex.executionTime < 100) {
            score += 5;
            reasons.push('Fast query');
        }

        if (score > 0) {
            patterns.push({ example: ex, score, reasons });
        }
    });

    return patterns
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(p => ({
            ...p.example,
            matchScore: p.score,
            matchReasons: p.reasons
        }));
}

function generateDynamicSqlGuidance(
    widget: any,
    bestPatterns: any[],
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

        guidance.push('**How to adapt:**');

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

export function buildSqlPromptHints(schemaForPrompt: any) {
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
                    sampleQueries: filter.examples.sampleQueries?.slice(0, 2),
                    queryToGetValues: filter.examples.queryToGetValues
                });
            }
        });
    });

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

    const queryExamplesWithResults: any[] = [];
    Object.entries(tableInsights).forEach(([table, insight]: [string, any]) => {
        const examples = insight?.queryExamples || [];
        examples.forEach((ex: any) => {
            if (ex?.results && ex.results.length > 0) {
                queryExamplesWithResults.push({
                    table,
                    description: ex.description,
                    sql: ex.sql,
                    results: ex.results.slice(0, 3),
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
        findBestPatterns: (widgetGoal: string, widgetTable: string) =>
            findBestQueryPatterns(widgetGoal, widgetTable, queryExamplesWithResults),
        generateDynamicGuidance: (widget: any, bestPatterns: any[], isMssql: boolean) =>
            generateDynamicSqlGuidance(widget, bestPatterns, isMssql)
    };
}

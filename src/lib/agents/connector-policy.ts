/* eslint-disable @typescript-eslint/no-explicit-any */

import {
    normalizeSqlForValidation,
    stripSqlLiteralsAndComments,
    resolveConnectorDialect,
} from "./query-runtime";
import { runSkill } from "@/lib/skills/registry";
import { registerConnectorSkills, resolveConnectorSkills } from "@/lib/skills/connectors";

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

function extractQualifiedColumnRefs(sql: string) {
    const refs: Array<{ tableOrAlias: string; column: string; raw: string }> = [];
    const regex = /(["`\[]?[a-zA-Z_][a-zA-Z0-9_$]*["`\]]?)\s*\.\s*(["`\[]?[a-zA-Z_][a-zA-Z0-9_$]*["`\]]?)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(sql)) !== null) {
        const tableOrAlias = String(match[1] || "").replace(/["`\[\]]/g, "");
        const column = String(match[2] || "").replace(/["`\[\]]/g, "");
        if (!tableOrAlias || !column || column === "*") continue;
        refs.push({
            tableOrAlias,
            column,
            raw: `${tableOrAlias}.${column}`
        });
    }
    return refs;
}

function buildSchemaColumnsByTable(schemaForPrompt: any) {
    const byTable = new Map<string, Set<string>>();
    Object.entries(schemaForPrompt?.schemaInfo || {}).forEach(([table, info]: [string, any]) => {
        const cols = new Set<string>();
        (Array.isArray(info?.columns) ? info.columns : []).forEach((col: any) => {
            const name = String(col?.name || col?.column_name || "").toLowerCase();
            if (name) cols.add(name);
        });
        byTable.set(String(table).toLowerCase(), cols);
    });
    return byTable;
}

function validateColumnRefsAgainstSchema(sql: string, schemaForPrompt?: any) {
    const schemaColumnsByTable = buildSchemaColumnsByTable(schemaForPrompt);
    if (schemaColumnsByTable.size === 0) return { ok: true };

    const aliasMap = buildAliasMap(sql);
    const refs = extractQualifiedColumnRefs(sql);
    for (const ref of refs) {
        const rawTable = String(ref.tableOrAlias || "");
        const resolvedTable = String(aliasMap.get(rawTable) || rawTable).toLowerCase();
        if (!schemaColumnsByTable.has(resolvedTable)) continue;
        const cols = schemaColumnsByTable.get(resolvedTable);
        const col = String(ref.column || "").toLowerCase();
        if (!cols?.has(col)) {
            return {
                ok: false,
                error: `Validation failed: column ${resolvedTable}.${col} does not exist in schema.`
            };
        }
    }
    return { ok: true };
}

function validateTableWidgetSqlContract(sql: string, isMssql: boolean) {
    const hasTotalCount = /\bcount\s*\(\s*\*\s*\)\s*over\s*\(\s*\)\s+as\s+["`\[]?total_count["`\]]?/i.test(sql);
    if (!hasTotalCount) {
        return { ok: false, error: "Validation failed: table widgets must include COUNT(*) OVER() AS total_count." };
    }
    const pgPaging = /\blimit\s+\{\{\s*size(?::[^}\s]+)?\s*\}\}\s+offset\s+\{\{\s*offset(?::[^}\s]+)?\s*\}\}/i;
    const mssqlPaging = /\boffset\s+\{\{\s*offset(?::[^}\s]+)?\s*\}\}\s+rows\s+fetch\s+next\s+\{\{\s*size(?::[^}\s]+)?\s*\}\}\s+rows\s+only/i;
    const ok = isMssql ? mssqlPaging.test(sql) : pgPaging.test(sql);
    if (!ok) {
        return {
            ok: false,
            error: `Validation failed: table widgets must use ${isMssql ? "OFFSET {{offset}} ROWS FETCH NEXT {{size}} ROWS ONLY" : "LIMIT {{size}} OFFSET {{offset}}"} pagination placeholders.`
        };
    }
    return { ok: true };
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

export function validateSqlAgainstInstructions(
    sql: string,
    connectionString?: string,
    connectorInstructions?: string,
    connectorType?: string,
    schemaForPrompt?: any,
    widget?: { id?: string; type?: string } | null
) {
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
    const dialect = resolveConnectorDialect({
        connectionString,
        connectorType
    });
    const isMssql = dialect.isMssql;
    if (isMssql && /\blimit\b/i.test(trimmed)) {
        return { ok: false, error: "Validation failed: MSSQL does not support LIMIT. Use TOP or OFFSET/FETCH." };
    }
    if (!isMssql && /\btop\s+[^\s]+/i.test(trimmed)) {
        return { ok: false, error: "Validation failed: PostgreSQL does not support TOP. Use LIMIT." };
    }
    if (isMssql) {
        if (/\bilike\b/i.test(trimmed)) {
            return { ok: false, error: "Validation failed: MSSQL does not support ILIKE. Use LIKE." };
        }
        if (/\bdate_trunc\s*\(/i.test(trimmed)) {
            return { ok: false, error: "Validation failed: MSSQL does not support DATE_TRUNC." };
        }
        if (/\bcurrent_date\b/i.test(trimmed)) {
            return { ok: false, error: "Validation failed: MSSQL does not support CURRENT_DATE. Use GETDATE()." };
        }
    } else {
        if (/\bgetdate\s*\(/i.test(trimmed) || /\bdateadd\s*\(/i.test(trimmed) || /\bdatediff\s*\(/i.test(trimmed)) {
            return { ok: false, error: "Validation failed: PostgreSQL does not support GETDATE/DATEADD/DATEDIFF." };
        }
        if (/\bisnull\s*\(/i.test(trimmed)) {
            return { ok: false, error: "Validation failed: PostgreSQL does not support ISNULL. Use COALESCE." };
        }
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
    const columnValidation = validateColumnRefsAgainstSchema(trimmed, schemaForPrompt);
    if (!columnValidation.ok) return columnValidation;
    const joinValidation = validateJoinsAgainstSchema(trimmed, schemaForPrompt);
    if (!joinValidation.ok) return joinValidation;
    const widgetType = String(widget?.type || "").toLowerCase();
    if (widgetType === "table") {
        const tableContract = validateTableWidgetSqlContract(trimmed, isMssql);
        if (!tableContract.ok) return tableContract;
    }
    return { ok: true };
}

export async function validateSqlAgainstConnectorSkill(
    sql: string,
    connectionString?: string,
    connectorInstructions?: string,
    connectorType?: string,
    schemaForPrompt?: any,
    widget?: { id?: string; type?: string } | null
) {
    registerConnectorSkills();
    const resolved = await resolveConnectorSkills({
        connectionString,
        connectorType,
        schemaHint: String(schemaForPrompt?.domainSummary || ""),
        projectContext: String(schemaForPrompt?.projectContext || "")
    });
    return runSkill<any, { ok: boolean; error?: string }>(resolved.skills.sqlValidatorSkillId, {
        sql,
        connectionString,
        connectorInstructions,
        connectorType: resolved.kind,
        schemaForPrompt,
        widget
    });
}

export function resolveConnectorContextFromSchema(schemaLike: any, overrides?: { connectionString?: string; connectorType?: string; connectorInstructions?: string }) {
    const explicitType = String(overrides?.connectorType || schemaLike?.connectorType || schemaLike?.connector?.type || "").trim().toLowerCase();
    const explicitConn = String(overrides?.connectionString || schemaLike?.connectionString || schemaLike?.dbUrl || "").trim();
    const pgUrl = String(schemaLike?.postgresUrl || "").trim();
    const msUrl = String(schemaLike?.mssqlUrl || "").trim();
    let resolvedConnection = explicitConn;
    if (!resolvedConnection) {
        if (explicitType.includes("mssql") || explicitType.includes("sql server")) {
            resolvedConnection = msUrl || pgUrl;
        } else if (explicitType.includes("postgres")) {
            resolvedConnection = pgUrl || msUrl;
        } else {
            resolvedConnection = msUrl || pgUrl;
        }
    }
    const dialect = resolveConnectorDialect({
        connectionString: resolvedConnection,
        connectorType: explicitType
    });
    const connectorInstructions = String(overrides?.connectorInstructions || schemaLike?.connectorInstructions || "").trim();
    return {
        connectionString: dialect.connectionString,
        connectorType: dialect.connectorType,
        connectorInstructions,
        isMssql: dialect.isMssql,
        dialect: dialect.dialect
    };
}

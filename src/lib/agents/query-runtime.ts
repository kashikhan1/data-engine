import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { dbGateway } from "../mcp/server";
import { createDefaultChatModel } from "../llm/model";
import { normalizeFilterSet } from "../filter-contract";
import { extractJSON, invokeModelWithRetry as invokeModelWithRetryUtil } from "./llm-utils";

type RuntimePagination = {
  page: number;
  pageSize: number;
  offset?: number;
  includeTotal?: boolean;
};

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM]", timeoutMs: 900000 });

const invokeModelWithRetry = (messages: any[], maxRetries = 3, delay = 2000) =>
  invokeModelWithRetryUtil(getModel, messages, maxRetries, delay);

export function normalizeSqlForValidation(sql: string) {
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

export function stripSqlLiteralsAndComments(sql: string) {
  let text = String(sql || "");
  if (!text) return "";
  text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  text = text.replace(/--.*$/gm, " ");
  text = text.replace(/'(?:''|[^'])*'/g, "''");
  text = text.replace(/"(?:\"\"|[^"])*"/g, '""');
  return text;
}

const extractInstructionBans = (instructions: string) => {
  const bans = new Set<string>();
  if (!instructions) return bans;
  const lines = instructions.split(/\r?\n/);
  const patterns = [/(?:do not use|don't use|avoid|never use|no)\s+([a-z0-9_().\[\]]+)/i];
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

export const detectIsMssql = (connectionString?: string, connectorType?: string) => {
  const lower = String(connectionString || "").toLowerCase();
  if (
    lower.startsWith("mssql://") ||
    lower.startsWith("sqlserver://") ||
    lower.includes("server=") ||
    lower.includes("data source=")
  ) {
    return true;
  }
  const typeLower = String(connectorType || "").toLowerCase();
  return typeLower.includes("mssql") || typeLower.includes("sql server");
};

export const validateSqlWithInstructions = (
  sql: string,
  connectionString?: string,
  connectorInstructions?: string,
  connectorType?: string
) => {
  const trimmed = normalizeSqlForValidation(sql);
  const startsWithAllowed = /^(select|with|show|explain)\b/i.test(trimmed);
  if (!startsWithAllowed) {
    return { ok: false, error: "Validation failed: SQL must start with SELECT, WITH, SHOW, or EXPLAIN." };
  }
  const blocked = ["drop", "delete", "truncate", "update", "insert", "alter"];
  const sanitized = stripSqlLiteralsAndComments(trimmed).toLowerCase();
  if (blocked.some((kw) => new RegExp(`\\b${kw}\\b`, "i").test(sanitized))) {
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

export const isPlaceholderSqlQuery = (sql: string) => {
  const text = String(sql || "").toLowerCase();
  return (
    text.includes("sql generation missing") ||
    text.includes("check plan/schema") ||
    text.includes("sql violates connector rules") ||
    text.includes("demo placeholder")
  );
};

const stripTrailingSemicolon = (sql: string) => String(sql || "").trim().replace(/;+\s*$/, "");

const removeOuterPagingAndSort = (sql: string) => {
  let cleaned = stripTrailingSemicolon(sql);
  cleaned = cleaned.replace(/\bLIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, "").trim();
  cleaned = cleaned.replace(/\bOFFSET\s+\d+\s+ROWS\s+FETCH\s+NEXT\s+\d+\s+ROWS\s+ONLY\s*$/i, "").trim();
  cleaned = cleaned.replace(/\bORDER\s+BY\s+[\s\S]*$/i, "").trim();
  return cleaned;
};

const buildCountSql = (sql: string, isMssql: boolean) => {
  const base = removeOuterPagingAndSort(sql);
  if (!base) return null;
  if (isMssql) {
    return `SELECT CAST(COUNT(*) AS BIGINT) AS __total_rows FROM (${base}) AS __q;`;
  }
  return `SELECT COUNT(*)::bigint AS __total_rows FROM (${base}) AS __q;`;
};

const buildCountSqlFallback = (sql: string, isMssql: boolean) => {
  if (isMssql) return null;
  const base = stripTrailingSemicolon(sql).replace(/\bLIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, "").trim();
  if (!base) return null;
  return `SELECT COUNT(*)::bigint AS __total_rows FROM (${base}) AS __q;`;
};

const isRuntimeValuePresent = (value: any): boolean => {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value === "object") {
    if ("value" in value) return isRuntimeValuePresent((value as any).value);
    if ("from" in value || "to" in value) {
      return isRuntimeValuePresent((value as any).from) || isRuntimeValuePresent((value as any).to);
    }
    return Object.keys(value).length > 0;
  }
  return true;
};

const flattenRuntimeParams = (params?: Record<string, any>) => {
  const flat: Record<string, any> = {};
  Object.entries(params || {}).forEach(([key, raw]) => {
    if (!key) return;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if ("value" in raw) {
        flat[key] = (raw as any).value;
      } else if ("from" in raw || "to" in raw) {
        flat[key] = raw;
        flat[`${key}.from`] = (raw as any).from ?? null;
        flat[`${key}.to`] = (raw as any).to ?? null;
      } else {
        flat[key] = raw;
      }
      return;
    }
    flat[key] = raw;
  });
  return flat;
};

const sqlLiteralFromValue = (value: any, isMssql: boolean): string => {
  if (value === null || value === undefined) return "NULL";
  if (Array.isArray(value)) {
    if (value.length === 0) return "NULL";
    return value.map((v) => sqlLiteralFromValue(v, isMssql)).join(", ");
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "boolean") {
    return isMssql ? (value ? "1" : "0") : value ? "TRUE" : "FALSE";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "NULL";
    return `'${trimmed.replace(/'/g, "''")}'`;
  }
  if (value instanceof Date) {
    return `'${value.toISOString().replace(/'/g, "''")}'`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
};

const defaultRuntimeValueForKey = (key: string) => {
  const lower = String(key || "").toLowerCase();
  const last = lower.split(":").pop() || lower;
  if (last === "offset") return 0;
  if (last === "page" || last === "storepage") return 0;
  if (last === "size" || last === "pagesize" || last === "page_size" || last === "rowsonpage" || last === "storesize") {
    return 10;
  }
  return null;
};

export const renderDynamicSqlTemplate = (sql: string, params: Record<string, any>, isMssql: boolean) => {
  const source = String(sql || "");
  if (!source.includes("{{")) return source;
  const flat = flattenRuntimeParams(params);
  let rendered = source.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey) => {
    const key = String(rawKey || "").trim();
    if (!key) return "NULL";
    if (key.startsWith("__has.")) {
      const targetKey = key.slice("__has.".length);
      const present = isRuntimeValuePresent(flat[targetKey]);
      return present ? "1" : "0";
    }
    const value = Object.prototype.hasOwnProperty.call(flat, key) ? flat[key] : defaultRuntimeValueForKey(key);
    return sqlLiteralFromValue(value, isMssql);
  });
  rendered = rendered.replace(/\(\s*0\s*=\s*0\s+OR\s+\(([\s\S]*?)\)\s*\)/gi, "1=1");
  rendered = rendered.replace(/\(\s*0\s*=\s*0\s+OR\s+([^()]+?)\s*\)/gi, "1=1");
  rendered = rendered.replace(/\(\s*1\s*=\s*0\s+OR\s+\(([\s\S]*?)\)\s*\)/gi, "($1)");
  rendered = rendered.replace(/\(\s*1\s*=\s*0\s+OR\s+([^()]+?)\s*\)/gi, "($1)");
  return rendered;
};

export const applyRuntimePaginationToSql = (
  sql: string,
  page: number,
  pageSize: number,
  offset: number | undefined,
  isMssql: boolean
) => {
  const safePage = Number.isFinite(page) && page >= 0 ? page : 0;
  const safePageSize = Math.min(100, Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 10);
  const safeOffset = Number.isFinite(offset as number) && (offset as number) >= 0 ? Math.floor(offset as number) : safePage * safePageSize;
  let cleaned = stripTrailingSemicolon(sql);
  const hasOrderBy = /\border\s+by\b/i.test(cleaned);
  const orderByFallback = hasOrderBy ? "" : " ORDER BY 1";

  if (isMssql) {
    cleaned = cleaned.replace(/^(\s*select\s+)top\s+\d+\s+/i, "$1");
    cleaned = cleaned.replace(/\bLIMIT\s+[^\s;]+(\s+OFFSET\s+[^\s;]+)?\s*$/i, "").trim();
    cleaned = cleaned.replace(/\bOFFSET\s+[^\s;]+\s+ROWS\s+FETCH\s+NEXT\s+[^\s;]+\s+ROWS\s+ONLY\s*$/i, "").trim();
    return `${cleaned}${orderByFallback} OFFSET ${safeOffset} ROWS FETCH NEXT ${safePageSize} ROWS ONLY;`;
  }

  cleaned = cleaned.replace(/\bLIMIT\s+[^\s;]+(\s+OFFSET\s+[^\s;]+)?\s*$/i, "").trim();
  cleaned = cleaned.replace(/\bOFFSET\s+[^\s;]+\s*$/i, "").trim();
  return `${cleaned}${orderByFallback}\nLIMIT ${safePageSize} OFFSET ${safeOffset};`;
};

const normalizePaginationId = (value: string) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^q[_:-]+/, "")
    .replace(/^query[_:-]+/, "")
    .replace(/[^a-z0-9]+/g, "");

export const resolveTablePaginationForId = (
  queryId: string,
  sql: string,
  tablePagination?: Record<string, RuntimePagination>
) => {
  if (!tablePagination) return undefined;
  if (tablePagination[queryId]) return tablePagination[queryId];

  const directKey = Object.keys(tablePagination).find((key) => String(key).trim() === String(queryId).trim());
  if (directKey) return tablePagination[directKey];

  const normalizedQueryId = normalizePaginationId(queryId);
  if (!normalizedQueryId) return undefined;

  const exactNormalized = Object.entries(tablePagination).find(([key]) => normalizePaginationId(key) === normalizedQueryId);
  if (exactNormalized) return exactNormalized[1];

  const tokenMatch = String(sql || "").match(/\{\{\s*(?:size|offset)\s*:\s*([^}\s]+)\s*\}\}/i);
  const tokenId = tokenMatch?.[1]?.trim();
  if (tokenId && tablePagination[tokenId]) {
    return tablePagination[tokenId];
  }

  return undefined;
};

export const derivePaginationFromRuntimeParams = (
  queryId: string,
  runtimeParams?: Record<string, any>,
  strictTargetId?: string
) => {
  const params = runtimeParams || {};
  const normalizedQueryId = normalizePaginationId(strictTargetId || queryId);
  const pick = (candidates: string[]) => {
    for (const key of candidates) {
      if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
      const parsed = Number((params as any)[key]);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  };

  const findByPrefix = (prefix: "__page:" | "__pageSize:" | "__offset:") => {
    const entries = Object.entries(params);
    const exact = entries.find(
      ([key]) => key.startsWith(prefix) && normalizePaginationId(key.slice(prefix.length)) === normalizedQueryId
    );
    if (exact) {
      const parsed = Number(exact[1]);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const page =
    pick([`page:${queryId}`, `storePage:${queryId}`]) ??
    (strictTargetId ? pick([`page:${strictTargetId}`, `storePage:${strictTargetId}`]) : null) ??
    findByPrefix("__page:");

  const pageSize =
    pick([`size:${queryId}`, `pageSize:${queryId}`, `page_size:${queryId}`, `rowsOnPage:${queryId}`, `storeSize:${queryId}`]) ??
    (strictTargetId
      ? pick([
        `size:${strictTargetId}`,
        `pageSize:${strictTargetId}`,
        `page_size:${strictTargetId}`,
        `rowsOnPage:${strictTargetId}`,
        `storeSize:${strictTargetId}`,
      ])
      : null) ??
    findByPrefix("__pageSize:");

  const offset =
    pick([`offset:${queryId}`]) ??
    (strictTargetId ? pick([`offset:${strictTargetId}`]) : null) ??
    findByPrefix("__offset:");

  if (page === null && pageSize === null && offset === null) return undefined;

  const safePage = page !== null && page >= 0 ? Math.floor(page) : 0;
  const safePageSize = pageSize !== null && pageSize > 0 ? Math.min(100, Math.floor(pageSize)) : 25;
  const safeOffset = offset !== null && offset >= 0 ? Math.floor(offset) : safePage * safePageSize;
  return {
    page: safePage,
    pageSize: safePageSize,
    offset: safeOffset,
    includeTotal: true,
  };
};

export async function runQueryExecutor(
  queries: Record<string, string>,
  connectionString?: string,
  options?: {
    connectorInstructions?: string;
    connectorType?: string;
    tablePagination?: Record<string, RuntimePagination>;
    runtimeParams?: Record<string, any>;
  }
) {
  console.log("[AGENT] Executing optimized query set...");
  const results: Record<string, any> = {};

  const tasks = Object.entries(queries).map(async ([id, sql]) => {
    const start = Date.now();
    try {
      console.log(`[EXEC] Running Widget ${id}...`);
      const isMssql = detectIsMssql(connectionString, options?.connectorType);
      const tablePage = resolveTablePaginationForId(id, sql, options?.tablePagination);
      const sqlTokenMatch = String(sql || "").match(
        /\{\{\s*(?:size|offset|page|pageSize|page_size|rowsOnPage|storeSize|storePage)\s*:\s*([^}\s]+)\s*\}\}/i
      );
      const sqlTargetId = sqlTokenMatch?.[1]?.trim();
      const runtimeFromParams = tablePage
        ? derivePaginationFromRuntimeParams(id, options?.runtimeParams, sqlTargetId)
        : undefined;
      const runtimeDerivedPage = tablePage || runtimeFromParams;
      const paginationParams = runtimeDerivedPage
        ? {
          page: runtimeDerivedPage.page,
          size: runtimeDerivedPage.pageSize,
          pageSize: runtimeDerivedPage.pageSize,
          page_size: runtimeDerivedPage.pageSize,
          rowsOnPage: runtimeDerivedPage.pageSize,
          storePage: runtimeDerivedPage.page,
          storeSize: runtimeDerivedPage.pageSize,
          offset: runtimeDerivedPage.offset ?? runtimeDerivedPage.page * runtimeDerivedPage.pageSize,
          [`page:${id}`]: runtimeDerivedPage.page,
          [`size:${id}`]: runtimeDerivedPage.pageSize,
          [`pageSize:${id}`]: runtimeDerivedPage.pageSize,
          [`page_size:${id}`]: runtimeDerivedPage.pageSize,
          [`rowsOnPage:${id}`]: runtimeDerivedPage.pageSize,
          [`storePage:${id}`]: runtimeDerivedPage.page,
          [`storeSize:${id}`]: runtimeDerivedPage.pageSize,
          [`offset:${id}`]: runtimeDerivedPage.offset ?? runtimeDerivedPage.page * runtimeDerivedPage.pageSize,
        }
        : {};
      const templateParams = {
        ...(options?.runtimeParams || {}),
        ...paginationParams,
      };
      const templatedSql = renderDynamicSqlTemplate(sql, templateParams, isMssql);
      const runtimeSql =
        runtimeDerivedPage && tablePage
          ? applyRuntimePaginationToSql(
            templatedSql,
            runtimeDerivedPage.page,
            runtimeDerivedPage.pageSize,
            runtimeDerivedPage.offset,
            isMssql
          )
          : templatedSql;
      const runtimeParams = options?.runtimeParams || {};
      const runtimePaginationParams = Object.fromEntries(
        Object.entries(runtimeParams).filter(
          ([key]) =>
            key.startsWith("__page:") ||
            key.startsWith("__pageSize:") ||
            key.startsWith("__offset:") ||
            key === "page" ||
            key === "size" ||
            key === "pageSize" ||
            key === "page_size" ||
            key === "storePage" ||
            key === "storeSize" ||
            key === "rowsOnPage" ||
            key === "offset" ||
            key.startsWith("page:") ||
            key.startsWith("size:") ||
            key.startsWith("pageSize:") ||
            key.startsWith("page_size:") ||
            key.startsWith("storePage:") ||
            key.startsWith("storeSize:") ||
            key.startsWith("rowsOnPage:") ||
            key.startsWith("offset:")
        )
      );
      const paginationClauseMatch = runtimeSql.match(
        /\bLIMIT\s+\d+\s+OFFSET\s+\d+\b|\bOFFSET\s+\d+\s+ROWS\s+FETCH\s+NEXT\s+\d+\s+ROWS\s+ONLY\b/i
      );
      console.log("[PAGINATION_DEBUG][EXEC]", {
        queryId: id,
        resolvedFromTablePagination: tablePage || null,
        resolvedRuntimePage: runtimeDerivedPage || null,
        runtimePaginationParams,
        paginationClause: paginationClauseMatch?.[0] || null,
      });
      console.log("[PAGINATION_DEBUG][EXEC_SQL]", {
        queryId: id,
        sql: runtimeSql,
      });

      if (isPlaceholderSqlQuery(runtimeSql)) {
        const duration = Date.now() - start;
        results[id] = {
          error: "SQL generation produced placeholder SQL. Regenerate plan/SQL.",
          status: "error",
          sql: runtimeSql,
          executionTime: `${duration}ms`,
        };
        return;
      }

      const validation = validateSqlWithInstructions(
        runtimeSql,
        connectionString,
        options?.connectorInstructions,
        options?.connectorType
      );
      if (!validation.ok) {
        const duration = Date.now() - start;
        results[id] = {
          error: validation.error,
          status: "error",
          sql: runtimeSql,
          executionTime: `${duration}ms`,
        };
        return;
      }
      const data = await dbGateway.runQuery(runtimeSql, connectionString);
      const duration = Date.now() - start;

      if (data && (data as any).error) {
        const errValue = (data as any).error;
        const errMessage = typeof errValue === "string" ? errValue : JSON.stringify(errValue);
        results[id] = {
          error: errMessage,
          status: "error",
          sql: runtimeSql,
          executionTime: `${duration}ms`,
        };
      } else {
        const resolvedColumns =
          Array.isArray(data) && data.length > 0 ? Object.keys(data[0] || {}).filter((key) => key !== "__rowKey") : [];
        let totalRows: number | undefined;
        if (runtimeDerivedPage?.includeTotal !== false) {
          const countSql = buildCountSql(runtimeSql, isMssql);
          if (countSql) {
            try {
              const countResult = await dbGateway.runQuery(countSql, connectionString);
              if (Array.isArray(countResult) && countResult.length > 0) {
                const first = countResult[0] as Record<string, any>;
                const raw = first.__total_rows ?? first.count ?? Object.values(first)[0];
                const parsed = Number(raw);
                if (Number.isFinite(parsed) && parsed >= 0) {
                  totalRows = parsed;
                }
              }
            } catch (countErr: any) {
              const fallbackCountSql = buildCountSqlFallback(runtimeSql, isMssql);
              if (fallbackCountSql) {
                try {
                  const fallbackCountResult = await dbGateway.runQuery(fallbackCountSql, connectionString);
                  if (Array.isArray(fallbackCountResult) && fallbackCountResult.length > 0) {
                    const first = fallbackCountResult[0] as Record<string, any>;
                    const raw = first.__total_rows ?? first.count ?? Object.values(first)[0];
                    const parsed = Number(raw);
                    if (Number.isFinite(parsed) && parsed >= 0) {
                      totalRows = parsed;
                    }
                  }
                } catch (fallbackErr: any) {
                  console.warn(`[EXEC] Count query fallback failed for ${id}:`, fallbackErr?.message || fallbackErr);
                }
              } else {
                console.warn(`[EXEC] Count query failed for ${id}:`, countErr?.message || countErr);
              }
            }
          }
        }
        results[id] = {
          data: Array.isArray(data) ? data : [],
          columns: resolvedColumns,
          status: "success",
          executionTime: `${duration}ms`,
          ...(runtimeDerivedPage
            ? {
              page: runtimeDerivedPage.page,
              pageSize: runtimeDerivedPage.pageSize,
              offset: runtimeDerivedPage.offset ?? runtimeDerivedPage.page * runtimeDerivedPage.pageSize,
            }
            : {}),
          ...(typeof totalRows === "number" ? { totalRows } : {}),
        };
      }
    } catch (err: any) {
      const errMessage = typeof err?.message === "string" ? err.message : JSON.stringify(err);
      results[id] = {
        error: errMessage,
        status: "error",
        sql,
      };
    }
  });

  await Promise.all(tasks);

  const logSummary = Object.entries(results)
    .map(([id, res]) => `WIDGET ${id}: ${res.status === "success" ? "✓ Success" : "✗ Failed"} (${res.executionTime || "0ms"})`)
    .join("\n");
  console.log("EXECUTION RESULTS:\n" + logSummary);

  return results;
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
  console.log(`[SQL_REPAIR] Attempting to fix query for widget: ${context.widgetTitle}`);

  const schemaInfo = context.schema?.schemaInfo || {};
  const recentErrors = JSON.stringify((context.errorLog || []).slice(0, 15));
  const truncate = (text: string, max = 3000) => (text.length > max ? `${text.slice(0, max)}...` : text);
  const compactErrors = truncate(recentErrors || "[]", 600);
  const compactSql = truncate(context.originalSql || "", 1500);
  const compactError = truncate(context.errorMessage || "", 800);

  const extractTablesFromSql = (sql: string) => {
    const tables = new Set<string>();
    const regex = /\b(from|join)\s+["`[]?([A-Za-z0-9_.]+)["`\]]?/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(sql)) !== null) {
      const name = match[2]?.split(".").pop();
      if (name) tables.add(name);
    }
    return Array.from(tables);
  };

  const buildCompactSchema = () => {
    const tableNames = extractTablesFromSql(context.originalSql || "");
    const fallbackTables = Object.keys(schemaInfo || {}).slice(0, 2);
    const selected = tableNames.length > 0 ? tableNames : fallbackTables;
    return selected
      .map((table) => {
        const info = schemaInfo[table] || schemaInfo[table.toLowerCase()] || schemaInfo[table.toUpperCase()];
        const cols = info?.columns
          ?.slice(0, 4)
          .map((c: any) => `${c.name || c.column_name} (${c.type || c.data_type})`)
          .join(", ");
        return `TABLE "${table}" HAS COLUMNS: [${cols || "unknown"}]`;
      })
      .join("\n");
  };

  const compactSchema = truncate(buildCompactSchema(), 1200);

  const connectorType = String(context.schema?.connectorType || context.schema?.connector?.type || "").toLowerCase();
  const isMssql = (() => {
    const lower = (context.connectionString || "").toLowerCase();
    if (
      lower.startsWith("mssql://") ||
      lower.startsWith("sqlserver://") ||
      lower.includes("server=") ||
      lower.includes("data source=")
    ) {
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

${connectorInstructions ? `### CONNECTOR INSTRUCTIONS\n${truncate(connectorInstructions, 1200)}\n` : ""}

### FAILED QUERY CONTEXT
- **Widget Goal:** ${context.widgetGoal || "Display relevant data"}
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
5. **Never** claim the error is "misleading" or "already valid" - you must change the SQL to address the error.
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

${connectorInstructions ? `### CONNECTOR INSTRUCTIONS\n${truncate(connectorInstructions, 1200)}\n` : ""}

### FAILED QUERY CONTEXT
- **Widget Goal:** ${context.widgetGoal || "Display relevant data"}
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
5. **Never** claim the error is "misleading" or "already valid" - you must change the SQL to address the error.

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
        'Return JSON: {"sql":"...","explanation":"..."}',
      ].join("\n");
      const response = await invokeModelWithRetry([
        new SystemMessage(compactPrompt),
        new HumanMessage("Fix the failed SQL query in strict JSON."),
      ]);
      const content = response.content as string;
      const parsed = extractJSON(content);
      if (parsed && parsed.sql) {
        return {
          sql: parsed.sql,
          explanation: parsed.explanation || "Repaired query",
        };
      }
      throw new Error("Repair response missing SQL.");
    }
    const response = await invokeModelWithRetry([
      new SystemMessage(systemPrompt),
      new HumanMessage("Fix the failed SQL query based on the error and schema provided."),
    ]);

    const content = response.content as string;
    console.log("[SQL_REPAIR] LLM Response:", content.substring(0, 200));

    const parsed = extractJSON(content);

    if (parsed && parsed.sql) {
      console.log(`[SQL_REPAIR] Successfully generated fix: ${parsed.explanation}`);
      return {
        sql: parsed.sql,
        explanation: parsed.explanation || "Query repaired by AI",
      };
    }

    const markdownSqlMatch = content.match(/```(?:sql)?\s*([\s\S]+?)```/i);
    if (markdownSqlMatch) {
      const sql = markdownSqlMatch[1].trim();
      if (sql.toLowerCase().includes("select")) {
        return {
          sql,
          explanation: "Query extracted from markdown block",
        };
      }
    }

    const directSqlMatch = content.match(/(?:SELECT|WITH)[\s\S]+?(?:;|$)/i);
    if (directSqlMatch) {
      return {
        sql: directSqlMatch[0].trim(),
        explanation: "Query extracted via text matching",
      };
    }

    throw new Error("Could not extract repaired SQL from LLM response");
  } catch (err: any) {
    console.error("[SQL_REPAIR] Failed to repair query:", err.message);
    throw new Error(`SQL repair failed: ${err.message}`);
  }
}

function buildFiltersFromCandidates(filterCandidates: any): any[] {
  if (!filterCandidates) return [];
  const filters: any[] = [];
  const humanize = (value: string) =>
    value
      .replace(/[_\.]+/g, " ")
      .replace(/\b\w/g, (m) => m.toUpperCase());

  const primaryDate = filterCandidates.primaryDate;
  if (primaryDate) {
    filters.push({
      id: `${primaryDate.table}.${primaryDate.column}`,
      dimension: `${primaryDate.table}.${primaryDate.column}`,
      label: humanize(`${primaryDate.table}.${primaryDate.column}`),
      type: "date-range",
      value: "this_month",
      options: [
        { label: "Today", value: "today" },
        { label: "This Week", value: "this_week" },
        { label: "This Month", value: "this_month" },
        { label: "This Year", value: "this_year" },
        { label: "Custom", value: "custom" },
      ],
    });
  }

  if (filterCandidates.primarySearch?.table && filterCandidates.primarySearch?.column) {
    filters.push({
      id: `${filterCandidates.primarySearch.table}.${filterCandidates.primarySearch.column}__search`,
      dimension: `${filterCandidates.primarySearch.table}.${filterCandidates.primarySearch.column}`,
      label: humanize(`${filterCandidates.primarySearch.table}.${filterCandidates.primarySearch.column}`),
      type: "search",
      value: "",
    });
  }

  (filterCandidates.categoricalColumns || []).slice(0, 4).forEach((col: any) => {
    const options = (col.distinct || [])
      .filter((v: any) => v !== null && v !== undefined && String(v).trim() !== "")
      .slice(0, 100)
      .map((v: any) => ({ label: String(v), value: v }));
    if (options.length === 0) return;
    filters.push({
      id: `${col.table}.${col.column}`,
      dimension: `${col.table}.${col.column}`,
      label: humanize(`${col.table}.${col.column}`),
      type: options.length > 12 ? "select" : "multi-select",
      value: options.length > 12 ? null : [],
      options,
    });
  });

  return normalizeFilterSet(filters);
}

export async function assembleFinalDashboard(
  plan: any,
  queries: any[],
  results: any[],
  insights: string[] = [],
  filterCandidates?: any
) {
  console.log("[AGENT] Assembling Final Dashboard with Smart Layout...");

  const widgetsWithResults = plan.widgets.map((w: any) => {
    const q = queries.find(
      (query: any) =>
        query.id === w.id ||
        query.id === w.queryId ||
        query.widgetIds?.includes?.(w.id) ||
        (w.title && query.title && query.title.toLowerCase() === w.title.toLowerCase())
    );
    const res = results.find(
      (r: any) =>
        r.id === w.id ||
        r.id === w.queryId ||
        (q ? r.id === q.id : false) ||
        (w.title && r.title && r.title.toLowerCase() === w.title.toLowerCase())
    );

    const dataRows = Array.isArray(res?.data) ? res.data : [];
    const resultColumns = Array.isArray(res?.columns) ? res.columns : [];
    const rowDerivedColumns = dataRows.length > 0 ? Object.keys(dataRows[0] || {}).filter((key) => key !== "__rowKey") : [];
    const resolvedColumnFields = (resultColumns.length > 0 ? resultColumns : rowDerivedColumns).filter(
      (field: any) => typeof field === "string" && field !== "__rowKey"
    );

    const existingTableColumns = Array.isArray(w?.tableConfig?.columns) ? w.tableConfig.columns : [];
    const existingByField = new Map<string, any>();
    existingTableColumns.forEach((col: any) => {
      const field = String(col?.field || "").trim();
      if (!field) return;
      existingByField.set(field, col);
    });
    const mergedFields = [
      ...existingTableColumns.map((col: any) => String(col?.field || "").trim()).filter(Boolean),
      ...resolvedColumnFields.filter((field: string) => !existingByField.has(field)),
    ];
    const mergedTableColumns = mergedFields.map((field: string) => {
      const existing = existingByField.get(field);
      if (existing) return existing;
      return {
        field,
        header: field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " "),
      };
    });

    return {
      ...w,
      id: w.id,
      title: w.title,
      type: w.type,
      goal: w.goal,
      data: dataRows,
      sql: q?.sql,
      ...(w?.type === "table" && mergedTableColumns.length > 0
        ? { tableConfig: { ...(w.tableConfig || {}), columns: mergedTableColumns } }
        : {}),
      __resultStatus: res?.status,
      __hasData: dataRows.length > 0,
    };
  });

  const widgets = widgetsWithResults.map((w: any) => {
    const { __resultStatus: _status, __hasData: _hasData, ...rest } = w;
    return { ...rest };
  });

  const kpis = widgets.filter((w: any) => w.type === "kpi");
  const tables = widgets.filter((w: any) => w.type === "table");
  const markdown = widgets.filter((w: any) => w.type === "markdown");
  const charts = widgets.filter((w: any) => !["kpi", "table", "markdown"].includes(w.type));
  const primaryChartIdx = charts.findIndex((w: any) => ["line", "area"].includes(w.type)) >= 0
    ? charts.findIndex((w: any) => ["line", "area"].includes(w.type))
    : 0;
  if (charts.length > 1 && primaryChartIdx > 0) {
    const [primary] = charts.splice(primaryChartIdx, 1);
    charts.unshift(primary);
  }

  let y = 0;
  let x = 0;
  const place = (w: any, pos: { x: number; y: number; w: number; h: number }) => {
    w.position = pos;
  };

  kpis.forEach((w: any, idx: number) => {
    x = (idx % 4) * 3;
    y = Math.floor(idx / 4) * 2;
    place(w, { x, y, w: 3, h: 2 });
  });
  const kpiRows = Math.ceil(kpis.length / 4);
  y = kpiRows * 2;

  markdown.forEach((w: any) => {
    place(w, { x: 0, y, w: 12, h: 3 });
    y += 3;
  });

  if (charts.length > 0) {
    const primary = charts.shift();
    if (primary) {
      place(primary, { x: 0, y, w: 12, h: 4 });
      y += 4;
    }
  }

  let chartCol = 0;
  charts.forEach((w: any) => {
    const width = ["map", "cohort", "funnel"].includes(w.type) ? 12 : 6;
    if (width === 12) {
      place(w, { x: 0, y, w: 12, h: 4 });
      y += 4;
      chartCol = 0;
      return;
    }
    place(w, { x: chartCol * 6, y, w: 6, h: 4 });
    chartCol = (chartCol + 1) % 2;
    if (chartCol === 0) {
      y += 4;
    }
  });
  if (chartCol !== 0) {
    y += 4;
  }

  tables.forEach((w: any) => {
    place(w, { x: 0, y, w: 12, h: 6 });
    y += 6;
  });

  return {
    id: `dash_${Date.now()}`,
    name: plan.title || "AI Insights Dashboard",
    widgets,
    layout: widgets.map((w: any) => ({ i: w.id, ...w.position })),
    filters: normalizeFilterSet(plan.filters || buildFiltersFromCandidates(filterCandidates)),
    updatedAt: new Date().toISOString(),
  };
}

export async function runNarrativeGenerator(resultsList: any[]) {
  console.log("[AGENT] Analyzing data trends...");
  const prompt = `Role: Senior Strategic Executive Analyst.
    RESULTS: ${JSON.stringify(resultsList.map((r) => ({ title: r.title, sample: r.data?.slice(0, 3) })))}

    TASK: Provide 3-4 professional, one-sentence bulleted insights based on this data.
    Return JSON: { "insights": ["..."] }`;

  const response = await invokeModelWithRetry([new SystemMessage(prompt)]);
  const data = extractJSON(response.content as string);
  return data?.insights || ["Data retrieval successful. Full analysis ready."];
}

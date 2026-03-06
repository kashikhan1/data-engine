/* eslint-disable @typescript-eslint/no-explicit-any */
// query-runtime.ts — SQL execution & dashboard assembly runtime.
// Handles dynamic DB row shapes, runtime SQL templates, and filter candidates
// from multiple DB systems. `any` is intentional for these runtime data flows.
import { dbGateway } from "../mcp/server";
import { normalizeFilterSet } from "../filter-contract";

type RuntimePagination = {
  page: number;
  pageSize: number;
  offset?: number;
  includeTotal?: boolean;
};

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

const extractTablesFromSql = (sql: string) => {
  const tables = new Set<string>();
  const regex = /\b(from|join)\s+["`[]?([A-Za-z0-9_.]+)["`\]]?/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(sql)) !== null) {
    const raw = String(match[2] || "").trim();
    if (!raw) continue;
    const base = raw.split(".").pop();
    if (base) tables.add(base);
  }
  return Array.from(tables);
};

function levenshtein(a: string, b: string): number {
  const left = String(a || "");
  const right = String(b || "");
  if (!left) return right.length;
  if (!right) return left.length;
  const dp = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const temp = dp[j];
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost
      );
      prev = temp;
    }
  }
  return dp[right.length];
}

function chooseClosestName(target: string, candidates: string[]): string | null {
  const t = String(target || "").trim().toLowerCase();
  const list = Array.from(new Set((candidates || []).map((c) => String(c || "").trim()).filter(Boolean)));
  if (!t || list.length === 0) return null;
  if (list.includes(target)) return target;

  let best: { value: string; score: number } | null = null;
  for (const candidate of list) {
    const c = candidate.toLowerCase();
    const dist = levenshtein(t, c);
    const maxLen = Math.max(t.length, c.length) || 1;
    let score = 1 - dist / maxLen;
    if (c.includes(t) || t.includes(c)) score += 0.12;
    if (c.replace(/_/g, "") === t.replace(/_/g, "")) score += 0.15;
    if (!best || score > best.score) best = { value: candidate, score };
  }
  return best && best.score >= 0.55 ? best.value : null;
}

function parseMissingIdentifier(errorMessage: string): { kind: "column" | "table"; name: string } | null {
  const msg = String(errorMessage || "");
  const patterns: Array<{ kind: "column" | "table"; regex: RegExp }> = [
    { kind: "column", regex: /column ["`[]?([a-zA-Z0-9_]+)["`\]]? does not exist/i },
    { kind: "column", regex: /invalid column name ['"`[]?([a-zA-Z0-9_]+)['"`\]]?/i },
    { kind: "table", regex: /relation ["`[]?([a-zA-Z0-9_.]+)["`\]]? does not exist/i },
    { kind: "table", regex: /invalid object name ['"`[]?([a-zA-Z0-9_.]+)['"`\]]?/i },
  ];
  for (const p of patterns) {
    const match = msg.match(p.regex);
    if (match?.[1]) {
      return { kind: p.kind, name: String(match[1]).split(".").pop() || String(match[1]) };
    }
  }
  return null;
}

function replaceIdentifier(sql: string, from: string, to: string): string {
  if (!from || !to || from === to) return sql;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactWord = new RegExp(`\\b${escaped}\\b`, "gi");
  let next = String(sql || "").replace(exactWord, to);
  next = next.replace(new RegExp(`"${escaped}"`, "gi"), `"${to}"`);
  next = next.replace(new RegExp(`\\[${escaped}\\]`, "gi"), `[${to}]`);
  next = next.replace(new RegExp(`\`${escaped}\``, "gi"), `\`${to}\``);
  return next;
}

export const resolveConnectorDialect = (input?: {
  connectionString?: string;
  connectorType?: string;
}) => {
  const connectionString = String(input?.connectionString || "").trim();
  const connectorTypeRaw = String(input?.connectorType || "").trim().toLowerCase();
  const isMssql = detectIsMssql(connectionString, connectorTypeRaw);
  return {
    connectionString,
    connectorType: connectorTypeRaw || (isMssql ? "mssql" : "postgres"),
    isMssql,
    dialect: isMssql ? "mssql" as const : "postgres" as const,
  };
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

/** Sanitize a raw value to a safe SQL identifier (column name or sort direction). */
const sanitizeSqlIdentifier = (value: unknown, fallback: string): string => {
  const raw = String(value ?? "").trim();
  // Allow alphanumeric, underscore, dot, and quoting chars — strip everything else
  const safe = raw.replace(/[^a-zA-Z0-9_."'`[\] ]/g, "");
  return safe || fallback;
};

export const renderDynamicSqlTemplate = (sql: string, params: Record<string, any>, isMssql: boolean) => {
  const source = String(sql || "");
  if (!source.includes("{{")) return source;
  const flat = flattenRuntimeParams(params);
  let rendered = source.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey) => {
    const key = String(rawKey || "").trim();
    if (!key) return "NULL";

    // ── __has.key — presence check ────────────────────────────────────────────
    if (key.startsWith("__has.")) {
      const targetKey = key.slice("__has.".length);
      const present = isRuntimeValuePresent(flat[targetKey]);
      return present ? "1" : "0";
    }

    // ── key:default — parse optional colon-separated default value ─────────────
    const colonIdx = key.indexOf(":");
    const paramKey = colonIdx >= 0 ? key.slice(0, colonIdx) : key;
    const defaultRaw = colonIdx >= 0 ? key.slice(colonIdx + 1) : null;

    // ── sort_col — safe SQL column identifier (not a quoted string literal) ────
    if (paramKey === "sort_col") {
      const val = Object.prototype.hasOwnProperty.call(flat, "sort_col") ? flat["sort_col"] : null;
      return sanitizeSqlIdentifier(val, defaultRaw ?? "1");
    }

    // ── sort_dir — only ASC or DESC ───────────────────────────────────────────
    if (paramKey === "sort_dir") {
      const val = Object.prototype.hasOwnProperty.call(flat, "sort_dir") ? flat["sort_dir"] : null;
      const dir = String(val ?? defaultRaw ?? "ASC").toUpperCase();
      return dir === "DESC" ? "DESC" : "ASC";
    }

    // ── Normal value — look up by paramKey, fall back to :default then heuristic
    const value = Object.prototype.hasOwnProperty.call(flat, paramKey)
      ? flat[paramKey]
      : (defaultRaw !== null ? defaultRaw : defaultRuntimeValueForKey(paramKey));
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
    /** Map of widgetId -> widgetType. Used to skip count queries for non-table widgets. */
    widgetTypes?: Record<string, string>;
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
        const widgetType = String(options?.widgetTypes?.[id] || "").toLowerCase();
        const isTableWidget = widgetType === "table" || (!widgetType && runtimeDerivedPage?.includeTotal !== false);
        if (isTableWidget && runtimeDerivedPage?.includeTotal !== false) {
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

/**
 * AI-powered SQL repair using the LLM with full MCP-fetched schema context.
 * Called as a fallback when heuristic repair doesn't produce valid SQL.
 */
async function aiRepairSql(params: {
  widgetTitle: string;
  widgetType: string;
  widgetGoal?: string;
  widgetUses?: string;
  widgetNotes?: string;
  primaryTable?: string;
  allowedFilterColumns: Set<string>;
  originalSql: string;
  errorMessage: string;
  columnsByTable: Map<string, string[]>;
  allKnownTables: string[];
  isMssql: boolean;
  connectorInstructions?: string;
  connectionString?: string;
}): Promise<{ sql: string; explanation: string } | null> {
  try {
    const { streamModelWithRetry } = await import("@/lib/agents/llm-utils");
    const { createDefaultChatModel } = await import("@/lib/llm/model");
    const { SystemMessage, HumanMessage } = await import("@langchain/core/messages");

    const dialect = params.isMssql ? "MSSQL (SQL Server)" : "PostgreSQL";
    const dialectRules = params.isMssql
      ? "Use TOP N (not LIMIT). Pagination: OFFSET N ROWS FETCH NEXT N ROWS ONLY. GETDATE() not CURRENT_DATE. LIKE not ILIKE. No DATE_TRUNC. Use ISNULL(). Identifiers with [brackets]. Boolean/bit columns in COALESCE: use CAST(col AS INT) e.g. COALESCE(CAST(active AS INT), 0)."
      : "Use LIMIT N OFFSET N. CURRENT_DATE not GETDATE(). ILIKE for case-insensitive. DATE_TRUNC() for date bucketing. No TOP. COALESCE() not ISNULL(). Identifiers with \"quotes\". Boolean columns in COALESCE with numbers: cast with ::int e.g. COALESCE(active::int, 0).";

    // Build schema lines from MCP-enriched columnsByTable
    const schemaLines: string[] = [];
    params.columnsByTable.forEach((cols, table) => {
      if (cols.length > 0) schemaLines.push(`  ${table}: ${cols.join(", ")}`);
    });
    if (schemaLines.length === 0) {
      params.allKnownTables.forEach((t) => schemaLines.push(`  ${t}: (columns unknown — use SELECT *)`));
    }

    const filterSection = params.allowedFilterColumns.size > 0
      ? `\n\nALLOWED FILTER COLUMNS (only these may appear in WHERE / HAVING / JOIN ON):\n  ${Array.from(params.allowedFilterColumns).join(", ")}`
      : "";

    const instructionSection = params.connectorInstructions?.trim()
      ? `\n\nCONNECTOR INSTRUCTIONS:\n${params.connectorInstructions.slice(0, 400)}`
      : "";

    const widgetLines = [
      `Widget: ${params.widgetTitle} (type: ${params.widgetType})`,
      params.widgetGoal ? `Goal: ${params.widgetGoal}` : null,
      params.widgetUses ? `Column refs: ${params.widgetUses}` : null,
      params.widgetNotes ? `Hints: ${params.widgetNotes.slice(0, 250)}` : null,
      params.primaryTable ? `Primary table: ${params.primaryTable}` : null,
    ].filter(Boolean).join("\n");

    const system = `You are a SQL repair expert. Fix the broken ${dialect} query so it executes without errors.

DIALECT: ${dialect}
RULES: ${dialectRules}${filterSection}${instructionSection}

Respond with ONLY a valid JSON object — no markdown, no extra text:
{"sql": "<corrected single SELECT statement>", "explanation": "<brief description of what was wrong and what you fixed>"}`;

    const human = `WIDGET CONTEXT:
${widgetLines}

AVAILABLE TABLES AND COLUMNS (from live DB schema via MCP):
${schemaLines.join("\n")}

BROKEN SQL:
\`\`\`sql
${params.originalSql}
\`\`\`

EXECUTION ERROR:
${params.errorMessage}

Fix the SQL. Return only the JSON object.`;

    const response = await streamModelWithRetry(
      () => createDefaultChatModel({ logPrefix: "[SQL_REPAIR_AI]", timeoutMs: 60000 }),
      [new SystemMessage(system), new HumanMessage(human)],
      undefined,
      2,
      1000
    );

    const content = String((response as any)?.content || "");
    if (!content) return null;

    // Try JSON parse first
    let repairedSql: string | null = null;
    let explanation = "AI-repaired SQL.";
    try {
      const jsonMatch = content.match(/\{[\s\S]*?\}/);
      if (jsonMatch) {
        const cleaned = jsonMatch[0].replace(/"([^"]*)"/g, (_m: string, g: string) =>
          `"${g.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`
        );
        const parsed = JSON.parse(cleaned) as { sql?: string; explanation?: string };
        if (parsed?.sql) {
          repairedSql = String(parsed.sql).trim();
          explanation = String(parsed.explanation || explanation);
        }
      }
    } catch {
      // fallback: extract SQL from code block
      const sqlBlock = content.match(/```sql\s*([\s\S]*?)```/i) || content.match(/```\s*(SELECT[\s\S]*?)```/i);
      if (sqlBlock?.[1]) repairedSql = sqlBlock[1].trim();
    }

    if (!repairedSql) return null;
    console.log(`[SQL_REPAIR_AI] AI produced repaired SQL for "${params.widgetTitle}": ${repairedSql.slice(0, 120)}...`);
    return { sql: repairedSql, explanation };
  } catch (err: any) {
    console.warn("[SQL_REPAIR_AI] AI repair call failed:", err?.message || err);
    return null;
  }
}

export async function repairFailedQuery(context: {
  widgetId: string;
  widgetTitle: string;
  widgetType: string;
  widgetGoal?: string;
  widgetUses?: string;
  widgetNotes?: string;
  primaryTable?: string;
  filterableColumns?: Record<string, string[]>;
  originalSql: string;
  errorMessage: string;
  schema: any;
  errorLog?: Array<{ id: string; title?: string; sql?: string; error: string; timestamp?: string }>;
  connectionString?: string;
}): Promise<{ sql: string; explanation: string }> {
  console.log(`[SQL_REPAIR] Attempting to fix query for widget: ${context.widgetTitle}`);

  const truncate = (text: string, max = 3000) => (text.length > max ? `${text.slice(0, max)}...` : text);
  const compactSql = truncate(context.originalSql || "", 1500);
  const compactError = truncate(context.errorMessage || "", 800);

  const normalizedOriginal = normalizeSqlForValidation(compactSql);
  const schemaInfoMap = context.schema?.schemaInfo || {};
  const isMssql = detectIsMssql(context.connectionString, String(context.schema?.connectorType || context.schema?.connector?.type || ""));

  const referencedTables = extractTablesFromSql(normalizedOriginal || context.originalSql || "");
  const selectedTables = referencedTables.length > 0 ? referencedTables : Object.keys(schemaInfoMap).slice(0, 3);

  const columnsByTable = new Map<string, string[]>();
  const putColumns = (tableName: string, rawColumns: any[]) => {
    const key = String(tableName || "").split(".").pop()?.toLowerCase() || "";
    if (!key) return;
    const cols = Array.isArray(rawColumns)
      ? rawColumns.map((c: any) => String(c?.name || c?.column_name || "").trim()).filter(Boolean)
      : [];
    if (cols.length === 0) return;
    columnsByTable.set(key, Array.from(new Set(cols)));
  };

  Object.entries(schemaInfoMap || {}).forEach(([table, info]: [string, any]) => {
    putColumns(table, info?.columns || []);
  });

  if (context.connectionString) {
    await Promise.all(selectedTables.map(async (table) => {
      try {
        const snapshot = await dbGateway.getTableSchema(table, context.connectionString);
        putColumns(table, (snapshot as any)?.columns || []);
      } catch {
        // best effort MCP pull
      }
      try {
        const preview = await dbGateway.getTablePreview(table, context.connectionString);
        const first = Array.isArray(preview) ? preview[0] : Array.isArray((preview as any)?.data) ? (preview as any).data[0] : null;
        if (first && typeof first === "object") {
          const inferred = Object.keys(first).map((k) => String(k).trim()).filter(Boolean);
          if (inferred.length > 0) {
            const key = table.toLowerCase();
            const existing = columnsByTable.get(key) || [];
            columnsByTable.set(key, Array.from(new Set([...existing, ...inferred])));
          }
        }
      } catch {
        // best effort MCP pull
      }
    }));
  }

  const allKnownTables = Array.from(new Set([
    ...Object.keys(schemaInfoMap || {}),
    ...Array.from(columnsByTable.keys()),
  ].map((t) => String(t).split(".").pop() || "").filter(Boolean)));
  const allKnownColumns = Array.from(new Set(Array.from(columnsByTable.values()).flat()));

  // Build allowed filter column set from filterableColumns (user-enabled via schema configuration)
  const filterableColumns: Record<string, string[]> = context.filterableColumns || {};
  const allowedFilterColumns = new Set<string>();
  Object.entries(filterableColumns).forEach(([, cols]) => {
    (cols || []).forEach((col) => allowedFilterColumns.add(col.toLowerCase()));
  });

  let repairedSql = normalizedOriginal || "";
  const appliedRepairs: string[] = [];
  const missing = parseMissingIdentifier(compactError);

  if (repairedSql && missing) {
    if (missing.kind === "column") {
      const tableScopedColumns = referencedTables
        .map((table) => columnsByTable.get(String(table).toLowerCase()) || [])
        .flat();
      const searchPool = tableScopedColumns.length > 0 ? tableScopedColumns : allKnownColumns;
      const replacement = chooseClosestName(missing.name, searchPool);
      if (replacement && replacement !== missing.name) {
        repairedSql = replaceIdentifier(repairedSql, missing.name, replacement);
        appliedRepairs.push(`column ${missing.name} -> ${replacement}`);
      }
    } else if (missing.kind === "table") {
      const replacement = chooseClosestName(missing.name, allKnownTables);
      if (replacement && replacement !== missing.name) {
        repairedSql = replaceIdentifier(repairedSql, missing.name, replacement);
        appliedRepairs.push(`table ${missing.name} -> ${replacement}`);
      }
    }
  }

  // Log repair context for debugging (uses, notes, primaryTable from widget metadata)
  if (context.widgetUses || context.widgetNotes || context.primaryTable) {
    console.log(`[SQL_REPAIR] Widget context — uses: ${context.widgetUses || "n/a"}, primaryTable: ${context.primaryTable || "n/a"}, notes: ${(context.widgetNotes || "").slice(0, 80)}`);
  }

  if (repairedSql && !isMssql && /\bTOP\s+\d+\b/i.test(repairedSql)) {
    repairedSql = repairedSql.replace(/\bSELECT\s+TOP\s+(\d+)/i, "SELECT");
    appliedRepairs.push("removed TOP for PostgreSQL");
  }
  if (repairedSql && isMssql && /\bLIMIT\s+\d+/i.test(repairedSql)) {
    repairedSql = repairedSql.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?/gi, "");
    if (!/\bSELECT\s+TOP\s+\d+/i.test(repairedSql)) {
      repairedSql = repairedSql.replace(/\bSELECT\b/i, "SELECT TOP 100");
    }
    appliedRepairs.push("converted LIMIT to TOP for MSSQL");
  }

  // ── COALESCE type mismatch (boolean vs integer) — cast boolean col to int ─────
  // PostgreSQL: "COALESCE types boolean and integer cannot be matched"
  if (repairedSql && !isMssql && /coalesce types.*cannot be matched/i.test(compactError)) {
    const before = repairedSql;
    // Replace COALESCE(<identifier>, <number>) → COALESCE(<identifier>::int, <number>)
    // Handles SUM(COALESCE(...)) and other wrapping expressions
    repairedSql = repairedSql.replace(
      /\bCOALESCE\s*\(\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*,\s*(\d+(?:\.\d+)?)\s*\)/gi,
      (_match, col: string, num: string) => {
        // Skip if already cast
        if (/::/.test(col)) return `COALESCE(${col}, ${num})`;
        return `COALESCE(${col}::int, ${num})`;
      }
    );
    if (repairedSql !== before) {
      appliedRepairs.push("cast boolean column to int in COALESCE (boolean/integer type mismatch)");
    }
  }

  // ── General COALESCE/aggregate type mismatch — replace COALESCE(bool_col, N) ─
  // For MSSQL: COALESCE(bool_col, 0) → COALESCE(CAST(bool_col AS INT), 0)
  if (repairedSql && isMssql && /coalesce.*type.*mismatch|operand type clash/i.test(compactError)) {
    const before = repairedSql;
    repairedSql = repairedSql.replace(
      /\bCOALESCE\s*\(\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*,\s*(\d+(?:\.\d+)?)\s*\)/gi,
      (_match, col: string, num: string) => {
        if (/CAST\s*\(/i.test(col)) return `COALESCE(${col}, ${num})`;
        return `COALESCE(CAST(${col} AS INT), ${num})`;
      }
    );
    if (repairedSql !== before) {
      appliedRepairs.push("cast boolean column to int in COALESCE for MSSQL (type mismatch)");
    }
  }

  if (repairedSql) {
    const validation = validateSqlWithInstructions(
      repairedSql,
      context.connectionString,
      String(context.schema?.connectorInstructions || context.schema?.connector?.instructions || ""),
      String(context.schema?.connectorType || context.schema?.connector?.type || "")
    );
    if (validation.ok && context.connectionString) {
      try {
        if (isMssql) {
          await dbGateway.runQuery(`SELECT TOP 1 * FROM (${stripTrailingSemicolon(repairedSql)}) AS __probe`, context.connectionString);
        } else {
          await dbGateway.runQuery(`EXPLAIN ${stripTrailingSemicolon(repairedSql)}`, context.connectionString);
        }
      } catch {
        // keep repaired SQL as best effort; executor will perform final run.
      }
    }
    const filterNote = allowedFilterColumns.size > 0
      ? ` Allowed filter columns: ${Array.from(allowedFilterColumns).join(", ")}.`
      : "";
    if (validation.ok || appliedRepairs.length > 0) {
      return {
        sql: repairedSql,
        explanation: appliedRepairs.length > 0
          ? `Repaired using MCP schema context (${selectedTables.join(", ") || "schema"}): ${appliedRepairs.join("; ")}.${filterNote}`
          : `Validated and normalized SQL using MCP-aware repair path. Error summary: ${compactError.slice(0, 140)}${filterNote}`,
      };
    }
  }

  // ── AI-powered repair fallback ───────────────────────────────────────────────
  // Heuristic repair couldn't fix the SQL — ask the LLM with full MCP schema context.
  console.log(`[SQL_REPAIR] Heuristic repair insufficient — escalating to AI repair for "${context.widgetTitle}"`);
  const aiResult = await aiRepairSql({
    widgetTitle: context.widgetTitle,
    widgetType: context.widgetType,
    widgetGoal: context.widgetGoal,
    widgetUses: context.widgetUses,
    widgetNotes: context.widgetNotes,
    primaryTable: context.primaryTable,
    allowedFilterColumns,
    originalSql: compactSql,
    errorMessage: compactError,
    columnsByTable,
    allKnownTables,
    isMssql,
    connectorInstructions: String(context.schema?.connectorInstructions || context.schema?.connector?.instructions || ""),
    connectionString: context.connectionString,
  });

  if (aiResult) {
    // Validate and optionally probe the AI-produced SQL
    const aiValidation = validateSqlWithInstructions(
      aiResult.sql,
      context.connectionString,
      String(context.schema?.connectorInstructions || context.schema?.connector?.instructions || ""),
      String(context.schema?.connectorType || context.schema?.connector?.type || "")
    );
    if (aiValidation.ok) {
      if (context.connectionString) {
        try {
          if (isMssql) {
            await dbGateway.runQuery(`SELECT TOP 1 * FROM (${stripTrailingSemicolon(aiResult.sql)}) AS __ai_probe`, context.connectionString);
          } else {
            await dbGateway.runQuery(`EXPLAIN ${stripTrailingSemicolon(aiResult.sql)}`, context.connectionString);
          }
          console.log(`[SQL_REPAIR_AI] AI-repaired SQL probed successfully for "${context.widgetTitle}"`);
        } catch (probeErr: any) {
          console.warn(`[SQL_REPAIR_AI] AI-repaired SQL probe failed for "${context.widgetTitle}":`, probeErr?.message || probeErr);
          // Keep the AI SQL anyway — executor will make the final call
        }
      }
      return { sql: aiResult.sql, explanation: `AI repair: ${aiResult.explanation}` };
    }
    // AI produced SQL but it failed our validator — return it with a warning note
    console.warn(`[SQL_REPAIR_AI] AI-produced SQL failed validation for "${context.widgetTitle}": ${aiValidation.error}`);
    return { sql: aiResult.sql, explanation: `AI repair (validation warning: ${aiValidation.error}): ${aiResult.explanation}` };
  }

  // Prefer widget's primaryTable as the fallback table when heuristics fail
  const firstTable = context.primaryTable || selectedTables[0] || Object.keys(schemaInfoMap)[0] || "unknown_table";
  const escapedTable = firstTable.replace(/]/g, "]]");
  const fallbackSql = isMssql
    ? `SELECT TOP 10 * FROM [${escapedTable}];`
    : `SELECT * FROM "${firstTable.replace(/"/g, '""')}" LIMIT 10;`;

  return {
    sql: fallbackSql,
    explanation: `MCP repair fallback: generated safe probe SQL on "${firstTable}". Error summary: ${compactError.slice(0, 140)}.`
  };
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
  _insights: string[] = [],
  filterCandidates?: any,
  schemaContext?: {
    visibleColumns?: Record<string, string[]>;
    filterableColumns?: Record<string, string[]>;
  }
) {
  console.log("[AGENT] Assembling Final Dashboard with Smart Layout...");
  void _insights;

  const humanizeField = (field: string) =>
    field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " ");

  /** Collect the schema-visible column names for a widget across all its tables.
   *  Parses widget.uses ("orders.id, customers.name") + widget.primaryTable to find tables,
   *  then returns the union of visibleColumns for those tables filtered to what the query returned. */
  const getSchemaVisibleColumnsForWidget = (w: any, resultFields: string[]): string[] | null => {
    const visibleColumnsMap = schemaContext?.visibleColumns;
    if (!visibleColumnsMap || Object.keys(visibleColumnsMap).length === 0) return null;

    // Collect all tables referenced by this widget
    const tables = new Set<string>();
    if (w.primaryTable) tables.add(String(w.primaryTable).trim().toLowerCase());
    const usesStr = String(w.uses || "");
    usesStr.split(",").forEach((ref) => {
      const parts = ref.trim().split(".");
      if (parts.length >= 2) tables.add(parts[0].trim().toLowerCase());
    });

    // If no table hints, check all tables whose visible columns overlap with result fields
    if (tables.size === 0) {
      const resultSet = new Set(resultFields.map((f) => f.toLowerCase()));
      Object.entries(visibleColumnsMap).forEach(([table, cols]) => {
        const overlap = (cols || []).filter((c) => resultSet.has(c.toLowerCase())).length;
        if (overlap >= 2) tables.add(table.toLowerCase());
      });
    }

    // Build the union of visible columns from matched tables, preserving order and filtering to result fields
    const resultFieldSet = new Set(resultFields.map((f) => f.toLowerCase()));
    const resultFieldByLower = new Map(resultFields.map((f) => [f.toLowerCase(), f]));
    const seen = new Set<string>();
    const ordered: string[] = [];

    // First: columns from matched tables in their schema order
    Object.entries(visibleColumnsMap).forEach(([table, cols]) => {
      if (!tables.has(table.toLowerCase())) return;
      (cols || []).forEach((col) => {
        const lower = col.toLowerCase();
        if (!seen.has(lower) && resultFieldSet.has(lower)) {
          seen.add(lower);
          ordered.push(resultFieldByLower.get(lower) || col);
        }
      });
    });

    // If nothing matched (alias mismatch), fall through to null so all columns show
    return ordered.length > 0 ? ordered : null;
  };

  /** Build filters for the dashboard from filterableColumns (schema discovery toggles).
   *  Only used when filterCandidates is empty and schema filterableColumns is available. */
  const buildFiltersFromFilterableColumns = (
    filterableColumns: Record<string, string[]>,
    schemaInfo: Record<string, any>
  ): any[] => {
    const humanize = (s: string) => s.replace(/[_.]+/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
    const filters: any[] = [];
    const usedIds = new Set<string>();
    Object.entries(filterableColumns).forEach(([table, cols]) => {
      (cols || []).forEach((col) => {
        const id = `${table}.${col}`;
        if (usedIds.has(id)) return;
        usedIds.add(id);
        const columnMeta = (schemaInfo?.[table]?.columns || []).find(
          (c: any) => (c?.name || c?.column_name) === col
        );
        const dataType = String(columnMeta?.data_type || columnMeta?.type || "").toLowerCase();
        const isDate = /date|time|timestamp/.test(dataType) || /date|_at$|_date$/.test(col.toLowerCase());
        filters.push({
          id,
          dimension: id,
          label: humanize(col),
          type: isDate ? "date-range" : "select",
          value: isDate ? "this_month" : null,
          ...(isDate ? {
            options: [
              { label: "Today", value: "today" },
              { label: "This Week", value: "this_week" },
              { label: "This Month", value: "this_month" },
              { label: "This Year", value: "this_year" },
              { label: "Custom", value: "custom" },
            ]
          } : {})
        });
      });
    });
    return filters;
  };

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

    // For table widgets: prefer schema-visible column order; fall back to merged planner + result columns
    let mergedTableColumns: any[] = [];
    if (w?.type === "table") {
      const schemaVisibleFields = getSchemaVisibleColumnsForWidget(w, resolvedColumnFields);

      if (schemaVisibleFields && schemaVisibleFields.length > 0) {
        // Use schema-discovery visible columns as authoritative order and filter
        const existingByField = new Map<string, any>();
        (Array.isArray(w?.tableConfig?.columns) ? w.tableConfig.columns : []).forEach((col: any) => {
          const field = String(col?.field || "").trim();
          if (field) existingByField.set(field, col);
        });
        mergedTableColumns = schemaVisibleFields.map((field) => {
          const existing = existingByField.get(field);
          if (existing) return existing;
          return { field, header: humanizeField(field), sortable: true };
        });
      } else {
        // Fallback: merge planner tableConfig columns with any extra result columns
        const existingTableColumns = Array.isArray(w?.tableConfig?.columns) ? w.tableConfig.columns : [];
        const existingByField = new Map<string, any>();
        existingTableColumns.forEach((col: any) => {
          const field = String(col?.field || "").trim();
          if (field) existingByField.set(field, col);
        });
        const mergedFields = [
          ...existingTableColumns.map((col: any) => String(col?.field || "").trim()).filter(Boolean),
          ...resolvedColumnFields.filter((field: string) => !existingByField.has(field)),
        ];
        mergedTableColumns = mergedFields.map((field) => {
          const existing = existingByField.get(field);
          if (existing) return existing;
          return { field, header: humanizeField(field) };
        });
      }
    }

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

  // Resolve dashboard-level filters: prefer filterableColumns from schema discovery,
  // then plan.filters, then filterCandidates
  const resolveFilters = () => {
    if (plan.filters?.length > 0) return normalizeFilterSet(plan.filters);
    const filterableColumns = schemaContext?.filterableColumns;
    if (filterableColumns && Object.keys(filterableColumns).length > 0) {
      const schemaFilters = buildFiltersFromFilterableColumns(
        filterableColumns,
        plan?.schemaInfo || {}
      );
      if (schemaFilters.length > 0) return normalizeFilterSet(schemaFilters);
    }
    return normalizeFilterSet(buildFiltersFromCandidates(filterCandidates));
  };

  const widgets = widgetsWithResults.map((w: any) => {
    const rest = { ...w };
    delete rest.__resultStatus;
    delete rest.__hasData;
    return rest;
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
    filters: resolveFilters(),
    updatedAt: new Date().toISOString(),
  };
}

export async function runNarrativeGenerator(resultsList: any[]) {
  console.log("[AGENT] Analyzing data trends...");
  const { runSkill } = await import("@/lib/skills/registry");
  const { registerNarrativeGeneratorSkill } = await import("@/lib/skills/narrative-generator");
  registerNarrativeGeneratorSkill();

  const { narrative } = await runSkill<any, any>("narrative-generator", { resultsList });
  return narrative;
}

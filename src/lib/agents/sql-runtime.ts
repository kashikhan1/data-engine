/* eslint-disable @typescript-eslint/no-explicit-any */
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentState } from "./state";
import { resolveConnectorContextFromSchema, validateSqlAgainstInstructions } from "./connector-policy";
import { createDefaultChatModel } from "@/lib/llm/model";
import { invokeModelWithRetry, extractJSON } from "@/lib/agents/llm-utils";
import { buildWidgetSqlContract, contractInputFromWidget } from "@/modules/sql/agent/widget-sql-contract";
import { buildDateContext, findLatestDate } from "@/modules/sql/agent/sql-prompt-hints";
import { dbGateway } from "@/lib/mcp/server";

const SQL_HUMAN_PROMPT_BUDGET = 5600;

function clipText(value: string, maxChars: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  if (maxChars <= 20) return text.slice(0, Math.max(0, maxChars));
  return `${text.slice(0, maxChars - 15).trimEnd()}\n[...truncated]`;
}

// ── Schema helpers ────────────────────────────────────────────────────────────

function resolveSchemaInfoMap(schemaLike: any): Record<string, any> {
  if (schemaLike?.schemaInfo && typeof schemaLike.schemaInfo === "object") return schemaLike.schemaInfo;
  return (schemaLike && typeof schemaLike === "object") ? schemaLike : {};
}

// ── SQL normalization & validation ────────────────────────────────────────────

function normalizeSqlCandidate(raw: unknown): string {
  let text = String(raw ?? "").trim();
  if (!text) return "";
  text = text.replace(/^\uFEFF/, "");
  text = text.replace(/```sql\s*/gi, "").replace(/```/g, "").trim();
  if (/^sql\s*:/i.test(text)) text = text.replace(/^sql\s*:/i, "").trim();
  const idx = text.search(/\b(select|with)\b/i);
  if (idx > 0) text = text.slice(idx).trim();
  return text;
}

function looksLikeSql(sql: string): boolean {
  if (!sql) return false;
  if (!/^\s*(select|with)\b/i.test(sql)) return false;
  if (/\b(please provide|need more context|what table|i cannot)\b/i.test(sql)) return false;
  return true;
}

// ── Smart schema context builder ──────────────────────────────────────────────

/**
 * Builds a rich, role-aware schema context for the SQL engineer prompt.
 *
 * Uses schema discovery outputs (column roles, topValues, null rates, row counts)
 * to give the LLM exactly the information it needs to write correct SQL —
 * without dumping the entire schema into the context window.
 *
 * Priority:
 *   1. Column listing grouped by role (measures, dates, categories, IDs)
 *   2. Actual data values for categorical columns (for WHERE clauses)
 *   3. High-null-rate warnings (triggers COALESCE guidance)
 *   4. Row counts per table (guides LIMIT N decisions)
 *   5. Join conditions between required tables
 *   6. One verified executed query as a pattern reference
 */
function buildWidgetSchemaContext(
  widget: any,
  schemaForPrompt: any,
  maxChars = 4500
): string {
  const schemaInfo = resolveSchemaInfoMap(schemaForPrompt);
  const tableInsights: Record<string, any> = schemaForPrompt?.tableInsights || {};
  const tableCounts: Record<string, number> = schemaForPrompt?.tableCounts || {};
  const relationships: any[] = schemaForPrompt?.relationships || schemaForPrompt?.schemaRelationships || [];

  const required: string[] = Array.isArray(widget?.requiredTables)
    ? widget.requiredTables.map((t: unknown) => String(t))
    : [];
  const primary: string[] = widget?.primaryTable ? [String(widget.primaryTable)] : [];
  const widgetTables = [...new Set([...primary, ...required])].filter(Boolean);
  const tables = widgetTables.length > 0 ? widgetTables : Object.keys(schemaInfo).slice(0, 3);

  const sections: string[] = [];
  let used = 0;

  // ── 1. Per-table columns grouped by role ─────────────────────────────────────
  const tableBlocks: string[] = [];

  for (const table of tables) {
    if (used > maxChars * 0.65) break;

    const rawCols: any[] = Array.isArray(schemaInfo?.[table]?.columns)
      ? schemaInfo[table].columns
      : [];
    const rowCount = tableCounts[table];
    const rowNote = rowCount ? ` — ${rowCount.toLocaleString()} rows` : "";

    // Partition by role (schema discovery ColumnRole field)
    const byRole = (role: string) => rawCols.filter((c: any) => c?.role === role);
    const measures = byRole("measure").map((c: any) => {
      const nullWarn = (c.nullRate ?? 0) > 0.2 ? ` [${Math.round(c.nullRate * 100)}% null→COALESCE]` : "";
      return `${c.name}${nullWarn}`;
    });
    const timestamps = byRole("timestamp").map((c: any) => c.name);
    const categories = byRole("category").map((c: any) => {
      const top = (c.topValues || []).slice(0, 5).map((v: any) => String(v.value));
      return top.length > 0 ? `${c.name}=[${top.join("|")}]` : c.name;
    });
    const ids = byRole("id").slice(0, 3).map((c: any) => c.name);
    // Fallback for unclassified columns (schemas without discovery profiling)
    const unclassified = rawCols
      .filter((c: any) => !c?.role || c.role === "unknown" || c.role === "flag" || c.role === "label")
      .slice(0, 8)
      .map((c: any) => `${c.name} (${c.type || c.data_type || ""})`);

    const lines = [`TABLE: ${table}${rowNote}`];
    if (timestamps.length) lines.push(`  dates:      ${timestamps.join(", ")}`);
    if (measures.length)   lines.push(`  measures:   ${measures.join(", ")}`);
    if (categories.length) lines.push(`  categories: ${categories.join(", ")}`);
    if (ids.length)        lines.push(`  join keys:  ${ids.join(", ")}`);
    if (!measures.length && !timestamps.length && unclassified.length)
      lines.push(`  columns:    ${unclassified.join(", ")}`);

    const block = lines.join("\n");
    tableBlocks.push(block);
    used += block.length;
  }
  sections.push(tableBlocks.join("\n\n"));

  // ── 2. Join conditions between the widget's required tables ──────────────────
  const widgetTableSet = new Set(tables.map((t) => t.toLowerCase()));
  const relevantRels = relationships.filter((r: any) => {
    const from = (r?.fromTable || r?.from?.table || "").toLowerCase();
    const to = (r?.toTable || r?.to?.table || "").toLowerCase();
    return widgetTableSet.has(from) && widgetTableSet.has(to);
  });

  if (relevantRels.length > 0 && used < maxChars) {
    const relLines = relevantRels.slice(0, 4).map((r: any) => {
      const ft = r?.fromTable || r?.from?.table || "";
      const fc = r?.via || r?.from?.column || "";
      const tt = r?.toTable || r?.to?.table || "";
      const tc = r?.targetColumn || r?.to?.column || "";
      return `  ${ft}.${fc} = ${tt}.${tc}`;
    });
    sections.push(`\nJOIN CONDITIONS (use these exact keys):\n${relLines.join("\n")}`);
    used += relLines.join("\n").length;
  }

  // ── 3. Actual column values from filter candidates ───────────────────────────
  const filterLines: string[] = [];
  for (const table of tables) {
    if (used > maxChars * 0.85) break;
    const filters: any[] = tableInsights[table]?.filters || [];
    for (const f of filters.slice(0, 2)) {
      const vals = (f.examples?.sampleValues || f.examples?.distinctValues || []).slice(0, 6);
      if (vals.length > 0) {
        filterLines.push(`  ${table}.${f.column} (${f.type}): ${vals.map(String).join(" | ")}`);
      }
    }
  }
  if (filterLines.length > 0 && used < maxChars) {
    sections.push(`\nACTUAL VALUES (for WHERE / GROUP BY):\n${filterLines.slice(0, 6).join("\n")}`);
  }

  // ── 4. One verified executed query as a pattern reference ────────────────────
  let bestExample: any = null;
  for (const table of tables) {
    const examples: any[] = tableInsights[table]?.queryExamples || [];
    bestExample = examples.find((e: any) => e?.results?.length > 0 && e?.sql);
    if (bestExample) break;
  }
  if (bestExample?.sql && used < maxChars * 0.9) {
    const exSql = bestExample.sql.replace(/\n/g, " ").slice(0, 350);
    sections.push(`\nVERIFIED QUERY PATTERN:\n  -- ${bestExample.description || "working example"}\n  ${exSql}`);
  }

  // ── 5. No-filter column warnings (only explicitly disabled by user) ──────────
  const disabledFilterColumns: Record<string, string[]> = schemaForPrompt?.disabledFilterColumns || {};
  const noFilterWarnings: string[] = [];
  for (const table of tables) {
    const disabledList = disabledFilterColumns[table];
    if (!Array.isArray(disabledList) || disabledList.length === 0) continue;
    noFilterWarnings.push(`  ${table}: ${disabledList.join(", ")}`);
  }
  if (noFilterWarnings.length > 0) {
    sections.push(`\nNO-FILTER COLUMNS (SELECT only — do NOT use in WHERE/HAVING/JOIN):\n${noFilterWarnings.join("\n")}`);
  }

  // ── 6. Allowed filter columns (user-enabled via schema configuration) ─────────
  const filterableColumns: Record<string, string[]> = schemaForPrompt?.filterableColumns || {};
  const filterAllowLines: string[] = [];
  for (const table of tables) {
    const allowed = filterableColumns[table];
    if (!Array.isArray(allowed) || allowed.length === 0) continue;
    filterAllowLines.push(`  ${table}: ${allowed.join(", ")}`);
  }
  if (filterAllowLines.length > 0) {
    sections.push(`\nALLOWED FILTER COLUMNS (ONLY these may appear in WHERE/HAVING/JOIN ON — all others are SELECT-only):\n${filterAllowLines.join("\n")}`);
  }

  return sections.join("\n").slice(0, maxChars);
}

// ── Plan context extractor ────────────────────────────────────────────────────

/**
 * Extracts business context from the plan and schema objects — domain, intent,
 * and guidance generated by the planner agents. Gives the SQL engineer the "why"
 * behind each widget.
 */
function buildPlanContext(plan: any, schemaForPrompt: any): string {
  const lines: string[] = [];

  // Plan-level dashboard title (broad business goal)
  if (plan?.title) lines.push(`Dashboard: ${plan.title}`);

  // Domain guidance from planner meta (set by metaFilterDomain agent)
  const meta = plan?.meta || plan?.plannerMeta || plan?.plannerDebug;
  if (meta?.domain) lines.push(`Domain: ${meta.domain}`);
  if (meta?.intentLabels?.length) lines.push(`Query intent: ${meta.intentLabels.join(", ")}`);
  if (meta?.domainGuidance) lines.push(`Domain guidance: ${meta.domainGuidance}`);
  if (meta?.finalGoal) lines.push(`Final goal: ${meta.finalGoal}`);
  if (Array.isArray(meta?.planGoals) && meta.planGoals.length > 0)
    lines.push(`Plan goals: ${meta.planGoals.slice(0, 6).join(" | ")}`);
  if (Array.isArray(meta?.kpiGoals) && meta.kpiGoals.length > 0)
    lines.push(`KPI goals: ${meta.kpiGoals.slice(0, 6).join(" | ")}`);

  // Domain summary from schema discovery
  const domainSummary = String(schemaForPrompt?.domainSummary || "").trim();
  if (domainSummary && !lines.some((l) => l.includes(domainSummary.slice(0, 20)))) {
    lines.push(`Business context: ${domainSummary.slice(0, 300)}`);
  }

  // Business glossary terms (if any — maps business terms to column names)
  const glossary: Record<string, string> = schemaForPrompt?.businessGlossary || {};
  const glossaryTerms = Object.entries(glossary)
    .slice(0, 6)
    .map(([term, def]) => `${term}=${def}`)
    .join("; ");
  if (glossaryTerms) lines.push(`Glossary: ${glossaryTerms}`);

  return lines.filter(Boolean).join("\n");
}

// ── Shared input type ─────────────────────────────────────────────────────────

type SqlEngineerSharedInput = {
  plan: any;
  schemaForPrompt: any;
  connectorType: string;
  connectionString?: string;
  connectorInstructions?: string;
  userQuery: string;
  planContext: string;
  filters?: Record<string, any>;
  dateContext?: { baseDate: string; summary: string };
  mcpContextByTable?: Record<string, string>;
};

type SqlErrorEntry = { id: string; title?: string; sql?: string; error: string; timestamp?: string };
type SqlPromptMode = "full" | "focused";
type SqlGenerationPath = "full" | "focused" | "fallback";

function isMssqlDialect(connectorType?: string, connectionString?: string): boolean {
  const t = String(connectorType || "").toLowerCase();
  const c = String(connectionString || "").toLowerCase();
  return t.includes("mssql") || t.includes("sqlserver") || c.startsWith("mssql://") || c.startsWith("sqlserver://") || c.includes("server=") || c.includes("data source=");
}

function parseWidgetRefs(uses: string): string[] {
  return String(uses || "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.includes("."));
}

function buildDeterministicFallbackSql(widget: any, shared: SqlEngineerSharedInput): string {
  const refs = parseWidgetRefs(widget?.uses);
  const isMssql = isMssqlDialect(shared.connectorType, shared.connectionString);
  const primaryTable = String(widget?.primaryTable || refs[0]?.split(".")[0] || "").trim();
  if (!primaryTable) return "SELECT 1 AS value;";
  const tableRef = isMssql ? `[${primaryTable.replace(/]/g, "]]")}]` : `"${primaryTable.replace(/"/g, '""')}"`;
  const cols = refs.filter((r) => r.startsWith(`${primaryTable}.`)).map((r) => r.split(".")[1]).filter(Boolean);
  const temporal = cols.find((c) => /date|time|created|updated|_at$|timestamp|day|month|year|week/i.test(c));
  const numeric = cols.find((c) => /(amount|revenue|cost|price|qty|quantity|count|total|value|sales|profit|score|metric)/i.test(c)) || cols.find((c) => !/id$|_id$/.test(c));
  const dimension = cols.find((c) => /status|type|category|segment|country|region|city|department|team|plan|tier|channel/i.test(c)) || cols.find((c) => c !== numeric && c !== temporal);
  const metricExpr = numeric
    ? `SUM(COALESCE(${isMssql ? `[${numeric}]` : `"${numeric}"`}, 0))`
    : "COUNT(*)";
  const widgetType = String(widget?.type || "").toLowerCase();

  if (widgetType === "kpi") {
    return `SELECT ${metricExpr} AS metric_value FROM ${tableRef};`;
  }
  if ((widgetType === "line" || widgetType === "area") && temporal) {
    const tcol = isMssql ? `[${temporal}]` : `"${temporal}"`;
    const bucket = isMssql
      ? `DATEADD(month, DATEDIFF(month, 0, ${tcol}), 0)`
      : `DATE_TRUNC('month', ${tcol})`;
    const limit = isMssql ? "" : "\nLIMIT 60";
    return `SELECT ${bucket} AS time_bucket, ${metricExpr} AS metric_value\nFROM ${tableRef}\nGROUP BY ${bucket}\nORDER BY time_bucket ASC${limit};`;
  }
  if ((widgetType === "bar" || widgetType === "pie" || widgetType === "donut") && dimension) {
    const dcol = isMssql ? `[${dimension}]` : `"${dimension}"`;
    if (isMssql) {
      return `SELECT TOP 10 ${dcol} AS dimension, ${metricExpr} AS metric_value\nFROM ${tableRef}\nGROUP BY ${dcol}\nORDER BY metric_value DESC;`;
    }
    return `SELECT ${dcol} AS dimension, ${metricExpr} AS metric_value\nFROM ${tableRef}\nGROUP BY ${dcol}\nORDER BY metric_value DESC\nLIMIT 10;`;
  }
  if (widgetType === "table") {
    if (isMssql) {
      return `SELECT *, COUNT(*) OVER() AS total_count\nFROM ${tableRef}\nORDER BY 1 ASC\nOFFSET {{offset:0}} ROWS FETCH NEXT {{size:25}} ROWS ONLY;`;
    }
    return `SELECT *, COUNT(*) OVER() AS total_count\nFROM ${tableRef}\nORDER BY 1 ASC\nLIMIT {{size:25}} OFFSET {{offset:0}};`;
  }
  if (isMssql) {
    return `SELECT TOP 50 * FROM ${tableRef};`;
  }
  return `SELECT * FROM ${tableRef}\nLIMIT 50;`;
}

// ── Core SQL engineer agent ───────────────────────────────────────────────────

async function runSqlEngineerAgent(input: SqlEngineerSharedInput & {
  widget: any;
  widgetId: string;
  errorLog?: SqlErrorEntry[];
  mode?: SqlPromptMode;
}): Promise<string> {
  const {
    widget, widgetId, plan, schemaForPrompt, connectorType,
    userQuery, planContext, filters, dateContext, errorLog = [], mode = "full",
  } = input;

  // ── Widget SQL contract: output shape, row cap, aggregation rules, template ──
  const contract = buildWidgetSqlContract(contractInputFromWidget(widget, connectorType, schemaForPrompt));

  // ── Smart schema context: column roles, actual values, join keys, row counts ─
  const schemaContext = buildWidgetSchemaContext(widget, schemaForPrompt, 1800);
  const tableList = Array.from(new Set([
    ...(Array.isArray(widget?.requiredTables) ? widget.requiredTables.map((t: unknown) => String(t)) : []),
    String(widget?.primaryTable || "")
  ])).filter(Boolean);
  const mcpContext = tableList
    .map((table) => String(input.mcpContextByTable?.[table] || ""))
    .filter(Boolean)
    .join("\n\n");

  // ── Date arithmetic context: resolved TODAY/THIS_MONTH/LAST_YEAR dates ───────
  const dateCtxBlock = dateContext
    ? `DATE CONTEXT (use these exact dates — do not use CURRENT_DATE/NOW() in a vacuum):\n${dateContext.summary}`
    : "";

  // ── Planner-provided SQL hints and column refs ────────────────────────────────
  const plannerNotes = String(widget?.notes || "").trim();
  const plannerUses = String(widget?.uses || "").trim();

  // ── Runtime error context ─────────────────────────────────────────────────────
  const filterHints = Object.keys(filters || {}).length > 0 ? JSON.stringify(filters) : "";
  const errorHints = errorLog.length > 0 ? JSON.stringify(errorLog.slice(0, 3)) : "";

  void plan; // plan is available for future use

  const system = `You are a senior SQL engineer. Generate ONE ${connectorType.toUpperCase()} SQL query for a dashboard widget.
Return ONLY valid JSON: {"sql": "..."}

RULES:
- SQL must start with SELECT or WITH. Use ONLY columns that exist in TABLES section.
- Follow the WIDGET CONTRACT output shape exactly — wrong shape breaks the visualizer.
- SUM only additive measures (revenue, amount, cost, quantity). For rates/ratios, recompute: numerator / NULLIF(denominator, 0).
- JOIN SAFETY: when joining on 1-to-many, aggregate BEFORE the join to prevent fan-out inflating SUM.
- COUNT(DISTINCT id_col) for unique entity counts across a join (not COUNT(*)).
- COALESCE nullable measures when NULL means zero: COALESCE(amount, 0).
- Use actual column values from ACTUAL VALUES section for WHERE / CASE conditions.
- The PLANNER SQL HINTS encode the exact correct aggregation pattern — follow them precisely.
- NO-FILTER COLUMNS: Any column listed under "NO-FILTER COLUMNS" in the schema context is disabled for filtering. It may appear in SELECT but MUST NOT appear in WHERE, HAVING, or JOIN ON conditions.
- ALLOWED FILTER COLUMNS: When "ALLOWED FILTER COLUMNS" are listed in the schema context, ONLY those columns may appear in WHERE, HAVING, or JOIN ON conditions. Any column NOT in that list is SELECT-only — even if it looks like a useful filter. This is a hard constraint enforced by the user's schema configuration.`;

  const contractHint = clipText(contract.fullHint, mode === "focused" ? 620 : 900);
  let schemaContextHint = clipText(schemaContext, 1600);
  let mcpContextHint = clipText(mcpContext, mode === "focused" ? 360 : 900);

  let human = [
    // ── Business context ────────────────────────────────────────────────────────
    userQuery ? `USER QUESTION: ${clipText(userQuery, mode === "focused" ? 260 : 450)}` : "",
    planContext ? `\n${clipText(planContext, mode === "focused" ? 420 : 850)}` : "",

    // ── Widget specification ────────────────────────────────────────────────────
    `\nWIDGET:`,
    `  ID: ${widgetId} | Type: ${widget?.type || "bar"} | Title: ${widget?.title || "Untitled"}`,
    `  Goal: ${widget?.goal || "Visualization"}`,
    `  Primary table: ${widget?.primaryTable || "unknown"}`,
    plannerUses ? `  Planner column refs: ${clipText(plannerUses, 280)}` : "",
    plannerNotes ? `  Planner SQL hints: ${clipText(plannerNotes, 340)}` : "",

    // ── Contract: output shape, row limit, aggregation rules ────────────────────
    `\n${contractHint}`,

    // ── Schema: role-grouped columns, actual values, join keys ──────────────────
    `\n${schemaContextHint}`,
    mcpContextHint ? `\nMCP LIVE TABLE CONTEXT (authoritative helper checks):\n${mcpContextHint}` : "",

    // ── Date arithmetic ─────────────────────────────────────────────────────────
    dateCtxBlock ? `\n${clipText(dateCtxBlock, 250)}` : "",

    // ── Runtime context ─────────────────────────────────────────────────────────
    filterHints ? `\nRUNTIME FILTERS: ${clipText(filterHints, mode === "focused" ? 220 : 450)}` : "",
    errorHints ? `\nPREVIOUS ERRORS (fix these — do NOT repeat):\n${clipText(errorHints, mode === "focused" ? 300 : 600)}` : "",
  ].filter(Boolean).join("\n");

  if (human.length > SQL_HUMAN_PROMPT_BUDGET) {
    schemaContextHint = clipText(schemaContextHint, 900);
    mcpContextHint = clipText(mcpContextHint, 420);
    human = [
      userQuery ? `USER QUESTION: ${clipText(userQuery, 380)}` : "",
      planContext ? `\n${clipText(planContext, 600)}` : "",
      `\nWIDGET:`,
      `  ID: ${widgetId} | Type: ${widget?.type || "bar"} | Title: ${widget?.title || "Untitled"}`,
      `  Goal: ${clipText(String(widget?.goal || "Visualization"), 220)}`,
      `  Primary table: ${widget?.primaryTable || "unknown"}`,
      plannerUses ? `  Planner column refs: ${clipText(plannerUses, 220)}` : "",
      plannerNotes ? `  Planner SQL hints: ${clipText(plannerNotes, 240)}` : "",
      `\n${clipText(contractHint, 620)}`,
      `\n${schemaContextHint}`,
      mcpContextHint ? `\nMCP LIVE TABLE CONTEXT (authoritative helper checks):\n${mcpContextHint}` : "",
      dateCtxBlock ? `\n${clipText(dateCtxBlock, 200)}` : "",
      filterHints ? `\nRUNTIME FILTERS: ${clipText(filterHints, 280)}` : "",
      errorHints ? `\nPREVIOUS ERRORS (fix these — do NOT repeat):\n${clipText(errorHints, 360)}` : "",
    ].filter(Boolean).join("\n");
  }
  if (human.length > SQL_HUMAN_PROMPT_BUDGET) {
    human = clipText(human, SQL_HUMAN_PROMPT_BUDGET);
  }

  const response = await invokeModelWithRetry(
    () => createDefaultChatModel({ logPrefix: `[LLM][SQL_ENGINEER][${widgetId}]`, timeoutMs: 120000 }),
    [new SystemMessage(system), new HumanMessage(human)],
    1,
    300
  );

  const content = String((response as { content?: unknown })?.content || "");
  const parsed = extractJSON(content) as { sql?: string } | null;
  const sql = normalizeSqlCandidate(parsed?.sql || content);
  if (!looksLikeSql(sql)) {
    throw new Error(`Invalid SQL output for widget ${widgetId}`);
  }
  return sql;
}

async function buildMcpContextByTable(
  tables: string[],
  connectionString?: string
): Promise<Record<string, string>> {
  const byTable: Record<string, string> = {};
  if (!connectionString || !Array.isArray(tables) || tables.length === 0) return byTable;
  const uniqueTables = Array.from(new Set(tables.map((t) => String(t || "").trim()).filter(Boolean))).slice(0, 8);
  const tasks = uniqueTables.map(async (table) => {
    try {
      const [schemaRes, previewRes] = await Promise.all([
        dbGateway.getTableSchema(table, connectionString),
        dbGateway.getTablePreview(table, connectionString),
      ]);
      const columns = Array.isArray((schemaRes as any)?.columns)
        ? (schemaRes as any).columns
        : Array.isArray(schemaRes)
          ? schemaRes
          : Array.isArray((schemaRes as any)?.data?.columns)
            ? (schemaRes as any).data.columns
            : [];
      const sampleRows = Array.isArray(previewRes) ? previewRes : Array.isArray((previewRes as any)?.data) ? (previewRes as any).data : [];
      const columnList = columns
        .slice(0, 10)
        .map((c: any) => `${String(c?.name || c?.column_name || "").trim()} (${String(c?.type || c?.data_type || "").trim()})`)
        .filter(Boolean);
      const sampleSnippet = sampleRows
        .slice(0, 3)
        .map((r: any) => JSON.stringify(r))
        .join(" | ");
      byTable[table] = [
        `TABLE: ${table}`,
        columnList.length > 0 ? `  columns: ${columnList.join(", ")}` : "  columns: unavailable",
        sampleSnippet ? `  sample_rows: ${sampleSnippet}` : "  sample_rows: unavailable",
      ].join("\n");
    } catch {
      // best-effort MCP enrichment; ignore failures
    }
  });
  await Promise.all(tasks);
  return byTable;
}

// ── Generate + validate with one retry ───────────────────────────────────────

async function generateAndValidateSql(
  widget: any,
  widgetId: string,
  shared: SqlEngineerSharedInput,
  errorLog: SqlErrorEntry[]
): Promise<{ sql: string; path: SqlGenerationPath }> {
  const sql = await runSqlEngineerAgent({ ...shared, widget, widgetId, errorLog, mode: "full" });

  // Dialect-only validation (no schema column/join checks — false positives with CTEs/aliases).
  // Column correctness is caught at execution time.
  const validation = validateSqlAgainstInstructions(
    sql,
    shared.connectionString,
    shared.connectorInstructions,
    shared.connectorType,
    shared.schemaForPrompt,
    { id: widgetId, type: widget?.type }
  );

  if (validation.ok) return { sql, path: "full" };

  // One retry with the dialect error injected into the error log
  const retryErrorLog: SqlErrorEntry[] = [
    ...errorLog,
    { id: widgetId, title: widget?.title, sql, error: validation.error ?? "Validation failed" },
  ];
  try {
    const retrySql = await runSqlEngineerAgent({ ...shared, widget, widgetId, errorLog: retryErrorLog, mode: "focused" });
    const retryValidation = validateSqlAgainstInstructions(
      retrySql,
      shared.connectionString,
      shared.connectorInstructions,
      shared.connectorType,
      shared.schemaForPrompt,
      { id: widgetId, type: widget?.type }
    );
    if (retryValidation.ok) return { sql: retrySql, path: "focused" };
    return { sql: buildDeterministicFallbackSql(widget, shared), path: "fallback" };
  } catch {
    return { sql: buildDeterministicFallbackSql(widget, shared), path: "fallback" };
  }
}

// ── Public orchestrator ───────────────────────────────────────────────────────

export async function runQueryGenerator(
  plan: any,
  schema: any,
  filters: Record<string, any> = {},
  errorLog: SqlErrorEntry[] = [],
  _applyFilters: boolean = false,
  onWidgetComplete?: (id: string, sql: string, index: number, total: number, path?: SqlGenerationPath) => void
) {
  void _applyFilters;

  const schemaForPrompt = schema || {};
  const connector = resolveConnectorContextFromSchema(schemaForPrompt);
  const connectorType = connector.connectorType || (connector.isMssql ? "mssql" : "postgres");

  // Extract the user's original question from wherever it was stored
  const userQuery = String(
    schemaForPrompt?.userQuery ||
    plan?.userQuery || plan?.query || plan?.originalQuery ||
    schemaForPrompt?.intent || ""
  ).trim();

  // Extract business/domain context from the plan and schema
  const planContext = buildPlanContext(plan, schemaForPrompt);

  // Grounded date context (resolved from latest sample data date or today)
  const latestDate = findLatestDate(schemaForPrompt?.sampleData || {});
  const dateContext = buildDateContext(latestDate);

  const widgets: any[] = Array.isArray(plan?.widgets) ? plan.widgets.slice(0, 10) : [];
  const widgetIds = new Set<string>();

  const mcpTables = widgets.flatMap((widget: any) => {
    const required = Array.isArray(widget?.requiredTables) ? widget.requiredTables.map((t: unknown) => String(t)) : [];
    const primary = widget?.primaryTable ? [String(widget.primaryTable)] : [];
    return [...required, ...primary];
  });
  const mcpContextByTable = await buildMcpContextByTable(mcpTables, connector.connectionString);

  const shared: SqlEngineerSharedInput = {
    plan,
    schemaForPrompt,
    connectorType,
    connectionString: connector.connectionString,
    connectorInstructions: connector.connectorInstructions,
    userQuery,
    planContext,
    filters,
    dateContext,
    mcpContextByTable,
  };

  // Generate SQL for all widgets in parallel
  const results = await Promise.allSettled(
    widgets.map(async (widget: any, idx: number) => {
      const rawId = String(widget?.id || `w${idx + 1}`);
      let widgetId = rawId;
      let suffix = 1;
      while (widgetIds.has(widgetId)) {
        widgetId = `${rawId}_${suffix++}`;
      }
      widgetIds.add(widgetId);
      const generated = await generateAndValidateSql(widget, widgetId, shared, errorLog);
      return { widgetId, sql: generated.sql, idx, path: generated.path };
    })
  );

  const sqlMap: Record<string, string> = {};
  const failures: string[] = [];

  results.forEach((result) => {
    if (result.status === "fulfilled") {
      const { widgetId, sql, idx } = result.value;
      sqlMap[widgetId] = sql;
      onWidgetComplete?.(widgetId, sql, idx + 1, widgets.length, result.value.path);
    } else {
      failures.push(String(result.reason?.message || result.reason));
    }
  });

  // Return partial results — individual widget failures don't abort the batch.
  // Only throw when every single widget failed (empty sqlMap is useless).
  if (Object.keys(sqlMap).length === 0 && failures.length > 0) {
    throw new Error(`SQL engineer failed for all ${failures.length} widget(s): ${failures.join(" | ")}`);
  }

  return sqlMap;
}

export async function multiQueryOrchestratorAgent(state: typeof AgentState.State) {
  const plan = state.queryPlan;
  const filters = (state.context?.runtimeParams as Record<string, any>) || {};
  const errorLog = (state.errors || []).map((err) => ({ id: "prev_error", error: err }));
  const schemaForPrompt = {
    schemaInfo: state.schemaInfo,
    sampleData: state.sampleData,
    relationships: state.schemaRelationships,
    tableCounts: state.tableCounts,
    tableInsights: state.dataProfile,
    domainSummary: (state as any).domainSummary || "",
    businessGlossary: (state as any).businessGlossary || {},
    intent: state.intent,
    filterCandidates: state.filterCandidates,
    ...(state.context || {}),
  };

  try {
    const sqlMap = await runQueryGenerator(plan, schemaForPrompt, filters, errorLog, true);
    return {
      queryPlan: plan,
      queryValidation: sqlMap,
      sqlQueries: Object.values(sqlMap),
      status: "Generated SQL with LLM SQL engineer agents.",
      messages: [new AIMessage(`[ORCHESTRATOR] Generated ${Object.keys(sqlMap).length} SQL statements.`)],
    };
  } catch (err: any) {
    return {
      queryPlan: plan,
      queryValidation: {},
      sqlQueries: [],
      errors: [String(err?.message || err)],
      status: `SQL generation failed: ${String(err?.message || err)}`,
      messages: [new AIMessage(`[ORCHESTRATOR] SQL generation failed: ${String(err?.message || err)}`)],
    };
  }
}

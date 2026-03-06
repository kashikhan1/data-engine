/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Widget SQL Contract Builder
 *
 * Per-widget-type SQL shape specifications for the SQL engineer agent.
 * Covers PostgreSQL, MSSQL, MySQL, BigQuery, and Snowflake dialects.
 * Drives the SQL generator prompt so the LLM produces the right query shape,
 * row limits, ORDER BY, aggregations, time-bucket expressions, and pagination
 * for every widget type.
 */

// ── Dialect types ─────────────────────────────────────────────────────────────

export type SqlDialect = "postgres" | "mssql" | "mysql" | "bigquery" | "snowflake";

export function detectDialectFromConnectorType(connectorType: string): SqlDialect {
  const t = String(connectorType || "").toLowerCase();
  if (t.includes("mssql") || t.includes("sqlserver") || t.includes("sql server")) return "mssql";
  if (t.includes("mysql") || t.includes("mariadb")) return "mysql";
  if (t.includes("bigquery") || t.includes("bq")) return "bigquery";
  if (t.includes("snowflake")) return "snowflake";
  return "postgres";
}

function resolveDialect(connectorTypeOrIsMssql: string | boolean): SqlDialect {
  if (typeof connectorTypeOrIsMssql === "boolean") {
    return connectorTypeOrIsMssql ? "mssql" : "postgres";
  }
  return detectDialectFromConnectorType(connectorTypeOrIsMssql);
}

// ── Contract I/O types ────────────────────────────────────────────────────────

export type WidgetContractInput = {
  widgetType: string;
  /** Legacy boolean — prefer connectorType string */
  isMssql: boolean;
  /** Connector type string (postgres, mssql, mysql, bigquery, snowflake) */
  connectorType?: string;
  /** Fully-qualified date column, e.g. "orders.created_at" */
  primaryDate?: string | null;
  /** Fully-qualified metric column, e.g. "orders.amount" */
  primaryMetric?: string | null;
  /** Second metric column for scatter plots (y-axis) */
  secondaryMetric?: string | null;
  /** Fully-qualified dimension column, e.g. "orders.status" */
  primaryDimension?: string | null;
  /** Time granularity for line/area charts */
  granularity?: string | null;
  /** Max rows the widget should fetch */
  rowLimit?: number | null;
  /** KPI only: include current-vs-previous-period comparison CTE */
  periodComparison?: boolean;
  /** Filterable columns per table (from schema discovery toggles) */
  filterableColumns?: Record<string, string[]> | null;
  /** Visible column names for this widget (from schema discovery visibleColumns) */
  visibleColumnNames?: string[] | null;
};

export type WidgetContractResult = {
  /** Human-readable column shape expected */
  shape: string;
  /** Enforced row cap */
  rowLimit: number;
  /** Full hint block injected into the SQL-generator prompt */
  fullHint: string;
};

// ── Dialect-aware helpers ─────────────────────────────────────────────────────

function dateTruncExpr(col: string, granularity: string, dialect: SqlDialect): string {
  const unitMap: Record<string, string> = {
    daily: "day", day: "day",
    weekly: "week", week: "week",
    monthly: "month", month: "month",
    yearly: "year", year: "year",
  };
  const unit = unitMap[String(granularity || "month").toLowerCase()] || "month";
  switch (dialect) {
    case "mssql":
      return `DATEADD(${unit}, DATEDIFF(${unit}, 0, ${col}), 0)`;
    case "mysql":
      if (unit === "day") return `DATE(${col})`;
      if (unit === "month") return `DATE_FORMAT(${col}, '%Y-%m-01')`;
      if (unit === "week") return `DATE_FORMAT(${col}, '%Y-%u')`;
      return `DATE_FORMAT(${col}, '%Y-01-01')`;
    case "bigquery":
      return `DATE_TRUNC(${col}, ${unit.toUpperCase()})`;
    case "snowflake":
      return `DATE_TRUNC('${unit}', ${col})`;
    default: // postgres
      return `DATE_TRUNC('${unit}', ${col})`;
  }
}

function currentPeriodFilter(col: string, dialect: SqlDialect): string {
  switch (dialect) {
    case "mssql":
      return `${col} >= DATEADD(month, DATEDIFF(month, 0, GETDATE()), 0)\n   AND ${col} < DATEADD(month, DATEDIFF(month, 0, GETDATE()) + 1, 0)`;
    case "mysql":
      return `${col} >= DATE_FORMAT(NOW(), '%Y-%m-01')\n   AND ${col} < DATE_FORMAT(DATE_ADD(NOW(), INTERVAL 1 MONTH), '%Y-%m-01')`;
    case "bigquery":
      return `${col} >= DATE_TRUNC(CURRENT_DATE(), MONTH)\n   AND ${col} < DATE_ADD(DATE_TRUNC(CURRENT_DATE(), MONTH), INTERVAL 1 MONTH)`;
    case "snowflake":
      return `${col} >= DATE_TRUNC('month', CURRENT_DATE)\n   AND ${col} < DATEADD(month, 1, DATE_TRUNC('month', CURRENT_DATE))`;
    default: // postgres
      return `${col} >= DATE_TRUNC('month', CURRENT_DATE)\n   AND ${col} < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'`;
  }
}

function prevPeriodFilter(col: string, dialect: SqlDialect): string {
  switch (dialect) {
    case "mssql":
      return `${col} >= DATEADD(month, DATEDIFF(month, 0, GETDATE()) - 1, 0)\n   AND ${col} < DATEADD(month, DATEDIFF(month, 0, GETDATE()), 0)`;
    case "mysql":
      return `${col} >= DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 1 MONTH), '%Y-%m-01')\n   AND ${col} < DATE_FORMAT(NOW(), '%Y-%m-01')`;
    case "bigquery":
      return `${col} >= DATE_SUB(DATE_TRUNC(CURRENT_DATE(), MONTH), INTERVAL 1 MONTH)\n   AND ${col} < DATE_TRUNC(CURRENT_DATE(), MONTH)`;
    case "snowflake":
      return `${col} >= DATEADD(month, -1, DATE_TRUNC('month', CURRENT_DATE))\n   AND ${col} < DATE_TRUNC('month', CURRENT_DATE)`;
    default: // postgres
      return `${col} >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'\n   AND ${col} < DATE_TRUNC('month', CURRENT_DATE)`;
  }
}

function topNClause(n: number, dialect: SqlDialect): { prefix: string; suffix: string } {
  if (dialect === "mssql") return { prefix: `TOP ${n} `, suffix: "" };
  return { prefix: "", suffix: `LIMIT ${n}` };
}

function paginationClause(dialect: SqlDialect): string {
  if (dialect === "mssql") return `OFFSET {{offset:0}} ROWS FETCH NEXT {{size:25}} ROWS ONLY`;
  return `LIMIT {{size:25}} OFFSET {{offset:0}}`;
}

function dateFnNote(dialect: SqlDialect): string {
  switch (dialect) {
    case "mssql":
      return `MSSQL date functions: DATEADD / DATEDIFF / GETDATE(). Never use DATE_TRUNC, INTERVAL, or CURRENT_DATE.`;
    case "mysql":
      return `MySQL date functions: DATE_FORMAT / DATE_ADD / DATE_SUB / NOW(). Use DATE_FORMAT(col,'%Y-%m-01') for month truncation.`;
    case "bigquery":
      return `BigQuery date functions: DATE_TRUNC / DATE_ADD / DATE_SUB / CURRENT_DATE(). Use TIMESTAMP_TRUNC for timestamp columns.`;
    case "snowflake":
      return `Snowflake date functions: DATE_TRUNC / DATEADD / CURRENT_DATE. Use CONVERT_TIMEZONE for timezone-aware columns.`;
    default: // postgres
      return `PostgreSQL date functions: DATE_TRUNC / CURRENT_DATE / INTERVAL. Never use DATEADD/DATEDIFF/GETDATE.`;
  }
}

function pctChange(curr: string, prev: string, dialect: SqlDialect): string {
  const numerator = `(${curr} - ${prev}) * 100.0`;
  switch (dialect) {
    case "bigquery":
      return `SAFE_DIVIDE(${numerator}, ${prev})`;
    case "mysql":
      return `IF(${prev} = 0, NULL, ${numerator} / ${prev})`;
    case "snowflake":
      return `DIV0(${numerator}, ${prev})`;
    default: // postgres, mssql
      return `${numerator} / NULLIF(${prev}, 0)`;
  }
}

function indent(text: string, spaces = 4): string {
  return text.split("\n").map((l) => " ".repeat(spaces) + l).join("\n");
}

// ── Contract builder ──────────────────────────────────────────────────────────

export function buildWidgetSqlContract(input: WidgetContractInput): WidgetContractResult {
  const dialect = resolveDialect(input.connectorType || input.isMssql);
  const isMssql = dialect === "mssql";

  const {
    primaryDate,
    primaryMetric,
    secondaryMetric,
    primaryDimension,
    granularity = "monthly",
    rowLimit,
    periodComparison = false,
  } = input;

  const typ = String(input.widgetType || "bar").toLowerCase();
  const dateCol = primaryDate || "<date_column>";
  const metricCol = primaryMetric || "<metric_column>";
  const metric2Col = secondaryMetric || "<metric2_column>";
  const dimCol = primaryDimension || "<dimension_column>";

  const defaultLimitMap: Record<string, number> = {
    pie: 10, donut: 10, kpi: 1, line: 60, area: 60,
    funnel: 20, scatter: 500, cohort: 24, map: 150,
  };
  const limitN = rowLimit ?? (defaultLimitMap[typ] ?? 20);

  const { prefix: topPrefix, suffix: limitSuffix } = topNClause(limitN, dialect);
  const paginationSQL = paginationClause(dialect);
  const dateFnHint = dateFnNote(dialect);

  // ── KPI ────────────────────────────────────────────────────────────────────
  if (typ === "kpi") {
    const hasDate = Boolean(primaryDate);
    let template: string;

    if (hasDate && periodComparison) {
      template = [
        `WITH current_p AS (`,
        `  SELECT [AGG](${metricCol}) AS metric_value`,
        `  FROM [primary_table]`,
        `  WHERE ${currentPeriodFilter(dateCol, dialect)}`,
        `), prev_p AS (`,
        `  SELECT [AGG](${metricCol}) AS metric_value`,
        `  FROM [primary_table]`,
        `  WHERE ${prevPeriodFilter(dateCol, dialect)}`,
        `)`,
        `SELECT`,
        `  c.metric_value,`,
        `  p.metric_value AS prev_value,`,
        `  ROUND(${pctChange("c.metric_value", "p.metric_value", dialect)}, 2) AS pct_change`,
        `FROM current_p c, prev_p p`,
      ].join("\n");
    } else {
      template = [
        `SELECT [AGG](${metricCol}) AS metric_value`,
        `FROM [primary_table]`,
        hasDate ? `WHERE [optional: ${dateCol} >= date_filter]` : "",
      ].filter(Boolean).join("\n");
    }

    return {
      shape: `1 row — { metric_value: number${periodComparison ? ", prev_value: number, pct_change: number" : ""} }`,
      rowLimit: 1,
      fullHint: [
        `WIDGET CONTRACT (kpi) — Dialect: ${dialect.toUpperCase()}`,
        `  Output shape: { metric_value: number${periodComparison ? ", prev_value: number, pct_change: number" : ""} } — EXACTLY 1 ROW`,
        `  REQUIRED: Single aggregation — COUNT(*), SUM(), AVG(), or MAX()`,
        `  AGGREGATION RULE: Only SUM additive measures (revenue, amount, quantity). Never SUM a rate/ratio column — recompute as numerator / NULLIF(denominator, 0).`,
        `  FORBIDDEN: Raw rows, ORDER BY, LIMIT/TOP, pagination`,
        hasDate && periodComparison
          ? `  PERIOD COMPARISON: CTE with current-month vs previous-month on column ${dateCol}. Include pct_change = (current - prev) / prev * 100.`
          : hasDate
          ? `  DATE SCOPE: Filter by ${dateCol} to the relevant time period`
          : "",
        `  ${dateFnHint}`,
        `  SQL TEMPLATE:\n${indent(template)}`,
      ].filter(Boolean).join("\n"),
    };
  }

  // ── Bar / Column ───────────────────────────────────────────────────────────
  if (typ === "bar" || typ === "column") {
    const template = isMssql
      ? `SELECT ${topPrefix}${dimCol} AS dimension, [AGG](${metricCol}) AS metric_value\nFROM [primary_table]\n[WHERE optional_filter]\nGROUP BY ${dimCol}\nORDER BY metric_value DESC`
      : `SELECT ${dimCol} AS dimension, [AGG](${metricCol}) AS metric_value\nFROM [primary_table]\n[WHERE optional_filter]\nGROUP BY ${dimCol}\nORDER BY metric_value DESC\n${limitSuffix}`;

    return {
      shape: `N rows (max ${limitN}) — { dimension: string, metric_value: number }`,
      rowLimit: limitN,
      fullHint: [
        `WIDGET CONTRACT (bar) — Dialect: ${dialect.toUpperCase()}`,
        `  Output shape: { dimension: string, metric_value: number } — max ${limitN} rows`,
        `  REQUIRED: GROUP BY ${dimCol}`,
        `  REQUIRED: ORDER BY metric_value DESC — highest bars first`,
        `  REQUIRED: Hard row cap — ${isMssql ? `TOP ${limitN}` : `LIMIT ${limitN}`} — never return unbounded rows`,
        `  AGGREGATION RULE: SUM for additive measures, COUNT(*) for volumes. Avoid high-cardinality columns as GROUP BY dimensions.`,
        `  JOIN SAFETY: If joining tables, aggregate BEFORE the join when the relationship is 1-to-many — prevents row fan-out inflating SUM.`,
        `  FORBIDDEN: SELECT * or ungrouped raw rows`,
        `  ${dateFnHint}`,
        `  SQL TEMPLATE:\n${indent(template)}`,
      ].join("\n"),
    };
  }

  // ── Pie / Donut ────────────────────────────────────────────────────────────
  if (typ === "pie" || typ === "donut") {
    const hardLimit = Math.min(limitN, 10);
    const { prefix: tpfx, suffix: tsuffix } = topNClause(hardLimit, dialect);
    const template = isMssql
      ? `SELECT ${tpfx}${dimCol} AS slice_label, [AGG](${metricCol}) AS slice_value\nFROM [primary_table]\n[WHERE optional_filter]\nGROUP BY ${dimCol}\nORDER BY slice_value DESC`
      : `SELECT ${dimCol} AS slice_label, [AGG](${metricCol}) AS slice_value\nFROM [primary_table]\n[WHERE optional_filter]\nGROUP BY ${dimCol}\nORDER BY slice_value DESC\n${tsuffix}`;

    return {
      shape: `N rows (max ${hardLimit}) — { slice_label: string, slice_value: number }`,
      rowLimit: hardLimit,
      fullHint: [
        `WIDGET CONTRACT (pie) — Dialect: ${dialect.toUpperCase()}`,
        `  Output shape: { slice_label: string, slice_value: number } — STRICT max ${hardLimit} rows`,
        `  REQUIRED: GROUP BY ${dimCol}`,
        `  REQUIRED: ORDER BY slice_value DESC`,
        `  CRITICAL: ${isMssql ? `TOP ${hardLimit}` : `LIMIT ${hardLimit}`} — pie charts are unreadable with more than 10 slices`,
        `  FORBIDDEN: More than 10 slices — collapse long tails into an "Other" group if needed`,
        `  ${dateFnHint}`,
        `  SQL TEMPLATE:\n${indent(template)}`,
      ].join("\n"),
    };
  }

  // ── Line / Area ────────────────────────────────────────────────────────────
  if (typ === "line" || typ === "area") {
    const bucketExpr = primaryDate
      ? dateTruncExpr(dateCol, granularity || "monthly", dialect)
      : dialect === "mssql"
      ? `CAST(${dateCol} AS date)`
      : dialect === "mysql"
      ? `DATE(${dateCol})`
      : `DATE_TRUNC('day', ${dateCol})`;

    const template = [
      `SELECT`,
      `  ${bucketExpr} AS time_bucket,`,
      `  [AGG](${metricCol}) AS metric_value`,
      `FROM [primary_table]`,
      primaryDate ? `[WHERE ${dateCol} >= [start_date]]` : "",
      `GROUP BY ${bucketExpr}`,
      `ORDER BY time_bucket ASC`,
      limitSuffix || (isMssql ? `-- add TOP ${limitN} to the SELECT clause if needed` : ""),
    ].filter(Boolean).join("\n");

    return {
      shape: `N rows (max ${limitN}) — { time_bucket: date, metric_value: number }`,
      rowLimit: limitN,
      fullHint: [
        `WIDGET CONTRACT (line) — Dialect: ${dialect.toUpperCase()}`,
        `  Output shape: { time_bucket: date, metric_value: number } — chronological ASC`,
        `  REQUIRED: Time bucket — ${bucketExpr} AS time_bucket`,
        `  REQUIRED: GROUP BY the same time-bucket expression (not the raw column)`,
        `  REQUIRED: ORDER BY time_bucket ASC — series must be chronological`,
        `  GRANULARITY: ${granularity || "monthly"} — use monthly for ranges > 90 days, daily for < 30 days`,
        primaryDate ? `  DATE COLUMN: ${dateCol}` : "",
        `  ${dateFnHint}`,
        `  SQL TEMPLATE:\n${indent(template)}`,
      ].filter(Boolean).join("\n"),
    };
  }

  // ── Funnel ─────────────────────────────────────────────────────────────────
  if (typ === "funnel") {
    const stageCol = dimCol;
    let template: string;

    if (isMssql) {
      template = [
        `WITH stage_counts AS (`,
        `  SELECT`,
        `    ${stageCol} AS stage,`,
        `    COUNT(*) AS stage_count`,
        `  FROM [primary_table]`,
        `  [WHERE optional_filter]`,
        `  GROUP BY ${stageCol}`,
        `),`,
        `totals AS (SELECT SUM(stage_count) AS grand_total FROM stage_counts)`,
        `SELECT`,
        `  s.stage,`,
        `  s.stage_count,`,
        `  ROUND(100.0 * s.stage_count / t.grand_total, 2) AS pct_of_total`,
        `FROM stage_counts s, totals t`,
        `ORDER BY s.stage_count DESC`,
      ].join("\n");
    } else {
      template = [
        `WITH stage_counts AS (`,
        `  SELECT`,
        `    ${stageCol} AS stage,`,
        `    COUNT(*) AS stage_count`,
        `  FROM [primary_table]`,
        `  [WHERE optional_filter]`,
        `  GROUP BY ${stageCol}`,
        `)`,
        `SELECT`,
        `  stage,`,
        `  stage_count,`,
        `  ROUND(100.0 * stage_count / SUM(stage_count) OVER (), 2) AS pct_of_total`,
        `FROM stage_counts`,
        `ORDER BY stage_count DESC`,
        limitSuffix,
      ].filter(Boolean).join("\n");
    }

    return {
      shape: `N rows (max ${limitN}) — { stage: string, stage_count: number, pct_of_total: number }`,
      rowLimit: limitN,
      fullHint: [
        `WIDGET CONTRACT (funnel) — Dialect: ${dialect.toUpperCase()}`,
        `  Output shape: { stage: string, stage_count: number, pct_of_total: number }`,
        `  REQUIRED: GROUP BY ${stageCol} — one row per stage in the funnel`,
        `  REQUIRED: pct_of_total — ${isMssql ? "CTE grand total division" : "SUM(stage_count) OVER () window function"} — percent share of all events`,
        `  REQUIRED: ORDER BY stage_count DESC — widest stage first (visualizer handles semantic ordering)`,
        `  FORBIDDEN: Raw event rows — must aggregate per stage only`,
        `  ${dateFnHint}`,
        `  SQL TEMPLATE:\n${indent(template)}`,
      ].join("\n"),
    };
  }

  // ── Scatter ────────────────────────────────────────────────────────────────
  if (typ === "scatter") {
    const groupCol = dimCol;
    const template = [
      `SELECT`,
      `  ${groupCol} AS entity,`,
      `  [AGG](${metricCol}) AS x_metric,`,
      `  [AGG](${metric2Col}) AS y_metric`,
      `FROM [primary_table]`,
      `[WHERE optional_filter]`,
      `GROUP BY ${groupCol}`,
      `HAVING [AGG](${metricCol}) IS NOT NULL AND [AGG](${metric2Col}) IS NOT NULL`,
      `ORDER BY x_metric DESC`,
      limitSuffix || (isMssql ? `-- add TOP ${limitN} to the SELECT clause if needed` : ""),
    ].filter(Boolean).join("\n");

    return {
      shape: `N rows (max ${limitN}) — { entity: string, x_metric: number, y_metric: number }`,
      rowLimit: limitN,
      fullHint: [
        `WIDGET CONTRACT (scatter) — Dialect: ${dialect.toUpperCase()}`,
        `  Output shape: { entity: string, x_metric: number, y_metric: number } — exactly 2 distinct numeric axes`,
        `  REQUIRED: Exactly 2 different metric columns as x_metric and y_metric`,
        `  REQUIRED: GROUP BY ${groupCol} (the unit of analysis — customer, product, region, etc.)`,
        `  REQUIRED: HAVING to exclude null rows — scatter with null/zero values obscures correlation`,
        `  AGGREGATION RULE: Both axes must use proper AGG (SUM/AVG). Never use two rate/ratio columns directly — compute from numerator/denominator.`,
        `  JOIN SAFETY: If joining, aggregate BEFORE the join to prevent row fan-out.`,
        `  FORBIDDEN: Raw event rows — must aggregate per entity`,
        `  ${dateFnHint}`,
        `  SQL TEMPLATE:\n${indent(template)}`,
      ].join("\n"),
    };
  }

  // ── Cohort ─────────────────────────────────────────────────────────────────
  if (typ === "cohort") {
    const cohortDateCol = primaryDate || "<signup_date_column>";
    const cohortBucket = dateTruncExpr(cohortDateCol, "monthly", dialect);

    let periodDiffExpr: string;
    switch (dialect) {
      case "mssql":
        periodDiffExpr = `DATEDIFF(month, c.cohort_month, DATEADD(month, DATEDIFF(month, 0, evt.[activity_date]), 0))`;
        break;
      case "mysql":
        periodDiffExpr = `TIMESTAMPDIFF(MONTH, c.cohort_month, DATE_FORMAT(evt.[activity_date], '%Y-%m-01'))`;
        break;
      case "bigquery":
        periodDiffExpr = `DATE_DIFF(DATE_TRUNC(evt.[activity_date], MONTH), c.cohort_month, MONTH)`;
        break;
      default: // postgres, snowflake
        periodDiffExpr = `EXTRACT(YEAR FROM AGE(DATE_TRUNC('month', evt.[activity_date]), c.cohort_month))::INT * 12\n      + EXTRACT(MONTH FROM AGE(DATE_TRUNC('month', evt.[activity_date]), c.cohort_month))::INT`;
    }

    const template = [
      `WITH cohorts AS (`,
      `  -- Identify each user's cohort month (first-touch or signup date)`,
      `  SELECT`,
      `    ${cohortBucket} AS cohort_month,`,
      `    [user_id_column] AS user_id`,
      `  FROM [primary_table]`,
      `  GROUP BY ${cohortBucket}, [user_id_column]`,
      `)`,
      `SELECT`,
      `  c.cohort_month,`,
      `  ${periodDiffExpr} AS period_number,`,
      `  COUNT(DISTINCT evt.[user_id_column]) AS retained_users`,
      `FROM [events_or_activity_table] evt`,
      `JOIN cohorts c ON evt.[user_id_column] = c.user_id`,
      `[WHERE optional_date_range_filter]`,
      `GROUP BY c.cohort_month, period_number`,
      `ORDER BY c.cohort_month ASC, period_number ASC`,
      limitSuffix || (isMssql ? `-- add TOP ${limitN} to the outer SELECT if needed` : ""),
    ].filter(Boolean).join("\n");

    return {
      shape: `N rows (max ${limitN}) — { cohort_month: date, period_number: number, retained_users: number }`,
      rowLimit: limitN,
      fullHint: [
        `WIDGET CONTRACT (cohort) — Dialect: ${dialect.toUpperCase()}`,
        `  Output shape: { cohort_month: date, period_number: number, retained_users: number }`,
        `  REQUIRES 2 temporal columns: one for signup/first-touch (cohort) and one for subsequent activity/event date`,
        `  REQUIRED: cohort_month — DATE_TRUNC to month grain on the signup/first-touch date`,
        `  REQUIRED: period_number — integer months elapsed since the cohort month (0 = acquisition month)`,
        `  REQUIRED: COUNT(DISTINCT user_id) — unique retained users, never COUNT(*) which double-counts events`,
        `  REQUIRED: JOIN the events/activity table back to cohorts to get cross-period data`,
        `  FORBIDDEN: Grouping on raw event rows — must aggregate by cohort_month + period_number`,
        `  ${dateFnHint}`,
        `  SQL TEMPLATE:\n${indent(template)}`,
      ].join("\n"),
    };
  }

  // ── Map ────────────────────────────────────────────────────────────────────
  if (typ === "map") {
    const geoCol = dimCol;
    const { prefix: mpfx, suffix: msuffix } = topNClause(limitN, dialect);
    const template = isMssql
      ? [
          `SELECT ${mpfx}${geoCol} AS geo_dimension,`,
          `  [AGG](${metricCol}) AS metric_value`,
          `FROM [primary_table]`,
          `[WHERE optional_filter]`,
          `  AND ${geoCol} IS NOT NULL`,
          `  AND ${geoCol} <> ''`,
          `GROUP BY ${geoCol}`,
          `ORDER BY metric_value DESC`,
        ].join("\n")
      : [
          `SELECT ${geoCol} AS geo_dimension,`,
          `  [AGG](${metricCol}) AS metric_value`,
          `FROM [primary_table]`,
          `[WHERE optional_filter]`,
          `  AND ${geoCol} IS NOT NULL`,
          `  AND ${geoCol} <> ''`,
          `GROUP BY ${geoCol}`,
          `ORDER BY metric_value DESC`,
          msuffix,
        ].filter(Boolean).join("\n");

    return {
      shape: `N rows (max ${limitN}) — { geo_dimension: string, metric_value: number }`,
      rowLimit: limitN,
      fullHint: [
        `WIDGET CONTRACT (map) — Dialect: ${dialect.toUpperCase()}`,
        `  Output shape: { geo_dimension: string, metric_value: number } — geographic dimension + metric`,
        `  REQUIRED: GROUP BY ${geoCol}`,
        `  REQUIRED: ORDER BY metric_value DESC`,
        `  REQUIRED: Filter NULL and empty geo values — WHERE ${geoCol} IS NOT NULL AND ${geoCol} <> ''`,
        `  GEO FORMAT: Return ISO 3166-1 alpha-2 country codes (US, GB, DE) or region/state names that the map renderer can geocode`,
        `  FORBIDDEN: Raw address strings or free-text location fields — use the dedicated geographic dimension column`,
        `  ${dateFnHint}`,
        `  SQL TEMPLATE:\n${indent(template)}`,
      ].join("\n"),
    };
  }

  // ── Table ──────────────────────────────────────────────────────────────────
  if (typ === "table") {
    const { filterableColumns: fcols, visibleColumnNames: visCols } = input;

    // First visible column drives the default sort order
    const firstSortCol = visCols?.[0] ?? "id";

    // Build per-column optional filter blocks from schema filterableColumns
    const filterBlocks: string[] = [];
    if (fcols) {
      for (const [table, cols] of Object.entries(fcols)) {
        for (const col of (cols || [])) {
          const isDate = /date|time|created|updated|_at$|timestamp|day|month|year|week|period/i.test(col);
          if (isDate) {
            filterBlocks.push(
              `  AND ({{__has.${table}.${col}.from}} = 0 OR ${col} >= {{${table}.${col}.from}})`,
              `  AND ({{__has.${table}.${col}.to}} = 0 OR ${col} <= {{${table}.${col}.to}})`
            );
          } else {
            filterBlocks.push(
              `  AND ({{__has.${table}.${col}}} = 0 OR ${col} = {{${table}.${col}}})`
            );
          }
        }
      }
    }

    const whereBlock = filterBlocks.length > 0
      ? `WHERE 1=1\n${filterBlocks.join("\n")}`
      : `[WHERE optional_filter]`;

    // SELECT list from schema-visible columns, or placeholder if unknown
    const selectList = visCols && visCols.length > 0
      ? visCols.map((c) => `  ${c}`).join(",\n")
      : `  [explicit_columns — never SELECT *]`;

    const template = [
      `SELECT`,
      `  COUNT(*) OVER() AS total_count,`,
      selectList,
      `FROM [primary_table]`,
      whereBlock,
      `ORDER BY {{sort_col:${firstSortCol}}} {{sort_dir:ASC}}`,
      paginationSQL,
    ].join("\n");

    const filterNote = filterBlocks.length > 0
      ? `  FILTER TOKENS: {{__has.table.col}} = 0 means "filter not applied" — pattern: AND ({{__has.t.col}} = 0 OR col = {{t.col}})`
      : `  OPTIONAL FILTERS: Add WHERE conditions using {{__has.table.col}} = 0 OR col = {{table.col}} pattern for runtime filters`;

    return {
      shape: `M rows — { total_count: number, ...selected_columns }`,
      rowLimit: 25,
      fullHint: [
        `WIDGET CONTRACT (table) — Dialect: ${dialect.toUpperCase()}`,
        `  Output shape: { total_count: number, ...columns } — paginated rows`,
        `  REQUIRED: COUNT(*) OVER() AS total_count — window function, NOT a GROUP BY aggregate`,
        `  REQUIRED PAGINATION: ${paginationSQL}`,
        `  REQUIRED: ORDER BY {{sort_col:${firstSortCol}}} {{sort_dir:ASC}} — template placeholders for dynamic sort`,
        `  FORBIDDEN: ORDER BY with a fixed column name — always use {{sort_col}} placeholder`,
        `  FORBIDDEN: SELECT * — list these columns explicitly: ${visCols?.join(", ") ?? "4–8 key columns"}`,
        `  FORBIDDEN: Missing COUNT(*) OVER() — the UI requires this for pagination controls`,
        filterNote,
        `  ${dateFnHint}`,
        `  SQL TEMPLATE:\n${indent(template)}`,
      ].join("\n"),
    };
  }

  // ── Default fallback ───────────────────────────────────────────────────────
  return {
    shape: `N rows — data for visualization`,
    rowLimit: limitN,
    fullHint: [
      `WIDGET CONTRACT (${typ}) — Dialect: ${dialect.toUpperCase()}`,
      `  GROUP BY dimension, aggregate metric, ORDER BY metric DESC`,
      `  Hard row cap: ${isMssql ? `TOP ${limitN}` : `LIMIT ${limitN}`}`,
      `  ${dateFnHint}`,
    ].join("\n"),
  };
}

/**
 * Infers primaryDate, primaryMetric, and primaryDimension from the widget's
 * `uses` field (comma-separated `table.column` refs from the planner).
 * Used as a fallback when explicit fields are not set on the widget.
 */
function inferColsFromUses(uses: string | null | undefined): {
  primaryDate: string | null;
  primaryMetric: string | null;
  primaryDimension: string | null;
} {
  if (!uses) return { primaryDate: null, primaryMetric: null, primaryDimension: null };
  const refs = String(uses).split(",").map((s) => s.trim()).filter((s) => s.includes("."));
  let primaryDate: string | null = null;
  let primaryMetric: string | null = null;
  let primaryDimension: string | null = null;
  for (const ref of refs) {
    const col = (ref.split(".")[1] || "").toLowerCase();
    if (!primaryDate && /date|time|created|updated|_at$|timestamp|day|month|year|week|period/i.test(col)) {
      primaryDate = ref;
    } else if (!primaryMetric && /(amount|revenue|cost|price|qty|quantity|count|total|value|sales|profit|score|metric|sum|avg)/i.test(col)) {
      primaryMetric = ref;
    } else if (!primaryDimension && /status|type|category|segment|country|region|city|department|team|plan|tier|channel|stage|source/i.test(col)) {
      primaryDimension = ref;
    }
  }
  return { primaryDate, primaryMetric, primaryDimension };
}

/**
 * Extracts contract-relevant fields from a planner widget object.
 * Accepts a connectorType string (preferred) or a legacy boolean isMssql.
 */
export function contractInputFromWidget(
  widget: any,
  connectorTypeOrIsMssql: string | boolean,
  schemaForPrompt?: any
): WidgetContractInput {
  const isMssqlBool = typeof connectorTypeOrIsMssql === "boolean" ? connectorTypeOrIsMssql : false;
  const connType = typeof connectorTypeOrIsMssql === "string" ? connectorTypeOrIsMssql : undefined;
  const inferred = inferColsFromUses(widget?.uses);
  const widgetType = String(widget?.type || "bar").toLowerCase();

  // For table widgets, extract filterableColumns and visibleColumnNames from schema
  let filterableColumns: Record<string, string[]> | null = null;
  let visibleColumnNames: string[] | null = null;
  if (widgetType === "table" && schemaForPrompt) {
    filterableColumns = schemaForPrompt?.filterableColumns || null;
    const schemaVisibleCols: Record<string, string[]> = schemaForPrompt?.visibleColumns || {};
    const primaryTable = String(widget?.primaryTable || "").trim();
    if (primaryTable && Array.isArray(schemaVisibleCols[primaryTable]) && schemaVisibleCols[primaryTable].length > 0) {
      visibleColumnNames = schemaVisibleCols[primaryTable];
    } else if (widget?.uses) {
      // Fallback: parse visible column names from widget.uses refs for the primary table
      const refs = String(widget.uses).split(",").map((s: string) => s.trim()).filter((s: string) => s.includes("."));
      const tableName = primaryTable || (refs[0]?.split(".")[0] ?? "");
      const cols = refs
        .filter((r: string) => tableName && r.startsWith(`${tableName}.`))
        .map((r: string) => r.split(".")[1])
        .filter(Boolean);
      if (cols.length > 0) visibleColumnNames = cols;
    }
  }

  return {
    widgetType,
    isMssql: isMssqlBool,
    connectorType: connType,
    primaryDate: widget?.primaryDate || inferred.primaryDate || null,
    primaryMetric: widget?.primaryMetric || inferred.primaryMetric || null,
    secondaryMetric: widget?.secondaryMetric || null,
    primaryDimension: widget?.primaryDimension || inferred.primaryDimension || null,
    granularity: widget?.granularity || "monthly",
    rowLimit: typeof widget?.rowLimit === "number" ? widget.rowLimit : null,
    periodComparison: Boolean(widget?.periodComparison),
    filterableColumns,
    visibleColumnNames,
  };
}

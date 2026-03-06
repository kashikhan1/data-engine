import type { SchemaCapabilities } from "../../agents/planner/schema-capabilities";

const isTrendQuery = (query: string): boolean => {
  const q = query.toLowerCase();
  return q.includes("trend") || q.includes("over time") || q.includes("daily") || q.includes("weekly") || q.includes("monthly") || q.includes("quarterly") || q.includes("yearly");
};

const isComparisonQuery = (query: string): boolean => {
  const q = query.toLowerCase();
  return q.includes("top") || q.includes("compare") || q.includes("breakdown") || q.includes("rank") || q.includes("vs") || q.includes("versus") || q.includes("by ");
};

const isFunnelQuery = (query: string): boolean => {
  const q = query.toLowerCase();
  return q.includes("funnel") || q.includes("conversion") || q.includes("stage") || q.includes("drop-off") || q.includes("pipeline");
};

const isGeoQuery = (query: string): boolean => {
  const q = query.toLowerCase();
  return q.includes("country") || q.includes("region") || q.includes("location") || q.includes("map") || q.includes("city") || q.includes("state") || q.includes("territory");
};

const isRateMetricQuery = (query: string): boolean => {
  const q = query.toLowerCase();
  return q.includes("rate") || q.includes("ratio") || q.includes("percent") || q.includes("%") || q.includes("churn") || q.includes("ctr") || q.includes("conversion rate");
};

const isPeriodComparisonQuery = (query: string): boolean => {
  const q = query.toLowerCase();
  return q.includes("mom") || q.includes("yoy") || q.includes("vs last") || q.includes("previous") || q.includes("period over period") || q.includes("compared to last");
};

export function buildDataScientistGuidance(query: string, capabilities?: SchemaCapabilities): string {
  const hints: string[] = [
    "Data scientist policy:",
    "- Choose aggregations that match metric semantics: SUM for additive measures (revenue, quantity), AVG for intensive measures (price, rate), COUNT/COUNT DISTINCT for volume.",
    "- Non-additive metrics (rates, ratios, percentages) MUST NOT be SUMmed across rows — always recompute the ratio from its numerator and denominator.",
    "- AVG over NULLs silently under-counts the denominator — use COALESCE or filter NULLs explicitly when the NULL represents zero, not absence.",
    "- JOIN fan-out is the #1 silent data correctness bug: a 1-to-many JOIN inflates SUM aggregations by the row multiplication factor. Always aggregate BEFORE joining, or use subqueries/CTEs.",
  ];

  if (isTrendQuery(query) && (!capabilities || capabilities.temporalColumns.length > 0)) {
    hints.push("- For time-series: choose granularity deliberately (daily for <30d, weekly for 1-6mo, monthly for >6mo queries).");
    hints.push("- Use DATE_TRUNC / period bucketing rather than raw timestamps to group by clean periods.");
  }

  if (isPeriodComparisonQuery(query)) {
    hints.push("- Period-over-period comparisons: compute BOTH periods in one query using conditional aggregation (CASE WHEN period = current THEN metric END) or a self-join — do not submit two separate queries.");
    hints.push("- Prefer WoW, MoM, or YoY framing depending on query scope; label the delta and % change.");
  }

  if (isRateMetricQuery(query)) {
    hints.push("- Rate metrics (churn rate, CTR, conversion rate): always express as 100.0 * numerator / NULLIF(denominator, 0) to guard against divide-by-zero.");
    hints.push("- Never SUM a rate column — always recompute from base counts.");
  }

  if (isComparisonQuery(query) && (!capabilities || capabilities.categoricalColumns.length > 0)) {
    hints.push("- Ranked comparisons: use TOP N / LIMIT with ORDER BY metric DESC. Include a catch-all 'Other' bucket using CASE WHEN rank > N THEN 'Other' for completeness.");
    hints.push("- For bar charts, sort by value descending so the highest-impact categories are immediately visible.");
  }

  if (isFunnelQuery(query) && (!capabilities || capabilities.funnelColumns.length > 0)) {
    hints.push("- Funnel stages MUST be ordered semantically, not alphabetically. Compute the absolute count and drop-off % at each stage.");
    hints.push("- Conversion rate between stages = 100.0 * stage_n_count / NULLIF(stage_n_minus_1_count, 0).");
  }

  if (isGeoQuery(query) && (!capabilities || capabilities.geographicColumns.length > 0)) {
    hints.push("- Geographic rollups: prefer ISO country codes / standardized region names over raw text to enable map matching.");
    hints.push("- Suppress geographies with fewer than 5 data points — small-sample outliers distort geographic views.");
  }

  if (capabilities && capabilities.numericColumns.length > 0) {
    hints.push("- For KPI metrics: include a secondary comparison (vs prior period or vs target) whenever temporal columns exist to give the number business context.");
  }

  hints.push("- Prefer statistically meaningful signals over decorative charts. Fewer, high-quality widgets outperform many weak ones.");

  return hints.join("\n");
}

export function buildDataEngineeringGuidance(): string {
  return [
    "Data engineering policy:",
    "- Use schema-valid columns only; never invent or hallucinate field names.",
    "- Always project only necessary columns — no SELECT *.",
    "- Aggregate in subqueries or CTEs before joining to avoid row multiplication (join fan-out). Pattern: WITH agg AS (SELECT ... GROUP BY ...) SELECT ... FROM agg JOIN ...",
    "- For dashboard queries, avoid correlated subqueries in SELECT lists — they execute once per row and destroy latency at scale.",
    "- Materialize heavy aggregations in CTEs at the top; reference the CTE multiple times rather than re-computing.",
    "- Pagination hint for table widgets: include ORDER BY + LIMIT/OFFSET or ROW_NUMBER() OVER() rather than returning unbounded result sets.",
    "- Favor join-light, stable aggregations; dashboards are read at high frequency — every unnecessary join is latency debt.",
  ].join("\n");
}

export function buildDatabaseExpertGuidance(connectorType: string): string {
  const lower = connectorType.toLowerCase();
  const isMssql = lower.includes("mssql") || lower.includes("sqlserver") || lower.includes("sql server");
  const isMysql = lower.includes("mysql") || lower.includes("mariadb");
  const isBigQuery = lower.includes("bigquery");
  const isSnowflake = lower.includes("snowflake");

  const lines = [
    "Database expert policy:",
    "- Use connector-correct SQL idioms — mixing dialects is a hard syntax error.",
    "- Never apply a function to an indexed column in a WHERE predicate (e.g. WHERE YEAR(created_at) = 2024 defeats the index; use WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01' instead).",
    "- Avoid implicit type casts in JOIN conditions — ensure both sides share the same data type.",
    "- Use NULLIF(denominator, 0) to prevent divide-by-zero in computed ratio columns.",
  ];

  if (isMssql) {
    lines.push("- SQL Server: use GETDATE() / DATEADD / DATEDIFF / FORMAT / CONVERT. Avoid DATE_TRUNC (PostgreSQL) and DATE_FORMAT (MySQL).");
    lines.push("- SQL Server: use TOP N instead of LIMIT. Use ROW_NUMBER() OVER(ORDER BY ...) for ranked lists.");
    lines.push("- SQL Server: use ISNULL(col, default) or COALESCE. String concat with + requires explicit CAST to VARCHAR.");
  } else if (isMysql) {
    lines.push("- MySQL/MariaDB: use DATE_FORMAT, DATE_ADD, DATEDIFF, NOW(). Avoid DATE_TRUNC (not available in MySQL < 8.0).");
    lines.push("- MySQL: use LIMIT N for top-N queries. GROUP_CONCAT for string aggregation.");
    lines.push("- MySQL: IFNULL(col, default) or COALESCE. Beware implicit GROUP BY rules — always explicitly list non-aggregate SELECT columns in GROUP BY.");
  } else if (isBigQuery) {
    lines.push("- BigQuery: use DATE_TRUNC(date_col, MONTH/WEEK/YEAR), TIMESTAMP_TRUNC, DATE_SUB, CURRENT_DATE().");
    lines.push("- BigQuery: use APPROX_COUNT_DISTINCT for high-cardinality counts in dashboards — far faster than COUNT(DISTINCT) on large tables.");
    lines.push("- BigQuery: partition pruning — always filter on the partition column (usually a DATE/TIMESTAMP) to avoid full-table scans.");
    lines.push("- BigQuery: use SAFE_DIVIDE(numerator, denominator) to handle zero-division gracefully.");
  } else if (isSnowflake) {
    lines.push("- Snowflake: use DATE_TRUNC('month', col), DATEADD, DATEDIFF, CURRENT_DATE(), TO_DATE().");
    lines.push("- Snowflake: use QUALIFY ROW_NUMBER() OVER(PARTITION BY ... ORDER BY ...) = 1 for deduplication instead of subqueries.");
    lines.push("- Snowflake: ZEROIFNULL / IFF(denom = 0, NULL, num / denom) for safe division.");
  } else {
    // Default PostgreSQL
    lines.push("- PostgreSQL: use DATE_TRUNC('month', col), CURRENT_DATE, NOW(), INTERVAL '30 days'. Avoid SQL Server DATEADD/DATEDIFF syntax.");
    lines.push("- PostgreSQL: use LIMIT N for top-N. For ranked lists use ROW_NUMBER() OVER(ORDER BY metric DESC).");
    lines.push("- PostgreSQL: COALESCE(col, default), NULLIF(val, 0). Use FILTER (WHERE ...) clause in aggregate functions for conditional aggregation.");
  }

  lines.push("- Avoid SELECT * in analytical queries; project only necessary columns for both correctness and performance.");

  return lines.join("\n");
}

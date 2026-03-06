/* eslint-disable @typescript-eslint/no-explicit-any */
import { getSchemaColumns, getColumnName, getColumnType } from "./schema-utils";
import type { GroundedSchema } from "./types";

// ── Column semantic patterns ──────────────────────────────────────────────────

const TEMPORAL_NAME = /date|time|created|updated|_at$|_at_|timestamp|day|month|year|week|period/i;
const TEMPORAL_TYPE = /date|time|timestamp/i;
const NUMERIC_TYPE = /int|float|double|decimal|numeric|number|money|bigint|smallint|real|currency/i;
const CATEGORICAL_NAME = /status|type|category|kind|tier|plan|stage|step|phase|group|class|role|level|label|tag/i;
const GEO_NAME = /country|state|city|region|zip|postal|lat|lon|latitude|longitude|location|geo|province|territory/i;
const FUNNEL_NAME = /status|stage|step|phase|funnel|pipeline|progress|state|conversion/i;

/**
 * Patterns that identify numeric columns that are IDs or foreign keys —
 * these should NOT be SUM'd or averaged; they are keys, not measures.
 */
const ID_NUMERIC_NAME = /^id$|_id$|^fk_|^pk_|user_id|order_id|customer_id|product_id|account_id|session_id|transaction_id/i;

/**
 * Patterns that identify ratio/rate/percentage columns — these are non-additive.
 * They must NOT be SUMmed; always recompute from numerator/denominator.
 */
const RATE_METRIC_NAME = /rate|ratio|pct|percent|churn|ctr|conversion_rate|retention|utilization|margin|efficiency/i;

/**
 * Patterns for columns that are genuine, directly-aggregatable measures.
 */
const MEASURE_NAME = /revenue|amount|total|price|cost|fee|spend|gmv|mrr|arr|quantity|count|volume|sales|profit|balance|value|earnings|income|gross|net|budget|quota/i;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Schema-derived data capabilities used to constrain widget type selection.
 * Computed once from the grounded schema — no LLM call required.
 */
export type SchemaCapabilities = {
  /** Subset of allowedTypes that the schema data can actually support */
  feasibleWidgetTypes: string[];
  /** "table.col" refs detected as temporal — enables line, area, cohort */
  temporalColumns: string[];
  /** All "table.col" refs with numeric storage type */
  numericColumns: string[];
  /**
   * Numeric columns that are genuine additive measures (revenue, quantity, cost, etc.)
   * and safe to SUM or AVG. Excludes ID-like and rate/ratio columns.
   */
  metricColumns: string[];
  /**
   * Numeric columns detected as rate/ratio/percentage — non-additive.
   * Should be recomputed from numerator/denominator, not summed.
   */
  rateColumns: string[];
  /** "table.col" refs detected as categorical — enables pie, donut, bar */
  categoricalColumns: string[];
  /** "table.col" refs detected as geographic — enables map */
  geographicColumns: string[];
  /** "table.col" refs detected as funnel/stage — enables funnel */
  funnelColumns: string[];
  /**
   * High-cardinality categorical columns (email, name, free-text IDs).
   * Useful as filter options but not recommended for GROUP BY in charts.
   */
  highCardinalityCols: string[];
};

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Analyzes projected columns to determine which widget types are
 * data-feasible, replacing the static disabledWidgetTypes config approach.
 * Also classifies numeric columns by aggregation safety (metric vs ID vs rate).
 */
export function detectSchemaCapabilities(
  schema: any,
  grounded: GroundedSchema,
  allowedTypes: string[]
): SchemaCapabilities {
  const temporalColumns: string[] = [];
  const numericColumns: string[] = [];
  const metricColumns: string[] = [];
  const rateColumns: string[] = [];
  const categoricalColumns: string[] = [];
  const geographicColumns: string[] = [];
  const funnelColumns: string[] = [];
  const highCardinalityCols: string[] = [];

  for (const [table, projectedCols] of Object.entries(grounded.projectedColumnsByTable)) {
    const rawCols = getSchemaColumns(schema, table);
    const typeMap = new Map(
      rawCols.map((c) => [getColumnName(c).toLowerCase(), getColumnType(c).toLowerCase()])
    );

    for (const col of projectedCols) {
      const lower = col.toLowerCase();
      const colType = typeMap.get(lower) ?? "";
      const ref = `${table}.${col}`;

      if (TEMPORAL_NAME.test(lower) || TEMPORAL_TYPE.test(colType)) temporalColumns.push(ref);

      if (NUMERIC_TYPE.test(colType)) {
        numericColumns.push(ref);
        if (ID_NUMERIC_NAME.test(lower)) {
          // ID/FK columns — do not aggregate
        } else if (RATE_METRIC_NAME.test(lower)) {
          rateColumns.push(ref);
        } else if (MEASURE_NAME.test(lower)) {
          metricColumns.push(ref);
        } else {
          // Generic numeric — treat as metric candidate (could be a count, score, etc.)
          metricColumns.push(ref);
        }
      }

      if (CATEGORICAL_NAME.test(lower)) categoricalColumns.push(ref);
      if (GEO_NAME.test(lower)) geographicColumns.push(ref);
      if (FUNNEL_NAME.test(lower)) funnelColumns.push(ref);

      // High-cardinality signals: email, name, description, URL, UUID-like
      if (/email|name|description|url|uuid|slug|comment|note|address|text/i.test(lower)) {
        highCardinalityCols.push(ref);
      }
    }
  }

  const allowed = new Set(allowedTypes);
  const feasible = new Set<string>();

  // Always feasible with any tabular data
  if (allowed.has("bar")) feasible.add("bar");
  if (allowed.has("table")) feasible.add("table");
  if (allowed.has("markdown")) feasible.add("markdown");

  // Requires additive metric columns (IDs and rate/ratio-only schemas should not force KPI widgets)
  if (metricColumns.length > 0 && allowed.has("kpi")) feasible.add("kpi");

  // Requires temporal columns
  if (temporalColumns.length > 0) {
    if (allowed.has("line")) feasible.add("line");
    if (allowed.has("area")) feasible.add("area");
    if (allowed.has("cohort")) feasible.add("cohort");
  }

  // Requires categorical columns
  if (categoricalColumns.length > 0) {
    if (allowed.has("donut")) feasible.add("donut");
    if (allowed.has("pie")) feasible.add("pie");
  }

  // Requires geographic columns
  if (geographicColumns.length > 0 && allowed.has("map")) feasible.add("map");

  // Requires funnel/stage columns
  if (funnelColumns.length > 0 && allowed.has("funnel")) feasible.add("funnel");

  // Requires 2+ aggregatable metric columns (not just any numeric)
  if (metricColumns.length >= 2 && allowed.has("scatter")) feasible.add("scatter");

  // Fallback: if detection found nothing meaningful, accept all allowed types
  if (feasible.size === 0) allowedTypes.forEach((t) => feasible.add(t));

  return {
    feasibleWidgetTypes: allowedTypes.filter((t) => feasible.has(t)), // preserve original order
    temporalColumns: temporalColumns.slice(0, 8),
    numericColumns: numericColumns.slice(0, 8),
    metricColumns: metricColumns.slice(0, 8),
    rateColumns: rateColumns.slice(0, 4),
    categoricalColumns: categoricalColumns.slice(0, 8),
    geographicColumns: geographicColumns.slice(0, 4),
    funnelColumns: funnelColumns.slice(0, 4),
    highCardinalityCols: highCardinalityCols.slice(0, 6),
  };
}

/** Returns a compact capability summary for injection into LLM prompts. */
export function formatCapabilitiesForPrompt(capabilities: SchemaCapabilities): string {
  const lines: string[] = [];
  if (capabilities.temporalColumns.length > 0)
    lines.push(`Temporal columns: ${capabilities.temporalColumns.join(", ")}`);
  if (capabilities.metricColumns.length > 0)
    lines.push(`Metric columns (safe to SUM/AVG): ${capabilities.metricColumns.join(", ")}`);
  if (capabilities.rateColumns.length > 0)
    lines.push(`Rate/ratio columns (NON-additive — recompute from numerator/denominator): ${capabilities.rateColumns.join(", ")}`);
  if (capabilities.categoricalColumns.length > 0)
    lines.push(`Categorical columns: ${capabilities.categoricalColumns.join(", ")}`);
  if (capabilities.geographicColumns.length > 0)
    lines.push(`Geographic columns: ${capabilities.geographicColumns.join(", ")}`);
  if (capabilities.funnelColumns.length > 0)
    lines.push(`Funnel/stage columns: ${capabilities.funnelColumns.join(", ")}`);
  if (capabilities.highCardinalityCols.length > 0)
    lines.push(`High-cardinality columns (avoid GROUP BY in charts): ${capabilities.highCardinalityCols.join(", ")}`);
  return lines.join("\n") || "No semantic column roles detected.";
}

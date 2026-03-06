import { type SkillDefinition } from "../registry";
import type { SchemaCapabilities } from "../../agents/planner/schema-capabilities";
import type { MetaFilterDomainResult } from "../../agents/planner/types";

// ── I/O types ─────────────────────────────────────────────────────────────────

export type WidgetSkillInput = {
  meta: Pick<MetaFilterDomainResult, "domain" | "intentLabels" | "domainGuidance">;
  capabilities: SchemaCapabilities;
  connectorType: string;
  query: string;
};

export type WidgetSkillHint = {
  /** false = caller should skip LLM entirely for this widget type */
  applicable: boolean;
  /** Up to 4 "table.col" refs the LLM should prefer for this widget */
  recommendedColumns: string[];
  /** A compact SQL idiom hint injected into the widget agent's prompt */
  sqlPattern: string;
  /** 1-2 sentence domain-aware note for the LLM */
  domainNote: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function domainNote(
  defaultNote: string,
  overrides: Record<string, string>,
  domain: string
): string {
  const key = Object.keys(overrides).find((k) => domain.toLowerCase().includes(k.toLowerCase()));
  return key ? overrides[key] : defaultNote;
}

function isMssql(connectorType: string): boolean {
  return connectorType.toLowerCase().includes("mssql");
}

function topRowsClause(connectorType: string, count: number): string {
  if (isMssql(connectorType)) return `TOP ${count} `;
  return "";
}

function limitClause(connectorType: string, count: number): string {
  if (isMssql(connectorType)) return "";
  return ` LIMIT ${count}`;
}

function chooseTemporalGrain(query: string): "day" | "week" | "month" {
  const q = query.toLowerCase();
  if (q.includes("daily") || q.includes("day")) return "day";
  if (q.includes("weekly") || q.includes("week")) return "week";
  return "month";
}

function temporalBucketSql(connectorType: string, grain: "day" | "week" | "month"): string {
  if (isMssql(connectorType)) {
    if (grain === "day") return "CAST(date_col AS date)";
    if (grain === "week") return "DATEADD(week, DATEDIFF(week, 0, date_col), 0)";
    return "DATEADD(month, DATEDIFF(month, 0, date_col), 0)";
  }
  if (grain === "day") return "DATE_TRUNC('day', date_col)";
  if (grain === "week") return "DATE_TRUNC('week', date_col)";
  return "DATE_TRUNC('month', date_col)";
}

function rollingWindowPredicate(connectorType: string, days: number): string {
  if (isMssql(connectorType)) {
    return `date_col >= DATEADD(day, -${days}, CAST(GETDATE() AS date))`;
  }
  return `date_col >= CURRENT_DATE - INTERVAL '${days} days'`;
}

/**
 * Returns the best available aggregatable numeric columns.
 * Prefers metricColumns (revenue, amount, cost, etc.) over raw numericColumns
 * which may contain ID/FK fields that should never be SUMmed.
 */
function bestMetricCols(capabilities: SchemaCapabilities, n: number): string[] {
  return (capabilities.metricColumns ?? []).slice(0, n);
}

function addIntentFlavor(note: string, query: string): string {
  const q = query.toLowerCase();
  if (q.includes("top") || q.includes("rank")) {
    return `${note} Prioritize ranked outputs and keep category lists concise.`;
  }
  if (q.includes("trend") || q.includes("over time")) {
    return `${note} Emphasize clear temporal progression and period-over-period interpretation.`;
  }
  return note;
}

// ── KPI ───────────────────────────────────────────────────────────────────────

export const kpiWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-kpi",
  description: "Domain hints for KPI widgets — single headline numeric metric with optional period comparison",
  run: async ({ capabilities, meta, connectorType, query }) => ({
    applicable: capabilities.metricColumns.length > 0,
    recommendedColumns: bestMetricCols(capabilities, 3),
    sqlPattern: `SELECT SUM(metric) AS total FROM table WHERE ${rollingWindowPredicate(connectorType, 30)}`,
    domainNote: addIntentFlavor(domainNote(
      "Show the most critical additive business metric (SUM/COUNT). Never SUM or AVG precomputed rate columns; recompute ratios from numerator/denominator. Add % change vs prior period when temporal columns exist.",
      {
        saas: "Show MRR, ARR, or active subscriber count. Recompute churn/conversion rates from counts. Add month-over-month % change.",
        ecommerce: "Show total GMV or order count. Recompute refund/conversion rates from base counts. Add day-over-day or week-over-week % change.",
        support: "Show total open tickets or average resolution time. Highlight SLA breach count.",
        marketing: "Show total leads or spend as headline KPI. Recompute conversion/CTR from clicks and impressions.",
        finance: "Show total revenue, net profit, or cash position.",
        hr: "Show headcount, attrition rate, or average tenure.",
      },
      meta.domain
    ), query),
  }),
};

// ── Line ──────────────────────────────────────────────────────────────────────

export const lineWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-line",
  description: "Domain hints for line chart widgets — trends over time",
  run: async ({ capabilities, meta, connectorType, query }) => {
    const grain = chooseTemporalGrain(query);
    const bucket = temporalBucketSql(connectorType, grain);
    return {
      applicable: capabilities.temporalColumns.length > 0,
      recommendedColumns: [
        ...capabilities.temporalColumns.slice(0, 2),
        ...bestMetricCols(capabilities, 2),
      ],
      sqlPattern: `SELECT ${bucket} AS period, SUM(metric) AS value FROM table GROUP BY 1 ORDER BY 1`,
      domainNote: addIntentFlavor(domainNote(
        "Plot the primary numeric metric over time. Use month granularity by default; week for high-frequency data.",
        {
          saas: "Plot MRR or new subscriber count trend by month.",
          ecommerce: "Plot daily or weekly revenue trend. Add a 7-day moving average.",
          support: "Plot ticket volume over time. Highlight breach rate trend.",
          marketing: "Plot impressions, clicks, or leads over time by channel.",
          finance: "Plot revenue vs expense trend or cumulative cash flow.",
        },
        meta.domain
      ), query),
    };
  },
};

// ── Bar ───────────────────────────────────────────────────────────────────────

export const barWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-bar",
  description: "Domain hints for bar chart widgets — comparisons across categories",
  run: async ({ capabilities, meta, connectorType, query }) => ({
    applicable: true,
    recommendedColumns: [
      ...capabilities.categoricalColumns.slice(0, 2),
      ...bestMetricCols(capabilities, 2),
    ],
    sqlPattern: `SELECT ${topRowsClause(connectorType, 10)}category_col, SUM(metric) AS value FROM table GROUP BY 1 ORDER BY 2 DESC${limitClause(connectorType, 10)}`,
    domainNote: addIntentFlavor(domainNote(
      "Show top-N breakdown by the most relevant categorical dimension. Sort by value descending.",
      {
        saas: "Show top plans, tiers, or customer segments by MRR or subscriber count.",
        ecommerce: "Show top products or categories by revenue or order volume.",
        support: "Show tickets by priority, category, or team.",
        marketing: "Show performance by channel or campaign.",
        finance: "Show revenue or cost by department or product line.",
        hr: "Show headcount or attrition by department or role.",
      },
      meta.domain
    ), query),
  }),
};

// ── Area ──────────────────────────────────────────────────────────────────────

export const areaWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-area",
  description: "Domain hints for area chart widgets — cumulative or stacked trends over time",
  run: async ({ capabilities, meta, connectorType, query }) => {
    const grain = chooseTemporalGrain(query);
    const bucket = temporalBucketSql(connectorType, grain);
    return {
      applicable: capabilities.temporalColumns.length > 0,
      recommendedColumns: [
        ...capabilities.temporalColumns.slice(0, 1),
        ...capabilities.categoricalColumns.slice(0, 1),
        ...bestMetricCols(capabilities, 2),
      ],
      sqlPattern:
        `SELECT ${bucket} AS period, category_col, SUM(metric) AS value FROM table GROUP BY 1, 2 ORDER BY 1`,
      domainNote: addIntentFlavor(domainNote(
        "Use stacked area to show cumulative composition over time. Best when 2-5 categories stack to a meaningful total.",
        {
          saas: "Stack MRR by plan tier to show revenue composition evolution.",
          ecommerce: "Stack revenue by product category over time.",
          marketing: "Stack spend or leads by channel over time.",
          finance: "Show cumulative revenue vs cumulative cost over time.",
        },
        meta.domain
      ), query),
    };
  },
};

// ── Donut ─────────────────────────────────────────────────────────────────────

export const donutWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-donut",
  description: "Domain hints for donut chart widgets — proportional composition with a center metric",
  run: async ({ capabilities, meta, connectorType, query }) => ({
    applicable: capabilities.categoricalColumns.length > 0,
    recommendedColumns: [
      ...capabilities.categoricalColumns.slice(0, 1),
      ...capabilities.numericColumns.slice(0, 1),
    ],
    sqlPattern: `SELECT ${topRowsClause(connectorType, 6)}category_col, COUNT(*) AS count FROM table GROUP BY 1 ORDER BY 2 DESC${limitClause(connectorType, 6)}`,
    domainNote: addIntentFlavor(domainNote(
      "Pick a low-cardinality category (3-6 slices). Center label = grand total or primary metric.",
      {
        saas: "Show subscriber distribution by plan. Limit to 4-5 plans.",
        ecommerce: "Show order share by payment method or shipping region.",
        support: "Show ticket distribution by priority (low/med/high/critical).",
        marketing: "Show lead source distribution or budget allocation by channel.",
        hr: "Show headcount by department or employment type.",
      },
      meta.domain
    ), query),
  }),
};

// ── Pie ───────────────────────────────────────────────────────────────────────

export const pieWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-pie",
  description: "Domain hints for pie chart widgets — proportional market-share or distribution",
  run: async ({ capabilities, meta, connectorType, query }) => ({
    applicable: capabilities.categoricalColumns.length > 0,
    recommendedColumns: [
      ...capabilities.categoricalColumns.slice(0, 1),
      ...capabilities.numericColumns.slice(0, 1),
    ],
    sqlPattern: `SELECT ${topRowsClause(connectorType, 5)}category_col, SUM(metric) AS value FROM table GROUP BY 1 ORDER BY 2 DESC${limitClause(connectorType, 5)}`,
    domainNote: addIntentFlavor(domainNote(
      "Use for simple 3-5 segment share breakdown where exact proportions matter more than ordering.",
      {
        saas: "Show revenue share by subscription tier.",
        ecommerce: "Show sales share by product category or region.",
        marketing: "Show budget allocation or traffic source share.",
      },
      meta.domain
    ), query),
  }),
};

// ── Scatter ───────────────────────────────────────────────────────────────────

export const scatterWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-scatter",
  description: "Domain hints for scatter chart widgets — correlation between two numeric metrics",
  run: async ({ capabilities, meta, connectorType, query }) => ({
    applicable: capabilities.numericColumns.length >= 2,
    recommendedColumns: bestMetricCols(capabilities, 3),
    sqlPattern: `SELECT ${topRowsClause(connectorType, 500)}metric_x, metric_y, optional_label FROM table${limitClause(connectorType, 500)}`,
    domainNote: addIntentFlavor(domainNote(
      "Plot correlation between two numeric columns. Use an optional label column for point identification.",
      {
        saas: "Plot LTV vs churn risk score, or trial days vs conversion rate.",
        ecommerce: "Plot order value vs purchase frequency, or discount vs return rate.",
        support: "Plot resolution time vs ticket complexity score.",
        marketing: "Plot CPL vs lead quality score by channel.",
        finance: "Plot revenue vs margin by product or customer segment.",
      },
      meta.domain
    ), query),
  }),
};

// ── Funnel ────────────────────────────────────────────────────────────────────

export const funnelWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-funnel",
  description: "Domain hints for funnel chart widgets — conversion steps via ordered stage column",
  run: async ({ capabilities, meta, query }) => ({
    applicable: capabilities.funnelColumns.length > 0,
    recommendedColumns: [
      ...capabilities.funnelColumns.slice(0, 2),
      ...capabilities.numericColumns.slice(0, 1),
    ],
    sqlPattern:
      "SELECT stage_col, COUNT(*) AS count FROM table GROUP BY 1 ORDER BY CASE stage_col WHEN 'step1' THEN 1 WHEN 'step2' THEN 2 ELSE 99 END",
    domainNote: addIntentFlavor(domainNote(
      "Use the stage/status/step column as the funnel sequence. Each distinct value becomes one funnel step.",
      {
        saas: "Show trial → active → churned conversion funnel.",
        ecommerce: "Show browse → cart → checkout → purchase funnel.",
        marketing: "Show awareness → interest → intent → conversion funnel.",
        support: "Show open → in-progress → resolved ticket flow.",
        hr: "Show applied → screened → interviewed → hired funnel.",
      },
      meta.domain
    ), query),
  }),
};

// ── Cohort ────────────────────────────────────────────────────────────────────

export const cohortWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-cohort",
  description: "Domain hints for cohort chart widgets — retention over time",
  run: async ({ capabilities, meta, connectorType, query }) => ({
    applicable: capabilities.temporalColumns.length > 0 && capabilities.numericColumns.length > 0,
    recommendedColumns: [
      ...capabilities.temporalColumns.slice(0, 2),
      ...capabilities.numericColumns.slice(0, 1),
    ],
    sqlPattern: isMssql(connectorType)
      ? "SELECT DATEADD(month, DATEDIFF(month, 0, signup_date), 0) AS cohort, DATEADD(month, DATEDIFF(month, 0, activity_date), 0) AS period, COUNT(DISTINCT user_id) AS active FROM table GROUP BY DATEADD(month, DATEDIFF(month, 0, signup_date), 0), DATEADD(month, DATEDIFF(month, 0, activity_date), 0)"
      : "SELECT DATE_TRUNC('month', signup_date) AS cohort, DATE_TRUNC('month', activity_date) AS period, COUNT(DISTINCT user_id) AS active FROM table GROUP BY 1, 2",
    domainNote: addIntentFlavor(domainNote(
      "Requires a cohort date (signup/created) and an activity date. Computes retention = active_in_period / cohort_size.",
      {
        saas: "Use signup month as cohort date, subscription activity date for retention.",
        ecommerce: "Use first purchase date as cohort, subsequent purchase dates for retention.",
        marketing: "Use campaign attribution date as cohort, conversion date for follow-through.",
        hr: "Use hire date as cohort, engagement event dates for retention.",
      },
      meta.domain
    ), query),
  }),
};

// ── Map ───────────────────────────────────────────────────────────────────────

export const mapWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-map",
  description: "Domain hints for map chart widgets — geographic distribution of a metric",
  run: async ({ capabilities, meta, query }) => ({
    applicable: capabilities.geographicColumns.length > 0,
    recommendedColumns: [
      ...capabilities.geographicColumns.slice(0, 2),
      ...capabilities.numericColumns.slice(0, 1),
    ],
    sqlPattern: "SELECT country_col AS geo, SUM(metric) AS value FROM table GROUP BY 1",
    domainNote: addIntentFlavor(domainNote(
      "Use the geographic column as the map dimension. Prefer country or region granularity for global views.",
      {
        saas: "Show subscriber count or MRR by country.",
        ecommerce: "Show revenue or order volume by country or state.",
        marketing: "Show lead volume or ad spend by region.",
        support: "Show ticket volume by region or country.",
        hr: "Show headcount by country or office location.",
      },
      meta.domain
    ), query),
  }),
};

// ── Table ─────────────────────────────────────────────────────────────────────

export const tableWidgetSkill: SkillDefinition<WidgetSkillInput, WidgetSkillHint> = {
  id: "planner:widget-table",
  description: "Domain hints for table widgets — detail drilldown with sortable rows",
  run: async ({ capabilities, meta, connectorType, query }) => ({
    applicable: true,
    recommendedColumns: [
      ...capabilities.categoricalColumns.slice(0, 2),
      ...capabilities.numericColumns.slice(0, 2),
      ...capabilities.temporalColumns.slice(0, 1),
    ],
    sqlPattern: `SELECT ${topRowsClause(connectorType, 100)}id, col1, col2, metric FROM table ORDER BY metric DESC${limitClause(connectorType, 100)}`,
    domainNote: addIntentFlavor(domainNote(
      "Include the most operationally useful identifier column plus 3-5 key metrics. Sort by the primary metric.",
      {
        saas: "List top customers by MRR with status, plan, and churn risk.",
        ecommerce: "List recent orders with customer, amount, status, and date.",
        support: "List open tickets with priority, assignee, age, and SLA status.",
        marketing: "List top campaigns by spend, leads, and conversion rate.",
        finance: "List transactions or accounts with amount, status, and date.",
        hr: "List employees with role, department, tenure, and performance score.",
      },
      meta.domain
    ), query),
  }),
};

// ── Registry ─────────────────────────────────────────────────────────────────

export const ALL_WIDGET_SKILLS = [
  kpiWidgetSkill,
  lineWidgetSkill,
  barWidgetSkill,
  areaWidgetSkill,
  donutWidgetSkill,
  pieWidgetSkill,
  scatterWidgetSkill,
  funnelWidgetSkill,
  cohortWidgetSkill,
  mapWidgetSkill,
  tableWidgetSkill,
] as const;

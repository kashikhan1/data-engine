/* eslint-disable @typescript-eslint/no-explicit-any */
import type { CurrentDateTimeContext } from "../../agents/planner/current-datetime-tool";

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export function buildCurrentDateContextBlock(now: CurrentDateTimeContext): string {
  return `Current date context:
- Today (local): ${now.todayDate}
- Current datetime (local): ${now.todayDateTime}
- Timezone: ${now.currentTimeZone}
- Current datetime (UTC ISO): ${now.nowIsoUtc}

Relative date interpretation policy:
- Interpret "today", "yesterday", "last N days", "MTD", "QTD", and "YTD" using the local timezone above.
- "Last month" = calendar month prior to today's month. "Last quarter" = the most recently completed calendar quarter.
- "YTD" = from Jan 1 of the current year to today. "QTD" = from the first day of the current quarter to today.
- Always convert relative phrases to explicit date bounds (e.g. WHERE created_at >= '2025-01-01' AND created_at < '2025-04-01').
- Never leave relative time language unresolved in SQL hints.`;
}

export function buildQueryIntentHints(query: string): string {
  const q = query.toLowerCase();
  const hints: string[] = [];

  // Temporal intent
  if (q.includes("trend") || q.includes("over time") || q.includes("month") || q.includes("daily") || q.includes("weekly") || q.includes("quarterly"))
    hints.push("- Prioritize temporal analysis: include at least one time-series widget using DATE_TRUNC or equivalent period bucketing.");

  // Period comparison intent
  if (q.includes("vs last") || q.includes("mom") || q.includes("yoy") || q.includes("previous") || q.includes("compared to"))
    hints.push("- Include period-over-period comparison: compute current and prior period in a single query using conditional aggregation or window functions.");

  // Ranking/breakdown intent
  if (q.includes("top") || q.includes("compare") || q.includes("breakdown") || q.includes("by "))
    hints.push("- Prioritize ranked category comparisons: ORDER BY metric DESC with LIMIT/TOP N. Include dimension context (e.g. category, region, status).");

  // Funnel/conversion intent
  if (q.includes("funnel") || q.includes("conversion") || q.includes("stage") || q.includes("drop-off"))
    hints.push("- Prioritize ordered stage analysis: preserve semantic step order and compute absolute count + conversion rate at each stage.");

  // Geographic intent
  if (q.includes("where") || q.includes("region") || q.includes("country") || q.includes("map") || q.includes("city"))
    hints.push("- Include geographic segmentation using standardized location columns (ISO codes preferred for map rendering).");

  // Retention/cohort intent
  if (q.includes("retention") || q.includes("cohort") || q.includes("churn") || q.includes("returning"))
    hints.push("- Include retention/cohort treatment: requires signup/first-touch date AND a recurring activity date column.");

  // Rate/ratio intent
  if (q.includes("rate") || q.includes("ratio") || q.includes("percent") || q.includes("%"))
    hints.push("- Rate metrics must be computed as numerator/NULLIF(denominator, 0) — never SUM a rate column directly.");

  // Correlation intent
  if (q.includes("correlation") || q.includes("relationship between") || q.includes("vs ") || q.includes("versus"))
    hints.push("- For correlation analysis: use scatter chart with 2 distinct metric columns as axes.");

  return hints.length > 0 ? hints.join("\n") : "- Build a balanced plan: 1-2 KPI headline metrics + one time trend + one categorical breakdown. Add detail table if operational context is needed.";
}

export function buildEnabledFilterBlock(schema: unknown): string {
  const filterableColumns = (schema as any)?.filterableColumns;
  if (!filterableColumns || typeof filterableColumns !== "object") return "";
  const entries = Object.entries(filterableColumns as Record<string, unknown>)
    .filter(([, cols]) => Array.isArray(cols) && (cols as string[]).length > 0)
    .map(([table, cols]) => `  ${table}: ${(cols as string[]).join(", ")}`);
  if (entries.length === 0) return "";
  return `ALLOWED FILTER COLUMNS — only these columns may appear in WHERE, HAVING, or JOIN ON conditions:\n${entries.join("\n")}\nAll other columns are SELECT-only. Never filter on any column not listed above.`;
}

export function buildCapabilityChecklist(params: {
  hasTemporal: boolean;
  hasNumeric: boolean;
  hasCategorical: boolean;
  hasGeographic: boolean;
  hasFunnel: boolean;
}): string {
  const items = [
    `temporal=${yesNo(params.hasTemporal)}`,
    `numeric=${yesNo(params.hasNumeric)}`,
    `categorical=${yesNo(params.hasCategorical)}`,
    `geographic=${yesNo(params.hasGeographic)}`,
    `funnel=${yesNo(params.hasFunnel)}`,
  ];
  return [
    `Capability checklist: ${items.join(", ")}.`,
    "Never force a widget type that lacks its required data signals — hard absence means that chart type is off the table.",
    !params.hasTemporal ? "⚠ No temporal columns: line, area, and cohort widgets are unavailable." : "",
    !params.hasNumeric ? "⚠ No numeric columns: KPI and scatter widgets are unavailable." : "",
    !params.hasCategorical ? "⚠ No categorical columns: pie and donut widgets may lack meaningful grouping." : "",
  ].filter(Boolean).join("\n");
}

import { createWidgetSubagent } from "./factory";

export const kpiWidgetSubagent = createWidgetSubagent({
  widgetType: "kpi",
  skillId: "planner:widget-kpi",
  feasibilityCheck: (cap) => cap.metricColumns.length > 0,
  systemPromptCore: `KPI Widget Rules:
- Pick the metric from "Metric columns (safe to SUM/AVG)" when available.
- Never SUM/AVG ID-like columns (id, *_id, fk/pk) or rate/ratio columns.
- If the metric is a rate/ratio, recompute it from numerator and denominator; never aggregate the stored ratio directly.
- If temporal columns exist, include a prior-period comparison in notes (for example current 30d vs prior 30d or current month vs prior month).
- title should be the metric name (e.g. "Total Revenue", "Active Users", "Avg Resolution Time").
- notes: write an exact SQL expression with null-safe math (NULLIF/COALESCE where needed), not a vague hint.
- Set applicable: false when no valid business metric can be computed from available columns.
- Set confidence >= 80 only when the metric definition is unambiguous.
- If confidence < 50, set applicable: false.`,
});

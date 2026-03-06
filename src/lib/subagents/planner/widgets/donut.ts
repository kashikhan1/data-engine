import { createWidgetSubagent } from "./factory";

export const donutWidgetSubagent = createWidgetSubagent({
  widgetType: "donut",
  skillId: "planner:widget-donut",
  feasibilityCheck: (cap) => cap.categoricalColumns.length > 0,
  systemPromptCore: `Donut Chart Widget Rules:
- Pick ONE low-cardinality categorical column (3-6 distinct values ideally).
- Aggregate a numeric metric (COUNT or SUM) per category slice.
- Center label = grand total or dominant metric value.
- title: describe the breakdown (e.g. "Subscribers by Plan", "Tickets by Priority").
- notes: include explicit aggregation + ORDER BY metric DESC + LIMIT/TOP 6 to avoid too many slices.
- Set confidence >= 70 when a suitable low-cardinality categorical column exists.
- Set applicable: false if confidence < 50 or if there are no categorical columns at all.`,
});

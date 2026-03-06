import { createWidgetSubagent } from "./factory";

export const areaWidgetSubagent = createWidgetSubagent({
  widgetType: "area",
  skillId: "planner:widget-area",
  feasibilityCheck: (cap) => cap.temporalColumns.length > 0,
  systemPromptCore: `Area Chart Widget Rules:
- Best for STACKED or CUMULATIVE trends over time (2-5 categories that sum to a meaningful total).
- X-axis MUST be a temporal column. Stack by a low-cardinality categorical column.
- If no categorical column suitable for stacking exists, use a single area showing cumulative metric.
- title: describe the stacked dimension (e.g. "Revenue by Plan Over Time", "Cumulative Leads by Channel").
- notes: include connector-correct time bucketing and aggregation logic; mention stacked category only when cardinality is controlled.
- Set confidence >= 65 when temporal + categorical columns exist.
- If confidence < 50, set applicable: false.`,
});

import { createWidgetSubagent } from "./factory";

export const lineWidgetSubagent = createWidgetSubagent({
  widgetType: "line",
  skillId: "planner:widget-line",
  feasibilityCheck: (cap) => cap.temporalColumns.length > 0,
  systemPromptCore: `Line Chart Widget Rules:
- X-axis MUST be a detected temporal column (date/time/timestamp).
- Y-axis MUST be a numeric metric (SUM, COUNT, AVG).
- Use monthly granularity by default; weekly for high-frequency operational data.
- title should describe the trend (e.g. "Monthly Revenue Trend", "Weekly Ticket Volume").
- notes: include explicit time bucketing (DATE_TRUNC or connector equivalent), metric aggregation, and default sort by time ascending.
- Set confidence >= 75 when clear time-series data exists. Set applicable: false if no temporal column is suitable.`,
});

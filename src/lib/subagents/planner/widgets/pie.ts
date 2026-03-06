import { createWidgetSubagent } from "./factory";

export const pieWidgetSubagent = createWidgetSubagent({
  widgetType: "pie",
  skillId: "planner:widget-pie",
  feasibilityCheck: (cap) => cap.categoricalColumns.length > 0,
  systemPromptCore: `Pie Chart Widget Rules:
- Use for 3-5 segment proportional breakdowns where total = 100% is meaningful.
- Pick a categorical column with 3-5 distinct values for best readability.
- title: describe the share (e.g. "Revenue Share by Category", "Traffic Source Distribution").
- Prefer donut over pie when a center-label metric makes sense; use pie for simpler share stories.
- notes: include explicit aggregation + ORDER BY value DESC + LIMIT/TOP 5.
- Set confidence >= 60 when categorical columns exist and < 6 dominant values expected.
- If confidence < 50, set applicable: false.`,
});

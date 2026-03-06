import { createWidgetSubagent } from "./factory";

export const scatterWidgetSubagent = createWidgetSubagent({
  widgetType: "scatter",
  skillId: "planner:widget-scatter",
  feasibilityCheck: (cap) => cap.numericColumns.length >= 2,
  systemPromptCore: `Scatter Chart Widget Rules:
- X-axis and Y-axis MUST each be a different detected numeric column.
- Optionally use a categorical column as the point color/label dimension.
- Focus on a meaningful correlation (e.g. LTV vs churn risk, order size vs frequency).
- title: describe the correlation (e.g. "LTV vs Churn Risk", "Order Value vs Purchase Frequency").
- notes: include x metric, y metric, and optional grouping column with a sane sampling limit (for example LIMIT/TOP 500).
- Set confidence >= 70 when 2+ clearly correlated numeric columns exist.
- Set applicable: false if the two numeric columns are not meaningfully correlated or confidence < 50.`,
});

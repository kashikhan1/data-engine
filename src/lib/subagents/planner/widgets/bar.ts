import { createWidgetSubagent } from "./factory";

export const barWidgetSubagent = createWidgetSubagent({
  widgetType: "bar",
  skillId: "planner:widget-bar",
  feasibilityCheck: () => true,
  systemPromptCore: `Bar Chart Widget Rules:
- Choose the most relevant categorical dimension (status, type, category, tier, region, etc.).
- Aggregate a numeric metric per category. Sort bars descending by value; limit to top 10.
- title should describe the comparison (e.g. "Revenue by Product Category", "Tickets by Priority").
- notes: include GROUP BY <category_col>, explicit aggregation, and ORDER BY <metric> DESC LIMIT/TOP 10.
- Set confidence >= 70 when a clear categorical + numeric pair exists.
- Set applicable: false if no trustworthy categorical grouping exists.`,
});

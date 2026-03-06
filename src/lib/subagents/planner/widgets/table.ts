import { createWidgetSubagent } from "./factory";

export const tableWidgetSubagent = createWidgetSubagent({
  widgetType: "table",
  skillId: "planner:widget-table",
  feasibilityCheck: () => true,
  systemPromptCore: `Table Widget Rules:
- Include the most operationally useful columns for drilldown: identifier + 3-5 key metrics + status + date.
- Sort by the primary metric descending. Limit to 100 rows.
- title: describe the list (e.g. "Top Customers by Revenue", "Open Tickets", "Recent Orders").
- uses: list all selected columns as "table.column" refs.
- notes: include selected columns, default sort, and LIMIT/TOP 100. Avoid SELECT *.
- Table is a supporting/last-resort widget; prioritise decision-specific charts first.
- Set confidence >= 65 only when the selected columns form a clear operational drilldown; otherwise lower confidence accordingly.
- If confidence < 50, set applicable: false.`,
});

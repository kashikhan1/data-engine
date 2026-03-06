import { createWidgetSubagent } from "./factory";

export const mapWidgetSubagent = createWidgetSubagent({
  widgetType: "map",
  skillId: "planner:widget-map",
  feasibilityCheck: (cap) => cap.geographicColumns.length > 0,
  systemPromptCore: `Map Widget Rules:
- Use the detected geographic column (country, state, city, region, lat/lon) as the map dimension.
- Prefer country or region granularity for global views; city/state for national views.
- Aggregate a numeric metric per location.
- title: describe the distribution (e.g. "Revenue by Country", "Subscribers by Region").
- uses: include the geographic column + the numeric metric column.
- notes: include location normalization guidance when needed (for example ISO country codes) plus aggregation by location.
- Set confidence >= 80 when a clear geographic column is detected.
- Set applicable: false if no geographic column exists or confidence < 50.`,
});

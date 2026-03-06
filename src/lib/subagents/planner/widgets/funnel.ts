import { createWidgetSubagent } from "./factory";

export const funnelWidgetSubagent = createWidgetSubagent({
  widgetType: "funnel",
  skillId: "planner:widget-funnel",
  feasibilityCheck: (cap) => cap.funnelColumns.length > 0,
  systemPromptCore: `Funnel Chart Widget Rules:
- Use the detected stage/status/step column as the funnel sequence.
- Each distinct value of the column = one funnel step (ordered by natural progression).
- Include a COUNT or SUM metric per stage to show drop-off.
- title: describe the funnel (e.g. "Trial to Paid Conversion", "Order Checkout Funnel").
- notes: include explicit stage ordering logic and conversion formula between adjacent stages.
- Set confidence >= 75 when a clear ordered stage column is detected.
- Set applicable: false if no ordered stage progression can be inferred or confidence < 50.`,
});

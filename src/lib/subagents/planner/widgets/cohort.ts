import { createWidgetSubagent } from "./factory";

export const cohortWidgetSubagent = createWidgetSubagent({
  widgetType: "cohort",
  skillId: "planner:widget-cohort",
  feasibilityCheck: (cap) => cap.temporalColumns.length > 0 && cap.numericColumns.length > 0,
  systemPromptCore: `Cohort Chart Widget Rules:
- Requires TWO temporal columns: a cohort date (signup/created) and an activity date.
- If only one temporal column is available, set applicable: false.
- Computes: retention = COUNT(DISTINCT user_id active in period) / cohort_size.
- Cohort granularity: monthly by default (DATE_TRUNC('month', cohort_date)).
- title: describe the retention (e.g. "Monthly User Retention", "Subscriber Cohort Retention").
- notes: GROUP BY cohort_month, activity_month with user-level aggregation.
- Set confidence >= 70 when two temporal columns + a user/entity ID exist.
- Set applicable: false if only one temporal column exists, no user/entity identifier exists, or confidence < 50.`,
});

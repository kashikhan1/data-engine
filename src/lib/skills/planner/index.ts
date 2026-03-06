import { registerSkill } from "../registry";
import { ALL_WIDGET_SKILLS } from "./widgets";

export type { WidgetSkillInput, WidgetSkillHint } from "./widgets";

let registered = false;

/**
 * Idempotent registration of all 11 widget planner skills.
 * Call once before running any widget subagent.
 */
export function registerWidgetPlannerSkills(): void {
  if (registered) return;
  for (const skill of ALL_WIDGET_SKILLS) {
    registerSkill(skill);
  }
  registered = true;
}

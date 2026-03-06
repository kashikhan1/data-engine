import type { PlanningObjective, PlanningObjectiveConstraints, PlanningObjectiveMode } from "./types";

const FEATURE_FLAG_ENABLED = process.env.PLANNER_GOAL_OBJECTIVE_V1 !== "0";

const ACCURACY_DEFAULT_CONSTRAINTS: PlanningObjectiveConstraints = {
  strictMath: true,
  strictSchemaRefs: true,
  maxWidgetRedundancy: 0,
  minConfidence: 70,
};

const LEGACY_CONSTRAINTS: PlanningObjectiveConstraints = {
  strictMath: false,
  strictSchemaRefs: false,
  maxWidgetRedundancy: 1,
  minConfidence: 50,
};

export const DEFAULT_PLANNING_OBJECTIVE: PlanningObjective = {
  mode: "accuracy_first",
  constraints: ACCURACY_DEFAULT_CONSTRAINTS,
};

const LEGACY_PLANNING_OBJECTIVE: PlanningObjective = {
  mode: "narrative_first",
  constraints: LEGACY_CONSTRAINTS,
};

function sanitizeMode(mode: unknown): PlanningObjectiveMode {
  if (mode === "accuracy_first" || mode === "latency_first" || mode === "narrative_first")
    return mode;
  return DEFAULT_PLANNING_OBJECTIVE.mode;
}

function sanitizeConstraints(raw: unknown): PlanningObjectiveConstraints {
  const base = ACCURACY_DEFAULT_CONSTRAINTS;
  const value = (raw && typeof raw === "object") ? raw as Partial<PlanningObjectiveConstraints> : {};
  const maxWidgetRedundancy = Number.isFinite(Number(value.maxWidgetRedundancy))
    ? Math.max(0, Math.min(5, Number(value.maxWidgetRedundancy)))
    : base.maxWidgetRedundancy;
  const minConfidence = Number.isFinite(Number(value.minConfidence))
    ? Math.max(0, Math.min(100, Number(value.minConfidence)))
    : base.minConfidence;
  return {
    strictMath: typeof value.strictMath === "boolean" ? value.strictMath : base.strictMath,
    strictSchemaRefs: typeof value.strictSchemaRefs === "boolean" ? value.strictSchemaRefs : base.strictSchemaRefs,
    maxWidgetRedundancy,
    minConfidence,
  };
}

export function resolvePlanningObjective(input?: Partial<PlanningObjective> | null): PlanningObjective {
  if (!FEATURE_FLAG_ENABLED) return LEGACY_PLANNING_OBJECTIVE;
  const mode = sanitizeMode(input?.mode);
  const constraints = sanitizeConstraints(input?.constraints);
  return { mode, constraints };
}

export function isAccuracyFirst(objective: PlanningObjective): boolean {
  return objective.mode === "accuracy_first";
}

export function formatObjectiveBlock(objective: PlanningObjective): string {
  return [
    "Planning objective:",
    `- mode: ${objective.mode}`,
    `- strictMath: ${objective.constraints.strictMath}`,
    `- strictSchemaRefs: ${objective.constraints.strictSchemaRefs}`,
    `- maxWidgetRedundancy: ${objective.constraints.maxWidgetRedundancy}`,
    `- minConfidence: ${objective.constraints.minConfidence}`,
  ].join("\n");
}


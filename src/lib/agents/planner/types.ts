import type { TodoItem, TodoListState, TodoSummary } from "../todo-types";

// ── Stream event types ────────────────────────────────────────────────────────

export type PlannerStreamEvent =
  | { type: "planner_agents"; content: string }
  | {
    type: "planner_objective";
    mode: PlanningObjectiveMode;
    constraints: PlanningObjectiveConstraints;
  }
  | { type: "planner_agent_status"; agent: string; status: "start" | "done" | "error" }
  | { type: "planner_agent_input"; agent: string; content: string }
  | { type: "planner_agent_token"; agent: string; token: string }
  | { type: "planner_agent_draft"; agent: string; content: string }
  | { type: "todo_list_initialized"; todoList: TodoListState }
  | { type: "todo_item_updated"; item: TodoItem }
  | { type: "todo_summary"; summary: TodoSummary }
  | {
    type: "planner_quality_summary";
    objectiveMode: PlanningObjectiveMode;
    score: number;
    accepted: boolean;
    hardFailureCount: number;
    kpiMathViolationCount: number;
  }
  | { type: "planner_schema_usage"; tables: number; columns: number; visibleColumns: number; hiddenColumns: number; relationships: number }
  | { type: "planner_intents"; intents: string[] };

export type PlannerStreamItem = { kind: "chunk"; chunk: string } | { kind: "event"; event: PlannerStreamEvent };
export type PlannerAgentResultItem<T> = { kind: "__result"; result: T };

// ── Agent result types ────────────────────────────────────────────────────────

/** Output of the Meta/Filter/Domain subagent */
export type MetaFilterDomainResult = {
  /** 2-3 sentence human-readable summary of domain, focus table, and filter options */
  draft: string;
  /** Final decision objective for the dashboard, grounded in query + schema. */
  finalGoal: string;
  /** Concrete planning goals that downstream agents should satisfy. */
  planGoals: string[];
  /** KPI-focused goals derived from available schema metrics. */
  kpiGoals: string[];
  /** Schema KPI candidates in table.column form (safe metric refs). */
  availableKpis: string[];
  intentLabels: string[];
  domain: string;
  primaryTable: string;
  filterCandidates: string[];
  /**
   * 1-2 sentences of domain-specific dashboard guidance passed to downstream agents.
   * e.g. "Focus on subscription lifecycle — track MRR, churn rate, and trial conversion."
   */
  domainGuidance: string;
};

/** A single planned widget produced by the Widget Planner subagent */
export type WidgetPlanItem = {
  type: string;
  title: string;
  /** Plain-English business question this widget answers */
  goal: string;
  primaryTable: string;
  requiredTables: string[];
  /** Comma-separated table.column references */
  uses: string;
  /** Why this widget type is the right choice */
  rationale: string;
};

/** Output of the Widget Planner subagent */
export type WidgetPlannerResult = {
  /** 2-3 sentence summary: which widgets were chosen and why */
  draft: string;
  widgetPlans: WidgetPlanItem[];
};

/** Output of the Final Plan subagent */
export type FinalPlanResult = {
  /** Natural-language dashboard description for business users */
  draft: string;
  plan: {
    title: string;
    widgets: Array<{
      id: string;
      type: string;
      title: string;
      goal: string;
      requiredTables: string[];
      primaryTable: string;
      uses: string;
      notes: string;
    }>;
  };
};

// ── Schema grounding types ────────────────────────────────────────────────────

export type GroundedSchema = {
  availableTables: string[];
  candidateTables: string[];
  projectedColumnsByTable: Record<string, string[]>;
  /** Compact text: "tableName: col1 (type), col2 (type), ..." per line */
  schemaSummary: string;
  totalColumns: number;
  visibleColumns: number;
  hiddenColumns: number;
  relationships: number;
};

// ── Normalized plan types ─────────────────────────────────────────────────────

export type NormalizedWidget = {
  id: string;
  type: string;
  title: string;
  goal: string;
  requiredTables: string[];
  primaryTable: string;
  uses: string;
  notes: string;
};

export type NormalizedPlan = {
  title: string;
  widgets: NormalizedWidget[];
};

export type PlannerQueryPlan = {
  title: string;
  actionable_plan: string;
  widgets: NormalizedWidget[];
};

// ── Objective types ───────────────────────────────────────────────────────────

export type PlanningObjectiveMode = "accuracy_first" | "latency_first" | "narrative_first";

export type PlanningObjectiveConstraints = {
  strictMath: boolean;
  strictSchemaRefs: boolean;
  maxWidgetRedundancy: number;
  minConfidence: number;
};

export type PlanningObjective = {
  mode: PlanningObjectiveMode;
  constraints: PlanningObjectiveConstraints;
};

import type { SubagentContext, SubagentInput, SubagentResult } from "@/modules/runtime/subagents/types";
import type {
  MetaFilterDomainResult,
  WidgetPlannerResult,
  FinalPlanResult,
  GroundedSchema,
  PlanningObjective,
} from "../../agents/planner/types";
import type { SchemaCapabilities } from "../../agents/planner/schema-capabilities";
import type { WidgetAgentOutput } from "./widgets/types";

// ── Planner-specific context ──────────────────────────────────────────────────

/** Extends SubagentContext with live-token streaming support for the planner pipeline. */
export interface PlannerSubagentContext extends SubagentContext {
  onToken?: (token: string) => void;
}

// ── Generic planner subagent interface ───────────────────────────────────────

/** A planner subagent that accepts PlannerSubagentContext for token streaming. */
export interface PlannerSubagent<I extends SubagentInput, O extends SubagentResult> {
  id: string;
  run: (input: I, context?: PlannerSubagentContext) => Promise<O>;
}

// ── MetaFilterDomain I/O ──────────────────────────────────────────────────────

export interface MetaFilterDomainInput extends SubagentInput {
  query: string;
  schema: unknown;
  grounded: GroundedSchema;
  objective: PlanningObjective;
}

export interface MetaFilterDomainOutput extends SubagentResult, MetaFilterDomainResult {}

// ── Split Stage-1 subagents I/O ──────────────────────────────────────────────

export interface InitPlanGoalsInput extends SubagentInput {
  query: string;
  schema: unknown;
  grounded: GroundedSchema;
  capabilities: SchemaCapabilities;
  objective: PlanningObjective;
}

export interface InitPlanGoalsOutput extends SubagentResult {
  draft: string;
  finalGoal: string;
  planGoals: string[];
  kpiGoals: string[];
  availableKpis: string[];
}

export interface MetaIntentInput extends SubagentInput {
  query: string;
  schema: unknown;
  grounded: GroundedSchema;
  finalGoal: string;
  planGoals: string[];
  kpiGoals: string[];
  availableKpis: string[];
  objective: PlanningObjective;
}

export interface MetaIntentOutput extends SubagentResult {
  draft: string;
  intentLabels: string[];
}

export interface DomainFocusInput extends SubagentInput {
  query: string;
  schema: unknown;
  grounded: GroundedSchema;
  intentLabels: string[];
  finalGoal: string;
  planGoals: string[];
  kpiGoals: string[];
  availableKpis: string[];
  objective: PlanningObjective;
}

export interface DomainFocusOutput extends SubagentResult {
  draft: string;
  domain: string;
  primaryTable: string;
  domainGuidance: string;
}

export interface FilterCandidatesInput extends SubagentInput {
  query: string;
  schema: unknown;
  grounded: GroundedSchema;
  intentLabels: string[];
  domain: string;
  primaryTable: string;
  finalGoal: string;
  planGoals: string[];
  kpiGoals: string[];
  availableKpis: string[];
  /** Optional schema-enabled filter refs (table.column) from discovery UI toggles. */
  enabledFilterRefs?: string[];
  objective: PlanningObjective;
}

export interface FilterCandidatesOutput extends SubagentResult {
  draft: string;
  filterCandidates: string[];
}

// ── FinalPlan I/O ─────────────────────────────────────────────────────────────

export interface FinalPlanInput extends SubagentInput {
  query: string;
  schema: unknown;
  grounded: GroundedSchema;
  meta: MetaFilterDomainResult;
  widgetPlanner: WidgetPlannerResult;
  /** Raw outputs from all widget-specific agents (applicable and non-applicable). */
  widgetAgentOutputs: WidgetAgentOutput[];
  capabilities: SchemaCapabilities;
  objective: PlanningObjective;
  /** Injected by the orchestrator on retry — feedback from the plan validator */
  validationFeedback?: string;
}

export interface FinalPlanOutput extends SubagentResult, FinalPlanResult {}

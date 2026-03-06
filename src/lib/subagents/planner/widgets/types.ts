import type { SubagentInput, SubagentResult } from "@/modules/runtime/subagents/types";
import type { GroundedSchema, MetaFilterDomainResult, PlanningObjective } from "../../../agents/planner/types";
import type { SchemaCapabilities } from "../../../agents/planner/schema-capabilities";

// ── Widget Agent I/O ──────────────────────────────────────────────────────────

export interface WidgetAgentInput extends SubagentInput {
  query: string;
  schema: unknown;
  grounded: GroundedSchema;
  meta: MetaFilterDomainResult;
  capabilities: SchemaCapabilities;
  objective: PlanningObjective;
}

export interface WidgetAgentOutput extends SubagentResult {
  /** false = this widget type doesn't fit — no LLM call was made */
  applicable: boolean;
  widgetType: string;
  title: string;
  goal: string;
  primaryTable: string;
  requiredTables: string[];
  /** Comma-separated "table.column" references */
  uses: string;
  /** Why this widget type is the right choice */
  rationale: string;
  /** One concise SQL or data hint */
  notes: string;
  /** 0–100 confidence score: how well this widget answers the query */
  confidence: number;
}

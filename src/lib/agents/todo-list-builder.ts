import type { GroundedSchema, PlanningObjective } from "./planner/types";
import type { SchemaCapabilities } from "./planner/schema-capabilities";
import { getSelectedWidgetAgentIds } from "../subagents/planner";
import {
  buildTodoSummary,
  normalizeTodoScopeId,
  type TodoItem,
  type TodoListState,
} from "./todo-types";

function nowIso(): string {
  return new Date().toISOString();
}

function todo(
  id: string,
  domain: TodoItem["domain"],
  scopeId: string,
  title: string,
  status: TodoItem["status"],
  priority: TodoItem["priority"],
  ownerAgent?: string,
  reason?: string,
  suggestedFix?: string
): TodoItem {
  const ts = nowIso();
  return {
    id,
    domain,
    scopeId: normalizeTodoScopeId(scopeId),
    title,
    status,
    priority,
    ownerAgent,
    reason,
    suggestedFix,
    source: "rule",
    createdAt: ts,
    updatedAt: ts,
  };
}

export function buildInitialTodoListState(input: {
  runId: string;
  grounded: GroundedSchema;
  capabilities: SchemaCapabilities;
  enabledFilterRefs: string[];
  agentNames: string[];
  objective: PlanningObjective;
}): TodoListState {
  const { runId, grounded, capabilities, enabledFilterRefs, agentNames } = input;
  const items: TodoItem[] = [];

  // Widget TODOs from allowed/feasible types.
  for (const widgetType of capabilities.feasibleWidgetTypes || []) {
    items.push(
      todo(
        `todo:widget:${normalizeTodoScopeId(widgetType)}`,
        "widget",
        widgetType,
        `Validate widget type "${widgetType}"`,
        "pending",
        "medium"
      )
    );
  }
  if ((capabilities.feasibleWidgetTypes || []).length === 0) {
    items.push(
      todo(
        "todo:widget:none",
        "widget",
        "none",
        "No schema-feasible widget types",
        "blocked",
        "high",
        undefined,
        "Schema capabilities did not produce any allowed widget types.",
        "Enable visible columns and ensure candidate tables include numeric/categorical/temporal fields."
      )
    );
  }

  const candidateSet = new Set((grounded.candidateTables || []).map((t) => t.toLowerCase()));
  const pushColumnRefs = (refs: string[], label: string, priority: TodoItem["priority"]) => {
    for (const ref of refs.slice(0, 20)) {
      const [table] = String(ref || "").split(".");
      const blocked = !table || !candidateSet.has(table.toLowerCase());
      items.push(
        todo(
          `todo:column:${normalizeTodoScopeId(ref)}`,
          "column",
          ref,
          `${label}: ${ref}`,
          blocked ? "blocked" : "pending",
          priority,
          undefined,
          blocked ? "Column is outside candidate tables." : undefined,
          blocked ? "Use visible columns from candidate tables only." : undefined
        )
      );
    }
  };

  // Column TODOs by role.
  pushColumnRefs(capabilities.metricColumns || [], "Metric column", "high");
  pushColumnRefs(capabilities.temporalColumns || [], "Temporal column", "medium");
  pushColumnRefs(capabilities.categoricalColumns || [], "Categorical column", "medium");
  pushColumnRefs(capabilities.geographicColumns || [], "Geographic column", "low");
  pushColumnRefs(capabilities.funnelColumns || [], "Funnel column", "low");

  // Filter TODOs.
  for (const ref of (enabledFilterRefs || []).slice(0, 40)) {
    items.push(
      todo(
        `todo:filter:${normalizeTodoScopeId(ref)}`,
        "filter",
        ref,
        `Validate filter "${ref}"`,
        "pending",
        "medium"
      )
    );
  }

  // Agent TODOs.
  for (const agentName of agentNames) {
    items.push(
      todo(
        `todo:agent:${normalizeTodoScopeId(agentName)}`,
        "agent",
        agentName,
        `Run ${agentName}`,
        "pending",
        "medium",
        agentName
      )
    );
  }
  // SQL TODO placeholder agent.
  items.push(
    todo(
      "todo:agent:sql engineer",
      "agent",
      "SQL Engineer",
      "Run SQL Engineer",
      "pending",
      "medium",
      "SQL Engineer"
    )
  );

  const deduped = Array.from(new Map(items.map((i) => [i.id, i])).values());
  return {
    runId,
    items: deduped,
    summary: buildTodoSummary(deduped),
    agentUpdateLedger: {},
  };
}

export function buildPlannerAgentNamesForTodo(capabilities: SchemaCapabilities): string[] {
  const base = ["Init Plan Goals Agent", "Meta Intent Agent", "Domain Focus Agent", "Filter Agent"];
  const widgetAgents = getSelectedWidgetAgentIds(capabilities).map((id) => `Widget Agent: ${id.replace(/^widget-/, "")}`);
  return [...base, ...widgetAgents, "Final Plan Agent"];
}

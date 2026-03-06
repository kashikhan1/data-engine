/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLogger } from "@/lib/observability";
import { resolvePlanningObjective } from "./planner/objective";
import { createGroundedSchema, inferIntentLabels, getAllowedWidgetTypes } from "./planner/schema-utils";
import { detectSchemaCapabilities } from "./planner/schema-capabilities";
import { normalizeWidgets, buildPlanTextFromStructuredPlan } from "./planner/plan-utils";
import { runAgentWithLiveTokens } from "./planner/llm-runner";
import { buildInitialTodoListState, buildPlannerAgentNamesForTodo } from "./todo-list-builder";
import { applyAgentTodoUpdates } from "./todo-list-updater";
import type { TodoItem, TodoListState } from "./todo-types";
import { dbGateway } from "@/lib/mcp/server";
import {
  initPlanGoalsSubagent,
  metaIntentSubagent,
  domainFocusSubagent,
  filterCandidatesSubagent,
  finalPlanSubagent,
  validatePlan,
  getSelectedWidgetAgentIds,
  runWidgetAgentsInParallel,
  streamWidgetAgentsInParallel,
  mergeWidgetPlans,
} from "../subagents/planner";
import type {
  PlannerStreamItem,
  MetaFilterDomainResult,
  WidgetPlannerResult,
  FinalPlanResult,
  NormalizedPlan,
  PlannerQueryPlan,
  PlanningObjective,
} from "./planner/types";
import type { SchemaCapabilities } from "./planner/schema-capabilities";
import type { WidgetAgentOutput } from "../subagents/planner/widgets";

// ── Re-export ─────────────────────────────────────────────────────────────────

export type { SchemaDiscoveryOptions } from "./schema-discovery";

// ── Constants ─────────────────────────────────────────────────────────────────

const log = createLogger("agents.planner-runtime");

const INIT_GOALS_AGENT_NAME = "Init Plan Goals Agent";
const META_INTENT_AGENT_NAME = "Meta Intent Agent";
const DOMAIN_AGENT_NAME = "Domain Focus Agent";
const FILTER_AGENT_NAME = "Filter Agent";
const FINAL_AGENT_NAME = "Final Plan Agent";

function formatWidgetAgentName(agentId: string): string {
  return `Widget Agent: ${agentId.replace(/^widget-/, "")}`;
}

function buildPlannerAgentNames(capabilities: SchemaCapabilities): string[] {
  const widgetAgents = getSelectedWidgetAgentIds(capabilities).map(formatWidgetAgentName);
  return [INIT_GOALS_AGENT_NAME, META_INTENT_AGENT_NAME, DOMAIN_AGENT_NAME, FILTER_AGENT_NAME, ...widgetAgents, FINAL_AGENT_NAME];
}

function agentTodoId(agentName: string): string {
  return `todo:agent:${String(agentName || "").trim().toLowerCase()}`;
}

function widgetTodoId(widgetType: string): string {
  return `todo:widget:${String(widgetType || "").trim().toLowerCase()}`;
}

function filterTodoId(ref: string): string {
  return `todo:filter:${String(ref || "").trim().toLowerCase()}`;
}

function columnTodoId(ref: string): string {
  return `todo:column:${String(ref || "").trim().toLowerCase()}`;
}

function emitTodoDiffEvents(
  prev: TodoListState,
  next: TodoListState
): Array<{ type: "todo_item_updated"; item: TodoItem } | { type: "todo_summary"; summary: TodoListState["summary"] }> {
  const events: Array<{ type: "todo_item_updated"; item: TodoItem } | { type: "todo_summary"; summary: TodoListState["summary"] }> = [];
  const prevById = new Map(prev.items.map((i) => [i.id, i]));
  for (const item of next.items) {
    const old = prevById.get(item.id);
    if (!old || old.status !== item.status || old.reason !== item.reason || old.suggestedFix !== item.suggestedFix) {
      events.push({ type: "todo_item_updated", item });
    }
  }
  events.push({ type: "todo_summary", summary: next.summary });
  return events;
}

function extractEnabledFilterRefs(schema: any): string[] {
  const refs: string[] = [];
  const pushRef = (table: string, column: string) => {
    const t = String(table || "").trim();
    const c = String(column || "").trim();
    if (!t || !c) return;
    refs.push(`${t}.${c}`);
  };

  const filterable = schema?.filterableColumns;
  if (filterable && typeof filterable === "object") {
    for (const [table, cols] of Object.entries(filterable as Record<string, unknown>)) {
      if (!Array.isArray(cols)) continue;
      for (const col of cols) pushRef(table, String(col));
    }
  }

  const unique = Array.from(new Set(refs.map((r) => r.trim()).filter(Boolean)));
  return unique.slice(0, 40);
}

function clipAgentInput(value: string, max = 1600): string {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  if (max <= 20) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - 15).trimEnd()}\n[...truncated]`;
}

async function buildPlannerMcpEvidenceBlock(connectionString: string | undefined, candidateTables: string[]): Promise<string> {
  if (!connectionString || !Array.isArray(candidateTables) || candidateTables.length === 0) return "";
  const tables = Array.from(new Set(candidateTables.map((t) => String(t || "").trim()).filter(Boolean))).slice(0, 6);
  const lines: string[] = [];
  for (const table of tables) {
    try {
      const [schemaRes, previewRes] = await Promise.all([
        dbGateway.getTableSchema(table, connectionString),
        dbGateway.getTablePreview(table, connectionString),
      ]);
      const columns = Array.isArray((schemaRes as any)?.columns)
        ? (schemaRes as any).columns
        : Array.isArray(schemaRes)
          ? schemaRes
          : Array.isArray((schemaRes as any)?.data?.columns)
            ? (schemaRes as any).data.columns
            : [];
      const sampleRows = Array.isArray(previewRes)
        ? previewRes
        : Array.isArray((previewRes as any)?.data)
          ? (previewRes as any).data
          : [];
      const colText = columns
        .slice(0, 16)
        .map((c: any) => `${String(c?.name || c?.column_name || "")}:${String(c?.type || c?.data_type || "")}`)
        .filter(Boolean)
        .join(", ");
      lines.push(`TABLE ${table} -> columns: ${colText || "unavailable"}`);
      const recentRows = sampleRows.slice(0, 3);
      if (recentRows.length > 0) {
        lines.push(`TABLE ${table} -> recent_rows(${recentRows.length}):`);
        recentRows.forEach((row: any, idx: number) => {
          lines.push(`  row${idx + 1}: ${JSON.stringify(row)}`);
        });
      }
    } catch {
      // best-effort MCP enrichment
    }
  }
  return lines.join("\n");
}

function humanizeMetricColumnName(column: string): string {
  const clean = String(column || "").trim().replace(/[_\s]+/g, " ");
  if (!clean) return "Metric";
  return clean.replace(/\b\w/g, (m) => m.toUpperCase());
}

function isUnsafeNumericRef(ref: string): boolean {
  const col = String(ref || "").split(".").pop() || "";
  if (!col) return true;
  if (/^id$|_id$|^fk_|^pk_|user_id|order_id|customer_id|product_id|account_id|session_id|transaction_id/i.test(col)) return true;
  if (/rate|ratio|pct|percent|churn|ctr|conversion_rate|retention|utilization|margin|efficiency/i.test(col)) return true;
  return false;
}

function ensureKpiCoverage(
  plan: NormalizedPlan,
  capabilities: SchemaCapabilities,
  objective: PlanningObjective,
  allowedTypes: string[]
): NormalizedPlan {
  if (!allowedTypes.includes("kpi")) return plan;

  const metricRefs = Array.isArray(capabilities.metricColumns) ? capabilities.metricColumns : [];
  const numericRefs = Array.isArray(capabilities.numericColumns) ? capabilities.numericColumns : [];
  const safeNumericRefs = [
    ...metricRefs,
    ...numericRefs.filter((ref) => !isUnsafeNumericRef(ref)),
  ]
    .map((ref) => String(ref || "").trim())
    .filter((ref) => ref.includes("."));
  const uniqueSafeRefs = Array.from(new Set(safeNumericRefs));
  if (uniqueSafeRefs.length === 0) return plan;

  // User requirement: return at least 4 KPI widgets whenever KPI is enabled.
  const requiredMinKpis = 4;

  const widgets = [...(Array.isArray(plan.widgets) ? plan.widgets : [])];
  const existingKpis = widgets.filter((w) => w.type === "kpi");
  if (existingKpis.length >= requiredMinKpis) return plan;

  const existingIds = new Set(widgets.map((w) => String(w.id || "").trim()).filter(Boolean));
  const usedRefs = new Set(
    existingKpis
      .flatMap((w) => String(w.uses || "").split(",").map((x) => x.trim().toLowerCase()))
      .filter(Boolean)
  );

  const ensureUniqueId = (base: string) => {
    let id = base;
    let n = 1;
    while (existingIds.has(id)) id = `${base}_${n++}`;
    existingIds.add(id);
    return id;
  };

  for (const ref of uniqueSafeRefs) {
    if (widgets.filter((w) => w.type === "kpi").length >= requiredMinKpis) break;
    const normalizedRef = String(ref || "").trim();
    if (!normalizedRef || !normalizedRef.includes(".")) continue;
    if (usedRefs.has(normalizedRef.toLowerCase())) continue;

    const [table, column] = normalizedRef.split(".");
    if (!table || !column) continue;
    const metricLabel = humanizeMetricColumnName(column);
    const baseId = `w_kpi_auto_${String(column).toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;

    widgets.unshift({
      id: ensureUniqueId(baseId),
      type: "kpi",
      title: `Total ${metricLabel}`,
      goal: `Track total ${metricLabel.toLowerCase()}.`,
      requiredTables: [table],
      primaryTable: table,
      uses: normalizedRef,
      notes: `SUM(COALESCE(${column}, 0))`,
    });
    usedRefs.add(normalizedRef.toLowerCase());
  }

  // If we still have <4 KPIs, clone strongest KPI skeletons with remaining safe refs.
  if (widgets.filter((w) => w.type === "kpi").length < requiredMinKpis) {
    for (const ref of uniqueSafeRefs) {
      if (widgets.filter((w) => w.type === "kpi").length >= requiredMinKpis) break;
      const normalizedRef = String(ref || "").trim();
      if (usedRefs.has(normalizedRef.toLowerCase())) continue;
      const [table, column] = normalizedRef.split(".");
      if (!table || !column) continue;
      const metricLabel = humanizeMetricColumnName(column);
      const baseId = `w_kpi_auto_${String(column).toLowerCase().replace(/[^a-z0-9_]+/g, "_")}`;
      widgets.unshift({
        id: ensureUniqueId(baseId),
        type: "kpi",
        title: `Total ${metricLabel}`,
        goal: `Track total ${metricLabel.toLowerCase()}.`,
        requiredTables: [table],
        primaryTable: table,
        uses: normalizedRef,
        notes: `SUM(COALESCE(${column}, 0))`,
      });
      usedRefs.add(normalizedRef.toLowerCase());
    }
  }

  if (objective.mode === "accuracy_first") {
    widgets.sort((a, b) => {
      if (a.type === b.type) return 0;
      if (a.type === "kpi") return -1;
      if (b.type === "kpi") return 1;
      return 0;
    });
  }

  return { ...plan, widgets };
}

function extractHardFailureWidgetTitles(hardFailures: string[]): string[] {
  const titles = new Set<string>();
  for (const failure of hardFailures || []) {
    const match = String(failure || "").match(/^"([^"]+)"/);
    if (match?.[1]) titles.add(match[1].trim());
  }
  return Array.from(titles);
}

function applyDeterministicHardFailureRepair(input: {
  normalized: NormalizedPlan;
  validation: ReturnType<typeof validatePlan>;
  capabilities: SchemaCapabilities;
  query: string;
  objective: PlanningObjective;
  projectedColumnsByTable: Record<string, string[]>;
}): {
  normalized: NormalizedPlan;
  validation: ReturnType<typeof validatePlan>;
  repaired: boolean;
  removedTitles: string[];
} {
  const { normalized, validation, capabilities, query, objective, projectedColumnsByTable } = input;
  if (validation.hardFailures.length === 0) {
    return { normalized, validation, repaired: false, removedTitles: [] };
  }
  const removedTitles = extractHardFailureWidgetTitles(validation.hardFailures);
  if (removedTitles.length === 0) {
    return { normalized, validation, repaired: false, removedTitles: [] };
  }
  const removeSet = new Set(removedTitles.map((t) => t.toLowerCase()));
  const repairedWidgets = normalized.widgets.filter((w) => !removeSet.has(String(w.title || "").toLowerCase()));
  if (repairedWidgets.length === normalized.widgets.length || repairedWidgets.length === 0) {
    return { normalized, validation, repaired: false, removedTitles: [] };
  }
  const repairedPlan: NormalizedPlan = { ...normalized, widgets: repairedWidgets };
  const repairedValidation = validatePlan(repairedPlan.widgets, capabilities, query, objective, projectedColumnsByTable);
  if (!repairedValidation.accepted) {
    return { normalized, validation, repaired: false, removedTitles: [] };
  }
  return {
    normalized: repairedPlan,
    validation: repairedValidation,
    repaired: true,
    removedTitles,
  };
}

// ── Non-streaming planner ─────────────────────────────────────────────────────

export async function runDashboardPlanner(query: string, schema: any, planningObjective?: Partial<PlanningObjective>) {
  try {
    const objective = resolvePlanningObjective(planningObjective ?? schema?.planningObjective);
    const grounded = createGroundedSchema(schema);
    const mcpEvidenceBlock = await buildPlannerMcpEvidenceBlock(
      String(schema?.connectionString || schema?.dbUrl || schema?.postgresUrl || schema?.mssqlUrl || "").trim() || undefined,
      grounded.candidateTables
    );
    const schemaForAgents = mcpEvidenceBlock ? { ...schema, mcpEvidenceBlock } : schema;
    if (grounded.candidateTables.length === 0)
      throw new Error("No candidate table has usable columns after visible-column filtering.");

    const allowedTypes = getAllowedWidgetTypes(schema);
    const capabilities = detectSchemaCapabilities(schema, grounded, allowedTypes);
    const enabledFilterRefs = extractEnabledFilterRefs(schema);
    const plannerAgentNames = buildPlannerAgentNames(capabilities);
    const runId = `plan_${Date.now()}`;
    let todoListState = buildInitialTodoListState({
      runId,
      grounded,
      capabilities,
      enabledFilterRefs,
      agentNames: buildPlannerAgentNamesForTodo(capabilities),
      objective,
    });
    log.debug("capabilities_ready", { feasible: capabilities.feasibleWidgetTypes });

    // ── Stage 1: Init goals → Meta → Domain → Filters ────────────────────────
    const initGoals = await initPlanGoalsSubagent.run({
      query,
      schema: schemaForAgents,
      grounded,
      capabilities,
      objective,
    });
    todoListState = applyAgentTodoUpdates(todoListState, INIT_GOALS_AGENT_NAME, [
      { todoId: agentTodoId(INIT_GOALS_AGENT_NAME), status: "done" },
    ]);

    const metaIntent = await metaIntentSubagent.run({
      query,
      schema: schemaForAgents,
      grounded,
      finalGoal: initGoals.finalGoal,
      planGoals: initGoals.planGoals,
      kpiGoals: initGoals.kpiGoals,
      availableKpis: initGoals.availableKpis,
      objective,
    });
    todoListState = applyAgentTodoUpdates(todoListState, META_INTENT_AGENT_NAME, [
      { todoId: agentTodoId(META_INTENT_AGENT_NAME), status: "done" },
    ]);
    const domainFocus = await domainFocusSubagent.run({
      query,
      schema: schemaForAgents,
      grounded,
      intentLabels: metaIntent.intentLabels,
      finalGoal: initGoals.finalGoal,
      planGoals: initGoals.planGoals,
      kpiGoals: initGoals.kpiGoals,
      availableKpis: initGoals.availableKpis,
      objective,
    });
    todoListState = applyAgentTodoUpdates(todoListState, DOMAIN_AGENT_NAME, [
      { todoId: agentTodoId(DOMAIN_AGENT_NAME), status: "done" },
    ]);
    const filterCandidates = await filterCandidatesSubagent.run({
      query,
      schema: schemaForAgents,
      grounded,
      intentLabels: metaIntent.intentLabels,
      domain: domainFocus.domain,
      primaryTable: domainFocus.primaryTable,
      finalGoal: initGoals.finalGoal,
      planGoals: initGoals.planGoals,
      kpiGoals: initGoals.kpiGoals,
      availableKpis: initGoals.availableKpis,
      enabledFilterRefs,
      objective,
    });
    todoListState = applyAgentTodoUpdates(todoListState, FILTER_AGENT_NAME, [
      { todoId: agentTodoId(FILTER_AGENT_NAME), status: "done" },
      ...filterCandidates.filterCandidates.slice(0, 20).map((ref) => ({ todoId: filterTodoId(ref), status: "done" as const })),
    ]);
    const meta: MetaFilterDomainResult = {
      draft: [initGoals.draft, metaIntent.draft, domainFocus.draft, filterCandidates.draft].filter(Boolean).join("\n\n"),
      finalGoal: initGoals.finalGoal,
      planGoals: initGoals.planGoals,
      kpiGoals: initGoals.kpiGoals,
      availableKpis: initGoals.availableKpis,
      intentLabels: metaIntent.intentLabels,
      domain: domainFocus.domain,
      primaryTable: domainFocus.primaryTable,
      filterCandidates: filterCandidates.filterCandidates,
      domainGuidance: domainFocus.domainGuidance,
    };

    // ── Stage 2: Parallel widget agents → rule-based merger ───────────────────
    const rawWidgetPlans = await runWidgetAgentsInParallel({ query, schema: schemaForAgents, grounded, meta, capabilities, objective });
    todoListState = rawWidgetPlans.reduce((acc, w) => {
      if (!w?.widgetType) return acc;
      return applyAgentTodoUpdates(acc, `Widget Agent: ${w.widgetType}`, [
        { todoId: agentTodoId(`Widget Agent: ${w.widgetType}`), status: "done" },
        { todoId: widgetTodoId(w.widgetType), status: w.applicable ? "done" : "blocked", reason: w.rationale || undefined },
        ...String(w.uses || "")
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x.includes("."))
          .slice(0, 12)
          .map((ref) => ({ todoId: columnTodoId(ref), status: "done" as const })),
      ]);
    }, todoListState);
    const widgetPlanner = mergeWidgetPlans(
      rawWidgetPlans,
      meta,
      capabilities,
      objective,
      grounded.projectedColumnsByTable
    );
    log.debug("widget_merge_done", { selected: widgetPlanner.widgetPlans.length });

    // ── Stage 3: Final plan (with one validation-driven retry) ───────────────
    let final!: FinalPlanResult;
    let normalized!: NormalizedPlan;
    let validation!: ReturnType<typeof validatePlan>;
    let validationFeedback: string | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      final = await finalPlanSubagent.run({
        query, schema: schemaForAgents, grounded, meta, widgetPlanner, widgetAgentOutputs: rawWidgetPlans, capabilities, objective, validationFeedback,
      });

      const normalizedBase = normalizeWidgets(
        final.plan.widgets,
        final.plan.title,
        grounded.candidateTables,
        allowedTypes,
        grounded.projectedColumnsByTable
      );
      normalized = ensureKpiCoverage(normalizedBase, capabilities, objective, allowedTypes);
      validation = validatePlan(normalized.widgets, capabilities, query, objective, grounded.projectedColumnsByTable);

      if (validation.accepted || attempt === 1) break;

      // First attempt failed — inject feedback and retry once
      validationFeedback = validation.feedback;
      log.info("plan_validation_retry", { score: validation.score, hardFailures: validation.hardFailures.length });
    }

    todoListState = applyAgentTodoUpdates(todoListState, FINAL_AGENT_NAME, [
      { todoId: agentTodoId(FINAL_AGENT_NAME), status: "done" },
    ]);
    const repaired = applyDeterministicHardFailureRepair({
      normalized,
      validation,
      capabilities,
      query,
      objective,
      projectedColumnsByTable: grounded.projectedColumnsByTable,
    });
    const effectiveNormalized = repaired.repaired ? repaired.normalized : normalized;
    const effectiveValidation = repaired.repaired ? repaired.validation : validation;
    if (repaired.repaired) {
      log.info("plan_hard_failure_repaired", {
        removedTitles: repaired.removedTitles,
        score: effectiveValidation.score,
      });
    }
    const rejectedWidgetReasons = rawWidgetPlans.filter((w) => !w.applicable).map((w) => w.rationale).filter(Boolean);
    const kpiMathViolationCount = effectiveValidation.hardFailures.filter((h) => h.toLowerCase().includes("(kpi)")).length;
    log.info("planner_quality_summary", {
      objectiveMode: objective.mode,
      score: effectiveValidation.score,
      accepted: effectiveValidation.accepted,
      hardFailureCount: effectiveValidation.hardFailures.length,
      kpiMathViolationCount,
      rejectedWidgetReasons,
    });

    if (effectiveNormalized.widgets.length === 0) {
      return {
        queryPlan: { title: "AI Analytics Dashboard", actionable_plan: "Planning failed", widgets: [] },
        title: "AI Analytics Dashboard",
        rawPlan: "",
        widgets: [],
        filters: meta.filterCandidates,
        status: "Planning failed: final plan contains no valid widgets.",
      };
    }
    if (!effectiveValidation.accepted) {
      const hardFailureDetail = effectiveValidation.hardFailures.length > 0
        ? ` hard-failures=${effectiveValidation.hardFailures.join(" | ")}`
        : "";
      return {
        queryPlan: { title: "AI Analytics Dashboard", actionable_plan: "Planning failed", widgets: [] },
        title: "AI Analytics Dashboard",
        rawPlan: "",
        widgets: [],
        filters: meta.filterCandidates,
        status: `Planning failed: plan quality below threshold (${effectiveValidation.score}).${hardFailureDetail}`,
      };
    }

    const queryPlan: PlannerQueryPlan = {
      title: effectiveNormalized.title,
      actionable_plan: final.draft,
      widgets: effectiveNormalized.widgets,
    };
    (queryPlan as any).todoListState = todoListState;

    const rawPlan = buildPlanTextFromStructuredPlan(effectiveNormalized, query);
    const rawPlanWithEvents = `${rawPlan}\n\nEVENT_STREAM:\n${JSON.stringify({ type: "planner_agents", content: plannerAgentNames.join(", ") })}`;

    return {
      queryPlan,
      title: effectiveNormalized.title,
      rawPlan: rawPlanWithEvents,
      widgets: effectiveNormalized.widgets,
      filters: meta.filterCandidates,
      todoListState,
      status: "Plan generated by LLM planner agents.",
    };
  } catch (err: any) {
    log.error("planner_failed", { error: err?.message });
    return {
      queryPlan: { title: "AI Analytics Dashboard", actionable_plan: "Planning failed", widgets: [] },
      title: "AI Analytics Dashboard",
      rawPlan: "",
      widgets: [],
      filters: [],
      status: `Planning failed: ${err?.message || String(err)}`,
    };
  }
}

// ── Streaming planner ─────────────────────────────────────────────────────────

export async function* runDashboardPlannerStream(
  query: string,
  schema: any,
  planningObjective?: Partial<PlanningObjective>
): AsyncGenerator<PlannerStreamItem> {
  const objective = resolvePlanningObjective(planningObjective ?? schema?.planningObjective);
  const initGoalsAgentName = INIT_GOALS_AGENT_NAME;
  const metaIntentAgentName = META_INTENT_AGENT_NAME;
  const domainAgentName = DOMAIN_AGENT_NAME;
  const filterAgentName = FILTER_AGENT_NAME;
  const finalAgentName = FINAL_AGENT_NAME;

  const grounded = createGroundedSchema(schema);
  const mcpEvidenceBlock = await buildPlannerMcpEvidenceBlock(
    String(schema?.connectionString || schema?.dbUrl || schema?.postgresUrl || schema?.mssqlUrl || "").trim() || undefined,
    grounded.candidateTables
  );
  const schemaForAgents = mcpEvidenceBlock ? { ...schema, mcpEvidenceBlock } : schema;
  const allowedTypes = getAllowedWidgetTypes(schema);
  const capabilities: SchemaCapabilities = detectSchemaCapabilities(schema, grounded, allowedTypes);
  const enabledFilterRefs = extractEnabledFilterRefs(schema);
  const plannerAgentNames = buildPlannerAgentNames(capabilities);
  const runId = `plan_${Date.now()}`;
  let todoListState = buildInitialTodoListState({
    runId,
    grounded,
    capabilities,
    enabledFilterRefs,
    agentNames: buildPlannerAgentNamesForTodo(capabilities),
    objective,
  });

  yield { kind: "event", event: { type: "planner_agents", content: plannerAgentNames.join(", ") } };
  yield { kind: "event", event: { type: "todo_list_initialized", todoList: todoListState } };
  yield { kind: "event", event: { type: "todo_summary", summary: todoListState.summary } };
  yield {
    kind: "event",
    event: {
      type: "planner_objective",
      mode: objective.mode,
      constraints: objective.constraints,
    },
  };
  yield {
    kind: "event",
    event: {
      type: "planner_schema_usage",
      tables: grounded.availableTables.length,
      columns: grounded.totalColumns,
      visibleColumns: grounded.visibleColumns,
      hiddenColumns: grounded.hiddenColumns,
      relationships: grounded.relationships,
    },
  };
  yield { kind: "event", event: { type: "planner_intents", intents: inferIntentLabels(query) } };

  let meta!: MetaFilterDomainResult;
  let widgetPlanner!: WidgetPlannerResult;
  let final!: FinalPlanResult;
  let normalized!: NormalizedPlan;
  let activeAgent: string | null = null;

  try {
    if (grounded.candidateTables.length === 0)
      throw new Error("No candidate table has usable columns after visible-column filtering.");

    // ── Agent 1: Init plan goals ─────────────────────────────────────────────
    activeAgent = initGoalsAgentName;
    yield {
      kind: "event",
      event: {
        type: "planner_agent_input",
        agent: initGoalsAgentName,
        content: clipAgentInput([
          `query=${query}`,
          `candidateTables=${grounded.candidateTables.join(", ") || "none"}`,
          `metricColumns=${capabilities.metricColumns.join(", ") || "none"}`,
          `objective=${objective.mode} (minConfidence=${objective.constraints.minConfidence})`,
        ].join("\n")),
      },
    };
    yield { kind: "event", event: { type: "planner_agent_status", agent: initGoalsAgentName, status: "start" } };
    let initGoals!: { draft: string; finalGoal: string; planGoals: string[]; kpiGoals: string[]; availableKpis: string[] };
    for await (const item of runAgentWithLiveTokens(initGoalsAgentName, (onToken) =>
      initPlanGoalsSubagent.run({ query, schema: schemaForAgents, grounded, capabilities, objective }, { onToken })
    )) {
      if (item.kind === "__result") initGoals = item.result;
      else yield item;
    }
    yield { kind: "event", event: { type: "planner_agent_draft", agent: initGoalsAgentName, content: initGoals.draft } };
    yield { kind: "event", event: { type: "planner_agent_status", agent: initGoalsAgentName, status: "done" } };
    {
      const prev = todoListState;
      todoListState = applyAgentTodoUpdates(todoListState, initGoalsAgentName, [
        { todoId: agentTodoId(initGoalsAgentName), status: "done" },
      ]);
      for (const evt of emitTodoDiffEvents(prev, todoListState)) yield { kind: "event", event: evt };
    }
    activeAgent = null;

    // ── Agent 2: Meta intent ─────────────────────────────────────────────────
    activeAgent = metaIntentAgentName;
    yield {
      kind: "event",
      event: {
        type: "planner_agent_input",
        agent: metaIntentAgentName,
        content: clipAgentInput([
          `query=${query}`,
          `candidateTables=${grounded.candidateTables.join(", ") || "none"}`,
          `objective=${objective.mode} (minConfidence=${objective.constraints.minConfidence})`,
          `visibleColumns=${grounded.visibleColumns}, relationships=${grounded.relationships}`,
        ].join("\n")),
      },
    };
    yield { kind: "event", event: { type: "planner_agent_status", agent: metaIntentAgentName, status: "start" } };
    let metaIntent!: { draft: string; intentLabels: string[] };
    for await (const item of runAgentWithLiveTokens(metaIntentAgentName, (onToken) =>
      metaIntentSubagent.run({
        query,
        schema: schemaForAgents,
        grounded,
        finalGoal: initGoals.finalGoal,
        planGoals: initGoals.planGoals,
        kpiGoals: initGoals.kpiGoals,
        availableKpis: initGoals.availableKpis,
        objective,
      }, { onToken })
    )) {
      if (item.kind === "__result") metaIntent = item.result;
      else yield item;
    }
    yield { kind: "event", event: { type: "planner_agent_draft", agent: metaIntentAgentName, content: metaIntent.draft } };
    yield { kind: "event", event: { type: "planner_agent_status", agent: metaIntentAgentName, status: "done" } };
    {
      const prev = todoListState;
      todoListState = applyAgentTodoUpdates(todoListState, metaIntentAgentName, [
        { todoId: agentTodoId(metaIntentAgentName), status: "done" },
      ]);
      for (const evt of emitTodoDiffEvents(prev, todoListState)) yield { kind: "event", event: evt };
    }
    activeAgent = null;

    // ── Agent 3: Domain focus ────────────────────────────────────────────────
    activeAgent = domainAgentName;
    yield {
      kind: "event",
      event: {
        type: "planner_agent_input",
        agent: domainAgentName,
        content: clipAgentInput([
          `query=${query}`,
          `intentLabels=${metaIntent.intentLabels.join(", ") || "none"}`,
          `candidateTables=${grounded.candidateTables.join(", ") || "none"}`,
          `relationships=${grounded.relationships}`,
        ].join("\n")),
      },
    };
    yield { kind: "event", event: { type: "planner_agent_status", agent: domainAgentName, status: "start" } };
    let domainFocus!: { draft: string; domain: string; primaryTable: string; domainGuidance: string };
    for await (const item of runAgentWithLiveTokens(domainAgentName, (onToken) =>
      domainFocusSubagent.run({
        query,
        schema: schemaForAgents,
        grounded,
        intentLabels: metaIntent.intentLabels,
        finalGoal: initGoals.finalGoal,
        planGoals: initGoals.planGoals,
        kpiGoals: initGoals.kpiGoals,
        availableKpis: initGoals.availableKpis,
        objective,
      }, { onToken })
    )) {
      if (item.kind === "__result") domainFocus = item.result;
      else yield item;
    }
    yield { kind: "event", event: { type: "planner_agent_draft", agent: domainAgentName, content: domainFocus.draft } };
    yield { kind: "event", event: { type: "planner_agent_status", agent: domainAgentName, status: "done" } };
    {
      const prev = todoListState;
      todoListState = applyAgentTodoUpdates(todoListState, domainAgentName, [
        { todoId: agentTodoId(domainAgentName), status: "done" },
      ]);
      for (const evt of emitTodoDiffEvents(prev, todoListState)) yield { kind: "event", event: evt };
    }
    activeAgent = null;

    // ── Agent 4: Filter candidates ───────────────────────────────────────────
    activeAgent = filterAgentName;
    yield {
      kind: "event",
      event: {
        type: "planner_agent_input",
        agent: filterAgentName,
        content: clipAgentInput([
          `query=${query}`,
          `domain=${domainFocus.domain}`,
          `primaryTable=${domainFocus.primaryTable}`,
          `enabledFilterRefs=${enabledFilterRefs.join(", ") || "none"}`,
          `candidateTables=${grounded.candidateTables.join(", ") || "none"}`,
        ].join("\n")),
      },
    };
    yield { kind: "event", event: { type: "planner_agent_status", agent: filterAgentName, status: "start" } };
    let filterCandidates!: { draft: string; filterCandidates: string[] };
    for await (const item of runAgentWithLiveTokens(filterAgentName, (onToken) =>
      filterCandidatesSubagent.run({
        query,
        schema: schemaForAgents,
        grounded,
        intentLabels: metaIntent.intentLabels,
        domain: domainFocus.domain,
        primaryTable: domainFocus.primaryTable,
        finalGoal: initGoals.finalGoal,
        planGoals: initGoals.planGoals,
        kpiGoals: initGoals.kpiGoals,
        availableKpis: initGoals.availableKpis,
        enabledFilterRefs,
        objective,
      }, { onToken })
    )) {
      if (item.kind === "__result") filterCandidates = item.result;
      else yield item;
    }
    yield { kind: "event", event: { type: "planner_agent_draft", agent: filterAgentName, content: filterCandidates.draft } };
    yield { kind: "event", event: { type: "planner_agent_status", agent: filterAgentName, status: "done" } };
    yield { kind: "event", event: { type: "planner_filter_candidates", filters: filterCandidates.filterCandidates } };
    {
      const prev = todoListState;
      todoListState = applyAgentTodoUpdates(todoListState, filterAgentName, [
        { todoId: agentTodoId(filterAgentName), status: "done" },
        ...filterCandidates.filterCandidates.slice(0, 20).map((ref) => ({ todoId: filterTodoId(ref), status: "done" as const })),
      ]);
      for (const evt of emitTodoDiffEvents(prev, todoListState)) yield { kind: "event", event: evt };
    }

    meta = {
      draft: [initGoals.draft, metaIntent.draft, domainFocus.draft, filterCandidates.draft].filter(Boolean).join("\n\n"),
      finalGoal: initGoals.finalGoal,
      planGoals: initGoals.planGoals,
      kpiGoals: initGoals.kpiGoals,
      availableKpis: initGoals.availableKpis,
      intentLabels: metaIntent.intentLabels,
      domain: domainFocus.domain,
      primaryTable: domainFocus.primaryTable,
      filterCandidates: filterCandidates.filterCandidates,
      domainGuidance: domainFocus.domainGuidance,
    };
    activeAgent = null;

    // ── Agent 5: Parallel widget agents → merger ─────────────────────────────
    let rawWidgetPlans: WidgetAgentOutput[] = [];
    for await (const item of streamWidgetAgentsInParallel({ query, schema: schemaForAgents, grounded, meta, capabilities, objective })) {
      if (item.kind === "__result") {
        rawWidgetPlans = item.result;
      } else {
        yield item;
      }
    }
    {
      const prev = todoListState;
      todoListState = rawWidgetPlans.reduce((acc, w) => {
        if (!w?.widgetType) return acc;
        return applyAgentTodoUpdates(acc, `Widget Agent: ${w.widgetType}`, [
          { todoId: agentTodoId(`Widget Agent: ${w.widgetType}`), status: "done" },
          { todoId: widgetTodoId(w.widgetType), status: w.applicable ? "done" : "blocked", reason: w.rationale || undefined },
          ...String(w.uses || "")
            .split(",")
            .map((x) => x.trim())
            .filter((x) => x.includes("."))
            .slice(0, 12)
            .map((ref) => ({ todoId: columnTodoId(ref), status: "done" as const })),
        ]);
      }, todoListState);
      for (const evt of emitTodoDiffEvents(prev, todoListState)) yield { kind: "event", event: evt };
    }
    widgetPlanner = mergeWidgetPlans(
      rawWidgetPlans,
      meta,
      capabilities,
      objective,
      grounded.projectedColumnsByTable
    );

    // ── Agent 6: Final Plan (with one validation-driven retry) ────────────────
    activeAgent = finalAgentName;
    yield {
      kind: "event",
      event: {
        type: "planner_agent_input",
        agent: finalAgentName,
        content: clipAgentInput([
          `query=${query}`,
          `domain=${meta.domain}`,
          `primaryTable=${meta.primaryTable}`,
          `widgetPlannerCount=${widgetPlanner.widgetPlans.length}`,
          `objective=${objective.mode}`,
        ].join("\n")),
      },
    };
    yield { kind: "event", event: { type: "planner_agent_status", agent: finalAgentName, status: "start" } };

    let validation!: ReturnType<typeof validatePlan>;
    let validationFeedback: string | undefined;

    for (let attempt = 0; attempt < 2; attempt++) {
      for await (const item of runAgentWithLiveTokens(finalAgentName, (onToken) =>
        finalPlanSubagent.run({
          query, schema: schemaForAgents, grounded, meta, widgetPlanner, widgetAgentOutputs: rawWidgetPlans,
          capabilities, objective, validationFeedback,
        }, { onToken })
      )) {
        if (item.kind === "__result") final = item.result;
        else yield item;
      }

      const normalizedBase = normalizeWidgets(
        final.plan.widgets,
        final.plan.title,
        grounded.candidateTables,
        allowedTypes,
        grounded.projectedColumnsByTable
      );
      normalized = ensureKpiCoverage(normalizedBase, capabilities, objective, allowedTypes);

      validation = validatePlan(normalized.widgets, capabilities, query, objective, grounded.projectedColumnsByTable);

      if (validation.accepted || attempt === 1) break;

      // First attempt failed — inject feedback and retry once
      validationFeedback = validation.feedback;
      log.info("plan_validation_retry", { score: validation.score, hardFailures: validation.hardFailures.length });
      yield {
        kind: "event",
        event: { type: "planner_agent_status", agent: finalAgentName, status: "start" },
      };
    }

    if (normalized.widgets.length === 0)
      throw new Error("Final plan contains no valid widgets.");
    if (!validation.accepted) {
      const repaired = applyDeterministicHardFailureRepair({
        normalized,
        validation,
        capabilities,
        query,
        objective,
        projectedColumnsByTable: grounded.projectedColumnsByTable,
      });
      if (repaired.repaired) {
        normalized = repaired.normalized;
        validation = repaired.validation;
        log.info("plan_hard_failure_repaired", {
          removedTitles: repaired.removedTitles,
          score: validation.score,
        });
      }
    }
    if (!validation.accepted)
      throw new Error(
        `Final plan failed quality validation (score=${validation.score}, hardFailures=${validation.hardFailures.length}): ${validation.hardFailures.join(" | ") || "none"}.`
      );

    const kpiMathViolationCount = validation.hardFailures.filter((h) => h.toLowerCase().includes("(kpi)")).length;
    yield {
      kind: "event",
      event: {
        type: "planner_quality_summary",
        objectiveMode: objective.mode,
        score: validation.score,
        accepted: validation.accepted,
        hardFailureCount: validation.hardFailures.length,
        kpiMathViolationCount,
      },
    };
    log.info("planner_quality_summary", {
      objectiveMode: objective.mode,
      score: validation.score,
      accepted: validation.accepted,
      hardFailureCount: validation.hardFailures.length,
      kpiMathViolationCount,
      rejectedWidgetReasons: rawWidgetPlans.filter((w) => !w.applicable).map((w) => w.rationale).filter(Boolean),
    });

    yield { kind: "event", event: { type: "planner_agent_draft", agent: finalAgentName, content: final.draft } };
    yield { kind: "event", event: { type: "planner_agent_status", agent: finalAgentName, status: "done" } };
    {
      const prev = todoListState;
      todoListState = applyAgentTodoUpdates(todoListState, finalAgentName, [
        { todoId: agentTodoId(finalAgentName), status: "done" },
      ]);
      for (const evt of emitTodoDiffEvents(prev, todoListState)) yield { kind: "event", event: evt };
    }
    activeAgent = null;

    // Stream the WIDGET N structured text as chunks for the client parser
    const rawPlan = buildPlanTextFromStructuredPlan(normalized, query);
    const chunks = rawPlan.match(/[\s\S]{1,1200}/g) || [];
    for (const chunk of chunks) {
      yield { kind: "chunk", chunk };
    }
  } catch (err) {
    if (activeAgent) {
      const prev = todoListState;
      todoListState = applyAgentTodoUpdates(todoListState, activeAgent, [
        {
          todoId: agentTodoId(activeAgent),
          status: "failed",
          reason: String((err as any)?.message || err || "Planner agent failed."),
        },
      ]);
      for (const evt of emitTodoDiffEvents(prev, todoListState)) yield { kind: "event", event: evt };
      yield { kind: "event", event: { type: "planner_agent_status", agent: activeAgent, status: "error" } };
    }
    throw err;
  }
}

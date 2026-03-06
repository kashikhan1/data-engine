import type { WidgetAgentOutput } from "./types";
import { resolvePlanningObjective } from "../../../agents/planner/objective";
import type {
  MetaFilterDomainResult,
  PlanningObjective,
  WidgetPlanItem,
  WidgetPlannerResult,
} from "../../../agents/planner/types";
import type { SchemaCapabilities } from "../../../agents/planner/schema-capabilities";

// ── Type ordering ─────────────────────────────────────────────────────────────
// KPIs first → trend charts → categorical charts → specialty → table last
const TYPE_ORDER = [
  "kpi",
  "line",
  "area",
  "bar",
  "donut",
  "pie",
  "scatter",
  "funnel",
  "cohort",
  "map",
  "table",
];

function humanizeMetricColumn(col: string): string {
  const base = String(col || "")
    .replace(/[_\s]+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
  if (!base) return "Metric";
  return base;
}

function buildSyntheticKpiCandidates(
  capabilities: SchemaCapabilities,
  existing: WidgetAgentOutput[],
  minConfidence: number
): WidgetAgentOutput[] {
  const existingUses = new Set(
    existing
      .filter((p) => p.widgetType === "kpi")
      .map((p) => String(p.uses || "").toLowerCase().trim())
      .filter(Boolean)
  );

  const synthetic: WidgetAgentOutput[] = [];
  for (const ref of capabilities.metricColumns || []) {
    const normalizedRef = String(ref || "").trim();
    if (!normalizedRef || !normalizedRef.includes(".")) continue;
    if (existingUses.has(normalizedRef.toLowerCase())) continue;
    const [table, column] = normalizedRef.split(".");
    if (!table || !column) continue;
    const pretty = humanizeMetricColumn(column);
    synthetic.push({
      applicable: true,
      widgetType: "kpi",
      title: pretty.startsWith("Total ") ? pretty : `Total ${pretty}`,
      goal: `Track ${pretty.toLowerCase()} as a headline KPI.`,
      primaryTable: table,
      requiredTables: [table],
      uses: normalizedRef,
      rationale: "Synthetic KPI candidate derived from a safe metric column to improve KPI coverage.",
      notes: `Compute with SUM(COALESCE(${column}, 0)) unless metric semantics require AVG/COUNT DISTINCT.`,
      confidence: Math.max(85, minConfidence),
    });
  }
  return synthetic.slice(0, 4);
}

function typeRank(widgetType: string): number {
  const idx = TYPE_ORDER.indexOf(widgetType);
  return idx === -1 ? TYPE_ORDER.length : idx;
}

// ── Merger ────────────────────────────────────────────────────────────────────

/**
 * Rule-based merger — no LLM call.
 * Selects the best 3–6 widgets from parallel agent outputs, enforcing:
 * - Only applicable results
 * - Sorted by confidence descending (within each type)
 * - Max 2 widgets of the same type (KPI max 4)
 * - Dashboard ordering: KPI → trend → categorical → specialty → table
 * - Hard limit of 6 widgets
 *
 * Produces a `WidgetPlannerResult` that is drop-in compatible with `FinalPlanInput`.
 */
export function mergeWidgetPlans(
  plans: WidgetAgentOutput[],
  meta: MetaFilterDomainResult,
  capabilities: SchemaCapabilities,
  objectiveInput?: Partial<PlanningObjective>,
  projectedColumnsByTable?: Record<string, string[]>
): WidgetPlannerResult {
  const objective = resolvePlanningObjective(objectiveInput);
  const isAccuracyFirst = objective.mode === "accuracy_first";
  const minConfidence = objective.constraints.minConfidence;
  const desiredKpiCount =
    capabilities.metricColumns.length >= 3 ? 3 :
    capabilities.metricColumns.length >= 2 ? 2 :
    capabilities.metricColumns.length >= 1 ? 1 : 0;

  const parseRefs = (uses: string): string[] =>
    String(uses || "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.includes("."));
  const rateSet = new Set((capabilities.rateColumns || []).map((x) => String(x).toLowerCase()));
  const metricSet = new Set((capabilities.metricColumns || []).map((x) => String(x).toLowerCase()));
  const numericSet = new Set((capabilities.numericColumns || []).map((x) => String(x).toLowerCase()));
  const allSchemaRefs = new Set<string>();
  if (projectedColumnsByTable) {
    for (const [table, cols] of Object.entries(projectedColumnsByTable)) {
      for (const col of cols || []) allSchemaRefs.add(`${table}.${col}`.toLowerCase());
    }
  }
  const hasJoinSafetyNote = (notes: string): boolean => String(notes || "").toLowerCase().includes("join");
  const hasRateFormula = (notes: string): boolean => {
    const n = String(notes || "").toLowerCase();
    return n.includes("/") || n.includes("nullif") || n.includes("case when");
  };
  const isIdLikeRef = (ref: string): boolean => {
    const col = String(ref || "").split(".").pop() || "";
    return /^id$|_id$|^fk_|^pk_|user_id|order_id|customer_id|product_id|account_id|session_id|transaction_id/i.test(col);
  };
  const computeCorrectnessBonus = (p: WidgetAgentOutput): number => {
    let bonus = 0;
    const refs = parseRefs(p.uses).map((r) => r.toLowerCase());
    if (refs.length > 0) bonus += 10;
    if (allSchemaRefs.size > 0 && refs.every((ref) => allSchemaRefs.has(ref))) bonus += 8;
    if (p.widgetType === "kpi") {
      const hasNumeric = refs.some((ref) => numericSet.has(ref));
      if (hasNumeric) bonus += 10;
      const hasRateOnly = refs.some((ref) => rateSet.has(ref)) && !refs.some((ref) => metricSet.has(ref));
      if (hasRateOnly && hasRateFormula(p.notes)) bonus += 8;
      if (refs.some((ref) => isIdLikeRef(ref))) bonus -= 20;
      if (hasRateOnly && !hasRateFormula(p.notes)) bonus -= 18;
    }
    if (p.requiredTables.length > 1) {
      bonus += hasJoinSafetyNote(p.notes) ? 6 : -14;
    }
    return bonus;
  };

  // 1. Keep only applicable results with a valid primary table
  const baseApplicable = plans.filter((p) => p.applicable && p.primaryTable && p.confidence >= 50);
  const syntheticKpis = buildSyntheticKpiCandidates(capabilities, baseApplicable, minConfidence);
  const applicable = [...baseApplicable, ...syntheticKpis].filter((p) => {
    const refs = parseRefs(p.uses).map((r) => r.toLowerCase());
    if (isAccuracyFirst && refs.length === 0) return false;
    if (isAccuracyFirst && allSchemaRefs.size > 0 && refs.some((ref) => !allSchemaRefs.has(ref))) return false;
    if (isAccuracyFirst && p.widgetType === "kpi") {
      const hasRateOnly = refs.some((ref) => rateSet.has(ref)) && !refs.some((ref) => metricSet.has(ref));
      if (hasRateOnly && !hasRateFormula(p.notes)) return false;
      if (refs.some((ref) => isIdLikeRef(ref))) return false;
    }
    if (isAccuracyFirst && p.requiredTables.length > 1 && !hasJoinSafetyNote(p.notes)) return false;
    return true;
  });

  // 2. Score by confidence + correctness bonuses - redundancy penalties
  const ranked = [...applicable]
    .map((p) => {
      const redundancyPenalty = String(p.uses || "").trim() ? 0 : 8;
      let score = p.confidence + computeCorrectnessBonus(p) - redundancyPenalty;
      if (isAccuracyFirst && p.confidence < minConfidence) score -= 25;
      if (isAccuracyFirst && p.widgetType === "kpi" && p.confidence >= minConfidence) score += 10;
      return { plan: p, score };
    })
    .sort((a, b) => b.score - a.score);
  const sorted = ranked.map((r) => r.plan);
  const highConfidence = sorted.filter((p) => p.confidence >= minConfidence);

  // 3. Build a balanced backbone first (KPI -> trend -> comparison)
  const trendTypes = new Set(["line", "area", "cohort"]);
  const comparisonTypes = new Set(["bar", "donut", "pie", "table"]);
  const selected: WidgetAgentOutput[] = [];
  const selectedIds = new Set<string>();
  const selectedKey = (p: WidgetAgentOutput) => `${p.widgetType}:${p.title}:${String(p.uses || "").toLowerCase().trim()}`;

  const preferredPool = isAccuracyFirst ? highConfidence : sorted;
  const sortedForBackbone = preferredPool.length > 0 ? preferredPool : sorted;
  const addFirstByFrom = (pool: WidgetAgentOutput[], predicate: (p: WidgetAgentOutput) => boolean) => {
    const next = pool.find((p) => !selectedIds.has(selectedKey(p)) && predicate(p));
    if (!next) return;
    selected.push(next);
    selectedIds.add(selectedKey(next));
  };

  // Require a high-confidence KPI when metric columns exist in accuracy mode
  if (isAccuracyFirst && capabilities.metricColumns.length > 0) {
    addFirstByFrom(highConfidence, (p) => p.widgetType === "kpi");
  } else {
    addFirstByFrom(sortedForBackbone, (p) => p.widgetType === "kpi");
  }
  addFirstByFrom(sortedForBackbone, (p) => trendTypes.has(p.widgetType));
  addFirstByFrom(sortedForBackbone, (p) => comparisonTypes.has(p.widgetType));

  // 4. Enforce max per widget type while filling by confidence
  const typeCounts = new Map<string, number>();
  for (const p of selected) {
    typeCounts.set(p.widgetType, (typeCounts.get(p.widgetType) ?? 0) + 1);
  }
  const redundancyByUses = new Map<string, number>();
  const normalizedUses = (p: WidgetAgentOutput): string =>
    String(p.uses || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean).sort().join("|");

  for (const p of selected) {
    const key = normalizedUses(p);
    if (key) redundancyByUses.set(key, (redundancyByUses.get(key) ?? 0) + 1);
  }

  for (const p of sorted) {
    if (selectedIds.has(selectedKey(p))) continue;
    if (isAccuracyFirst && p.confidence < minConfidence) continue;

    const usesKey = normalizedUses(p);
    if (usesKey) {
      const redundancyCount = redundancyByUses.get(usesKey) ?? 0;
      if (redundancyCount > objective.constraints.maxWidgetRedundancy) continue;
    }

    const count = typeCounts.get(p.widgetType) ?? 0;
    const maxPerType = p.widgetType === "kpi" ? 4 : 2;
    if (count < maxPerType) {
      selected.push(p);
      typeCounts.set(p.widgetType, count + 1);
      selectedIds.add(selectedKey(p));
      if (usesKey) redundancyByUses.set(usesKey, (redundancyByUses.get(usesKey) ?? 0) + 1);
    }
  }

  // 4b. Ensure KPI coverage from metric columns (especially for accuracy_first).
  if (desiredKpiCount > 1) {
    const currentKpis = selected.filter((p) => p.widgetType === "kpi").length;
    if (currentKpis < desiredKpiCount) {
      for (const p of sorted) {
        if (p.widgetType !== "kpi") continue;
        if (selectedIds.has(selectedKey(p))) continue;
        const usesKey = normalizedUses(p);
        const redundancyCount = usesKey ? (redundancyByUses.get(usesKey) ?? 0) : 0;
        if (usesKey && redundancyCount > objective.constraints.maxWidgetRedundancy) continue;
        selected.push(p);
        selectedIds.add(selectedKey(p));
        typeCounts.set("kpi", (typeCounts.get("kpi") ?? 0) + 1);
        if (usesKey) redundancyByUses.set(usesKey, redundancyCount + 1);
        if (selected.filter((x) => x.widgetType === "kpi").length >= desiredKpiCount) break;
      }
    }
  }

  // 5. Keep at least 3 widgets when possible.
  if (selected.length < 3 && sorted.length >= 3) {
    for (const p of sorted) {
      if (selected.length >= 3) break;
      if (selectedIds.has(selectedKey(p))) continue;
      if (isAccuracyFirst && p.confidence < minConfidence) continue;
      selected.push(p);
      selectedIds.add(selectedKey(p));
    }
  }

  // 6. Re-sort by dashboard ordering (KPI first → table last)
  selected.sort((a, b) => typeRank(a.widgetType) - typeRank(b.widgetType));

  // 7. Hard limit of 6 widgets (prefer fewer under weak confidence in accuracy mode)
  const maxWidgets = isAccuracyFirst && highConfidence.length <= 4 ? 4 : 6;
  const final = selected.slice(0, maxWidgets);

  // 8. Build a human-readable draft summary
  const typeList = [...new Set(final.map((p) => p.widgetType))].join(", ");
  const draft =
    final.length > 0
      ? `Dashboard plan includes ${final.length} widget${final.length > 1 ? "s" : ""}: ${typeList}. ` +
        `Selected from ${applicable.length} applicable results across all widget agents for ${meta.domain}. ` +
        `KPI coverage target=${desiredKpiCount}, selected=${final.filter((p) => p.widgetType === "kpi").length}. ` +
        `Objective mode: ${objective.mode}.`
      : "No applicable widgets were selected. The final plan agent will determine the best widgets from the schema.";

  const widgetPlans: WidgetPlanItem[] = final.map((p) => ({
    type: p.widgetType,
    title: p.title,
    goal: p.goal,
    primaryTable: p.primaryTable,
    requiredTables: p.requiredTables,
    uses: p.uses,
    rationale: `${p.rationale} (confidence: ${p.confidence}/100)`,
  }));

  return { draft, widgetPlans };
}

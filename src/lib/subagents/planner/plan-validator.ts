import type { SchemaCapabilities } from "../../agents/planner/schema-capabilities";
import { resolvePlanningObjective } from "../../agents/planner/objective";
import type { NormalizedWidget, PlanningObjective } from "../../agents/planner/types";

// ── Result type ───────────────────────────────────────────────────────────────

export type PlanValidationResult = {
  /** 0–100: 100 = perfect, 0 = completely invalid */
  score: number;
  /** true when score >= ACCEPTANCE_THRESHOLD */
  accepted: boolean;
  /** Human-readable issue descriptions */
  issues: string[];
  /** Accuracy-first hard failures that always reject the plan */
  hardFailures: string[];
  /** Feedback string injected into the retry prompt when !accepted */
  feedback: string;
};

const ACCEPTANCE_THRESHOLD = 65;

// ── Severity weights ──────────────────────────────────────────────────────────

const DEDUCTION = {
  missingUses: 20,       // widget has no valid table.column refs
  wrongTypeForData: 15,  // type requires data that schema doesn't have
  lowTypeMatch: 10,      // type may work but data support is weak
  styleWarning: 5,       // minor quality concern
} as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract valid "table.column" references from the uses string. */
function parseUsedRefs(uses: string): string[] {
  return uses.split(",").map((s) => s.trim()).filter((s) => s.includes("."));
}

function toLowerSet(values: string[]): Set<string> {
  return new Set(values.map((v) => String(v).toLowerCase()));
}

function isIdLikeColumnRef(ref: string): boolean {
  const col = ref.split(".").pop() || ref;
  return /^id$|_id$|^fk_|^pk_|user_id|order_id|customer_id|product_id|account_id|session_id|transaction_id/i.test(col);
}

function hasExplicitRateFormula(notes: string): boolean {
  const n = String(notes || "").toLowerCase();
  return n.includes("/") || n.includes("nullif") || n.includes("case when");
}

/**
 * Detect widgets whose column references are all identical — a strong signal that
 * two widgets are answering the same question with a different chart type.
 */
function findRedundantPairs(widgets: NormalizedWidget[]): string[] {
  const issues: string[] = [];
  for (let i = 0; i < widgets.length; i++) {
    for (let j = i + 1; j < widgets.length; j++) {
      const refsA = new Set(parseUsedRefs(widgets[i].uses));
      const refsB = new Set(parseUsedRefs(widgets[j].uses));
      if (refsA.size === 0 || refsB.size === 0) continue;
      const intersection = [...refsA].filter((r) => refsB.has(r));
      if (intersection.length > 0 && intersection.length === refsA.size && intersection.length === refsB.size) {
        issues.push(
          `"${widgets[i].title}" (${widgets[i].type}) and "${widgets[j].title}" (${widgets[j].type}) reference identical columns (${intersection.join(", ")}) — they will show the same data in different chart skins. Merge or differentiate.`
        );
      }
    }
  }
  return issues;
}

// ── Validator ─────────────────────────────────────────────────────────────────

/**
 * Rule-based plan validator. No LLM call — runs synchronously after normalization.
 * Returns a quality score and structured feedback for the self-correcting retry loop.
 *
 * @param projectedColumnsByTable - ALL schema columns per table (from GroundedSchema).
 *   When provided, strictSchemaRefs checks against the full column list instead of
 *   the narrower role-detected capability set (which excludes valid columns like
 *   department, score, rank that don't match semantic role patterns).
 */
export function validatePlan(
  widgets: NormalizedWidget[],
  capabilities: SchemaCapabilities,
  query?: string,
  objectiveInput?: Partial<PlanningObjective>,
  projectedColumnsByTable?: Record<string, string[]>
): PlanValidationResult {
  const objective = resolvePlanningObjective(objectiveInput);
  const issues: string[] = [];
  const hardFailures: string[] = [];
  let deductions = 0;

  const temporalSet = toLowerSet(capabilities.temporalColumns);
  const numericSet = toLowerSet(capabilities.numericColumns);
  const categoricalSet = toLowerSet(capabilities.categoricalColumns);
  const geoSet = toLowerSet(capabilities.geographicColumns);
  const funnelSet = toLowerSet(capabilities.funnelColumns);
  const metricSet = toLowerSet(capabilities.metricColumns);
  const rateSet = toLowerSet(capabilities.rateColumns);
  const capabilityRefSet = toLowerSet([
    ...capabilities.temporalColumns,
    ...capabilities.numericColumns,
    ...capabilities.metricColumns,
    ...capabilities.rateColumns,
    ...capabilities.categoricalColumns,
    ...capabilities.geographicColumns,
    ...capabilities.funnelColumns,
    ...capabilities.highCardinalityCols,
  ]);

  // ── Per-widget rules ──────────────────────────────────────────────────────

  for (const w of widgets) {
    const usedRefs = parseUsedRefs(w.uses);
    const usedRefsLower = usedRefs.map((ref) => ref.toLowerCase());

    // Every widget must have at least one resolvable column reference
    if (usedRefs.length === 0) {
      issues.push(`"${w.title}" (${w.type}): no valid table.column references — SQL generation will fail.`);
      deductions += DEDUCTION.missingUses;
    }

    // Temporal widgets require at least one date/time column
    if (["line", "area", "cohort"].includes(w.type) && capabilities.temporalColumns.length === 0) {
      issues.push(`"${w.title}" (${w.type}): schema has no temporal columns — replace with "bar".`);
      deductions += DEDUCTION.wrongTypeForData;
    }
    if (["line", "area", "cohort"].includes(w.type) && usedRefs.length > 0) {
      const hasTemporalRef = usedRefsLower.some((ref) => temporalSet.has(ref));
      if (!hasTemporalRef) {
        issues.push(`"${w.title}" (${w.type}): widget references no temporal column in uses.`);
        deductions += DEDUCTION.wrongTypeForData;
      }
    }

    // KPI needs something to aggregate
    if (w.type === "kpi" && capabilities.numericColumns.length === 0) {
      issues.push(`"${w.title}" (kpi): no numeric columns detected — KPI metric cannot be computed.`);
      deductions += DEDUCTION.lowTypeMatch;
      if (objective.constraints.strictMath) {
        hardFailures.push(`"${w.title}" (kpi): no numeric metric backing exists in schema.`);
      }
    }
    if (w.type === "kpi" && usedRefs.length > 0) {
      const hasNumericRef = usedRefsLower.some((ref) => numericSet.has(ref));
      if (!hasNumericRef) {
        issues.push(`"${w.title}" (kpi): widget references no numeric column in uses.`);
        deductions += DEDUCTION.lowTypeMatch;
        if (objective.constraints.strictMath) {
          hardFailures.push(`"${w.title}" (kpi): references no numeric column and cannot compute KPI.`);
        }
      }

      if (objective.constraints.strictMath) {
        const hasRateRef = usedRefsLower.some((ref) => rateSet.has(ref));
        const hasMetricRef = usedRefsLower.some((ref) => metricSet.has(ref));
        if (hasRateRef && !hasMetricRef && !hasExplicitRateFormula(w.notes)) {
          hardFailures.push(`"${w.title}" (kpi): uses only rate/ratio columns without an explicit numerator/denominator formula.`);
        }

        const numericRefs = usedRefsLower.filter((ref) => numericSet.has(ref));
        if (numericRefs.some((ref) => isIdLikeColumnRef(ref))) {
          hardFailures.push(`"${w.title}" (kpi): uses ID/FK-like numeric columns as a metric.`);
        }
      }
    }

    // Map needs geographic data
    if (w.type === "map" && capabilities.geographicColumns.length === 0) {
      issues.push(`"${w.title}" (map): no geographic columns — map widget cannot render.`);
      deductions += DEDUCTION.wrongTypeForData;
    }
    if (w.type === "map" && usedRefs.length > 0) {
      const hasGeoRef = usedRefsLower.some((ref) => geoSet.has(ref));
      if (!hasGeoRef) {
        issues.push(`"${w.title}" (map): widget references no geographic column in uses.`);
        deductions += DEDUCTION.wrongTypeForData;
        if (objective.mode === "accuracy_first") {
          hardFailures.push(`"${w.title}" (map): missing geographic column reference.`);
        }
      }
    }

    // Funnel needs stage/step columns
    if (w.type === "funnel" && capabilities.funnelColumns.length === 0) {
      issues.push(`"${w.title}" (funnel): no stage or step columns — funnel sequence undefined.`);
      deductions += DEDUCTION.wrongTypeForData;
    }
    if (w.type === "funnel" && usedRefs.length > 0) {
      const hasFunnelRef = usedRefsLower.some((ref) => funnelSet.has(ref));
      if (!hasFunnelRef) {
        issues.push(`"${w.title}" (funnel): widget references no stage/step column in uses.`);
        deductions += DEDUCTION.wrongTypeForData;
        if (objective.mode === "accuracy_first") {
          hardFailures.push(`"${w.title}" (funnel): missing stage/step column reference.`);
        }
      }
    }

    // Scatter needs 2+ numeric axes
    if (w.type === "scatter" && capabilities.numericColumns.length < 2) {
      issues.push(`"${w.title}" (scatter): scatter requires 2 numeric columns, ${capabilities.numericColumns.length} found.`);
      deductions += DEDUCTION.wrongTypeForData;
    }
    if (w.type === "scatter" && usedRefs.length > 0) {
      const distinctNumericRefs = new Set(usedRefsLower.filter((ref) => numericSet.has(ref)));
      if (distinctNumericRefs.size < 2) {
        issues.push(`"${w.title}" (scatter): widget uses fewer than 2 numeric columns.`);
        deductions += DEDUCTION.wrongTypeForData;
      }
    }

    // Pie/donut works best with low-cardinality categories
    if (["donut", "pie"].includes(w.type) && capabilities.categoricalColumns.length === 0) {
      issues.push(`"${w.title}" (${w.type}): no categorical columns — chart may lack meaningful grouping.`);
      deductions += DEDUCTION.lowTypeMatch;
    }
    if (["donut", "pie"].includes(w.type) && usedRefs.length > 0) {
      const hasCategoricalRef = usedRefsLower.some((ref) => categoricalSet.has(ref));
      if (!hasCategoricalRef) {
        issues.push(`"${w.title}" (${w.type}): widget references no categorical column in uses.`);
        deductions += DEDUCTION.lowTypeMatch;
      }
    }

    // Bar used as time series is a chart type mismatch — line/area is the right choice
    if (w.type === "bar" && capabilities.temporalColumns.length > 0) {
      const usesOnlyTemporalRefs = usedRefs.length > 0 && usedRefs.every((ref) =>
        temporalSet.has(ref.toLowerCase())
      );
      if (usesOnlyTemporalRefs) {
        issues.push(`"${w.title}" (bar): all referenced columns are temporal — use "line" or "area" for time-series data.`);
        deductions += DEDUCTION.styleWarning;
      }
    }

    // Cohort requires BOTH a signup/first-touch temporal column AND an activity temporal column
    if (w.type === "cohort" && capabilities.temporalColumns.length < 2) {
      issues.push(`"${w.title}" (cohort): cohort analysis requires at least 2 temporal columns (e.g. signup_date + activity_date), only ${capabilities.temporalColumns.length} found.`);
      deductions += DEDUCTION.wrongTypeForData;
    }

    if (objective.constraints.strictSchemaRefs) {
      if (projectedColumnsByTable) {
        // Use ALL schema columns — not just role-detected ones — to avoid false positives
        // for valid columns like "department", "score", "rank" that don't match role patterns.
        const allSchemaRefs = new Set<string>();
        for (const [table, cols] of Object.entries(projectedColumnsByTable)) {
          for (const col of cols) allSchemaRefs.add(`${table}.${col}`.toLowerCase());
        }
        const unknownRefs = usedRefsLower.filter((ref) => !allSchemaRefs.has(ref));
        if (unknownRefs.length > 0) {
          hardFailures.push(`"${w.title}" (${w.type}): references columns not in the schema (${unknownRefs.join(", ")}).`);
        }
      } else {
        // Fallback when full schema isn't available: soft deduction only (not a hard failure)
        // because capabilityRefSet only covers role-detected columns, not all columns.
        const unknownRefs = usedRefsLower.filter((ref) => !capabilityRefSet.has(ref));
        if (unknownRefs.length > 0) {
          issues.push(`"${w.title}" (${w.type}): references columns not in detected capability sets (${unknownRefs.join(", ")}).`);
          deductions += DEDUCTION.lowTypeMatch;
        }
      }
    }

    if (objective.constraints.strictMath && w.requiredTables.length > 1) {
      const notes = String(w.notes || "").toLowerCase();
      if (!notes.includes("join")) {
        hardFailures.push(`"${w.title}" (${w.type}): multi-table widget is missing join safety guidance in notes.`);
      }
    }
  }

  // ── Cross-widget rules ────────────────────────────────────────────────────

  // At least one KPI when aggregatable metric data is available
  const hasKpi = widgets.some((w) => w.type === "kpi");
  const hasAggregatable = (capabilities.metricColumns?.length ?? capabilities.numericColumns.length) > 0;
  if (!hasKpi && hasAggregatable && widgets.length > 0) {
    issues.push("No KPI widget despite numeric measure columns being available — add a headline metric.");
    deductions += DEDUCTION.styleWarning;
  }
  const kpiCount = widgets.filter((w) => w.type === "kpi").length;
  if (objective.mode === "accuracy_first" && capabilities.metricColumns.length >= 2 && kpiCount < 2) {
    issues.push(`Only ${kpiCount} KPI widget(s) found despite multiple safe metric columns — add at least 2 KPIs in accuracy_first mode.`);
    deductions += DEDUCTION.lowTypeMatch;
  }

  // No more than 2 of the same widget type (except KPI which can appear up to 4 times)
  const typeCounts = widgets.reduce<Record<string, number>>((acc, w) => {
    acc[w.type] = (acc[w.type] ?? 0) + 1;
    return acc;
  }, {});
  for (const [type, count] of Object.entries(typeCounts)) {
    const maxAllowed = type === "kpi" ? 4 : 2;
    if (count > maxAllowed) {
      issues.push(`${count} widgets of type "${type}" — reduce to at most ${maxAllowed} for clarity.`);
      deductions += DEDUCTION.styleWarning;
    }
  }

  // Too many KPIs makes the dashboard feel like a scoreboard with no story
  const kpiCountByType = typeCounts["kpi"] ?? 0;
  if (kpiCountByType > 4) {
    issues.push(`${kpiCountByType} KPI widgets is excessive — keep 1-4 headline metrics; consolidate the rest.`);
    deductions += DEDUCTION.styleWarning;
  }

  // Detect fully redundant widget pairs (same column refs, different chart type)
  const redundantIssues = findRedundantPairs(widgets);
  for (const ri of redundantIssues) {
    issues.push(ri);
    deductions += DEDUCTION.lowTypeMatch;
  }
  if (objective.mode === "accuracy_first" && redundantIssues.length >= 2) {
    hardFailures.push("Plan contains multiple duplicate-insight widget pairs; reduce redundancy before finalizing.");
  }

  // ── Query-intent coverage rules ───────────────────────────────────────────

  const normalizedQuery = String(query || "").toLowerCase();
  const hasTrendWidget = widgets.some((w) => ["line", "area", "cohort"].includes(w.type));
  const hasComparisonWidget = widgets.some((w) => ["bar", "table", "pie", "donut"].includes(w.type));
  const hasFunnelWidget = widgets.some((w) => w.type === "funnel");
  const hasGeoWidget = widgets.some((w) => w.type === "map");

  if (
    (normalizedQuery.includes("trend") || normalizedQuery.includes("over time")) &&
    capabilities.temporalColumns.length > 0 &&
    !hasTrendWidget
  ) {
    issues.push("Query asks for trend/time analysis but plan has no temporal widget (line/area/cohort).");
    deductions += DEDUCTION.wrongTypeForData;
  }

  if (
    (normalizedQuery.includes("top") || normalizedQuery.includes("compare") || normalizedQuery.includes("breakdown")) &&
    !hasComparisonWidget
  ) {
    issues.push("Query asks for comparison/breakdown but plan lacks a comparison-oriented widget (bar/pie/donut/table).");
    deductions += DEDUCTION.lowTypeMatch;
  }

  if (
    (normalizedQuery.includes("funnel") || normalizedQuery.includes("conversion")) &&
    capabilities.funnelColumns.length > 0 &&
    !hasFunnelWidget
  ) {
    issues.push("Query implies conversion funnel but plan does not include a funnel widget.");
    deductions += DEDUCTION.lowTypeMatch;
  }

  if (
    (normalizedQuery.includes("region") || normalizedQuery.includes("country") || normalizedQuery.includes("map")) &&
    capabilities.geographicColumns.length > 0 &&
    !hasGeoWidget
  ) {
    issues.push("Query implies geography analysis but plan does not include a map widget.");
    deductions += DEDUCTION.lowTypeMatch;
  }

  // ── Plan-level structural check ───────────────────────────────────────────

  // A plan with only KPIs and no analytical widget is too shallow
  const analyticalTypes = new Set(["line", "area", "bar", "scatter", "funnel", "cohort", "map", "pie", "donut"]);
  const hasAnalyticalWidget = widgets.some((w) => analyticalTypes.has(w.type));
  if (widgets.length > 1 && !hasAnalyticalWidget) {
    issues.push("Plan contains only KPI/table widgets with no analytical chart — add at least one trend, comparison, or breakdown widget.");
    deductions += DEDUCTION.styleWarning;
  }

  const score = Math.max(0, 100 - deductions);
  const accepted = score >= ACCEPTANCE_THRESHOLD && hardFailures.length === 0;
  const feedback = accepted
    ? ""
    : [
      "Fix these issues in the revised dashboard plan:",
      ...(hardFailures.length > 0 ? ["Hard failures:", ...hardFailures.map((i) => `- ${i}`)] : []),
      ...(issues.length > 0 ? ["Quality issues:", ...issues.map((i) => `- ${i}`)] : []),
    ].join("\n");

  return { score, accepted, issues, hardFailures, feedback };
}

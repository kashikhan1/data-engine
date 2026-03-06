/* eslint-disable @typescript-eslint/no-explicit-any */
import type { NormalizedWidget, NormalizedPlan } from "./types";
import { normalizeWidgetType } from "./schema-utils";

export function ensureNonEmptyStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.map((x) => String(x).trim()).filter(Boolean);
}

export function normalizeFilterCandidates(
  filters: string[],
  candidateTables: string[],
  projectedColumnsByTable: Record<string, string[]>
): string[] {
  const tableSet = new Set(candidateTables.map((t) => t.toLowerCase()));
  const columnSetByTable = new Map(
    Object.entries(projectedColumnsByTable).map(([table, cols]) => [
      table.toLowerCase(),
      new Set(cols.map((c) => c.toLowerCase())),
    ])
  );
  const valid = filters.filter((f) => {
    const [table, column] = String(f).split(".");
    if (!table || !column) return false;
    if (!tableSet.has(table.toLowerCase())) return false;
    const tableColumns = columnSetByTable.get(table.toLowerCase());
    return Boolean(tableColumns?.has(column.toLowerCase()));
  });
  return Array.from(new Set(valid)).slice(0, 12);
}

export function normalizeUsesReferences(
  uses: string,
  projectedColumnsByTable: Record<string, string[]>,
  fallbackTable: string
): string {
  const projectedByLowerTable = new Map<string, Set<string>>();
  for (const [table, cols] of Object.entries(projectedColumnsByTable)) {
    projectedByLowerTable.set(
      table.toLowerCase(),
      new Set((Array.isArray(cols) ? cols : []).map((c) => String(c).toLowerCase()))
    );
  }

  const normalizedRefs = String(uses || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((ref) => ref.includes("."))
    .filter((ref) => {
      const dot = ref.indexOf(".");
      const table = dot === -1 ? "" : ref.slice(0, dot);
      const column = dot === -1 ? "" : ref.slice(dot + 1);
      if (!table || !column) return false;
      const set = projectedByLowerTable.get(table.toLowerCase());
      return Boolean(set?.has(column.toLowerCase()));
    });

  if (normalizedRefs.length > 0) return Array.from(new Set(normalizedRefs)).slice(0, 12).join(", ");

  const fallbackCols = projectedColumnsByTable[fallbackTable] || [];
  if (fallbackCols.length === 0) return "";
  return `${fallbackTable}.${fallbackCols[0]}`;
}

export function normalizeWidgets(
  widgets: any[],
  title: string,
  candidateTables: string[],
  allowedTypes: string[],
  projectedColumnsByTable: Record<string, string[]>
): NormalizedPlan {
  const tablesSet = new Set(candidateTables.map((t) => t.toLowerCase()));
  const ids = new Set<string>();

  const normalized = (Array.isArray(widgets) ? widgets : [])
    .map((w: any, idx: number): NormalizedWidget | null => {
      const type = normalizeWidgetType(w?.type);
      if (!allowedTypes.includes(type)) return null;

      const requiredTablesRaw = Array.isArray(w?.requiredTables)
        ? w.requiredTables.map((t: unknown) => String(t))
        : [];
      const requiredTables = requiredTablesRaw.filter((t: string) => tablesSet.has(t.toLowerCase()));
      const primaryTable = String(w?.primaryTable || requiredTables[0] || candidateTables[0] || "");
      if (!primaryTable || !tablesSet.has(primaryTable.toLowerCase())) return null;

      const baseId = String(w?.id || `w${idx + 1}`);
      let id = baseId;
      let n = 1;
      while (ids.has(id)) id = `${baseId}_${n++}`;
      ids.add(id);

      return {
        id,
        type,
        title: String(w?.title || `Widget ${idx + 1}`),
        goal: String(w?.goal || "Visualization"),
        primaryTable,
        requiredTables: requiredTables.length > 0 ? requiredTables : [primaryTable],
        uses: normalizeUsesReferences(String(w?.uses || ""), projectedColumnsByTable, primaryTable),
        notes: String(w?.notes || w?.rationale || ""),
      };
    })
    .filter((w): w is NormalizedWidget => w !== null);

  return { title: String(title || "AI Analytics Dashboard"), widgets: normalized };
}

export function buildPlanTextFromStructuredPlan(
  plan: { title?: string; widgets?: any[] },
  query: string
): string {
  const title = String(plan?.title || "AI Analytics Dashboard");
  const widgets = Array.isArray(plan?.widgets) ? plan.widgets : [];
  const lines: string[] = [`DASHBOARD TITLE: ${title}`, ""];

  widgets.forEach((w, i) => {
    lines.push(`WIDGET ${i + 1}: ${String(w?.type || "bar")} - ${String(w?.title || `Widget ${i + 1}`)}`);
    if (w?.goal) lines.push(`Shows: ${w.goal}`);
    const tables = Array.isArray(w?.requiredTables) ? w.requiredTables.filter(Boolean) : [];
    if (tables.length > 0) lines.push(`Tables required: ${tables.join(", ")}`);
    if (w?.uses) lines.push(`Uses: ${w.uses}`);
    if (w?.notes) lines.push(`Notes: ${w.notes}`);
    lines.push("");
  });

  if (widgets.length === 0) lines.push(`Dashboard plan for: ${query}`);
  return lines.join("\n").trim();
}

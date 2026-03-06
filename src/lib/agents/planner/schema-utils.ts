/* eslint-disable @typescript-eslint/no-explicit-any */
import { PLANNER_WIDGET_TYPE_ORDER } from "@/types/dashboard";
import type { GroundedSchema } from "./types";

export function getAllowedWidgetTypes(schema: any): string[] {
  const disabledTypes = Array.isArray(schema?.disabledWidgetTypes) ? schema.disabledWidgetTypes : [];
  const allowed = [...PLANNER_WIDGET_TYPE_ORDER].filter((t) => !disabledTypes.includes(t));
  return allowed.length > 0 ? allowed : ["kpi", "bar", "table"];
}

export function getAvailableTables(schema: any): string[] {
  const schemaTables = Object.keys(schema?.schemaInfo || {});
  const allowedTables = Array.isArray(schema?.allowedTables)
    ? schema.allowedTables.map((t: unknown) => String(t))
    : [];
  if (allowedTables.length === 0) return schemaTables;
  const allowedSet = new Set(allowedTables.map((t: string) => t.toLowerCase()));
  return schemaTables.filter((t) => allowedSet.has(String(t).toLowerCase()));
}

export function inferIntentLabels(query: string): string[] {
  const q = String(query || "").toLowerCase();
  if (/\b(subscription|mrr|arr|churn|trial|tenant)\b/.test(q)) return ["SaaS"];
  if (/\b(order|product|sku|checkout|refund|shipment|revenue)\b/.test(q)) return ["E-commerce"];
  if (/\b(ticket|support|sla|resolution|queue)\b/.test(q)) return ["Support"];
  if (/\b(campaign|utm|ads|impression|conversion|lead|funnel)\b/.test(q)) return ["Marketing"];
  return ["General"];
}

export function normalizeWidgetType(inputType: unknown): string {
  const raw = String(inputType || "").toLowerCase().trim();
  if (!raw) return "bar";
  if (raw === "chart" || raw === "column") return "bar";
  if (raw === "stat") return "kpi";
  return raw;
}

export function getColumnName(col: any): string {
  return String(col?.name || col?.column_name || "").trim();
}

export function getColumnType(col: any): string {
  return String(col?.type || col?.data_type || "").trim();
}

export function getConnectorType(schema: any): string {
  return String(schema?.connectorType || "").trim() || "unknown";
}

export function getVisibleColumnList(schema: any, table: string): string[] | null {
  const visible = schema?.visibleColumns;
  if (!visible || typeof visible !== "object") return null;
  if (!Array.isArray(visible?.[table])) return null;
  return visible[table].map((x: unknown) => String(x).trim()).filter(Boolean);
}

/** Returns the set of column names explicitly disabled for filtering by the user, or null if none. */
export function getDisabledFilterColumnSet(schema: any, table: string): Set<string> | null {
  const disabled = schema?.disabledFilterColumns;
  if (!disabled || typeof disabled !== "object") return null;
  if (!Array.isArray(disabled[table])) return null;
  return new Set(disabled[table].map((x: unknown) => String(x).trim().toLowerCase()));
}

/** @deprecated use getDisabledFilterColumnSet */
export function getFilterableColumnList(schema: any, table: string): Set<string> | null {
  return getDisabledFilterColumnSet(schema, table);
}

export function getSchemaColumns(schema: any, table: string): any[] {
  const cols = schema?.schemaInfo?.[table]?.columns;
  return Array.isArray(cols) ? cols : [];
}

export function getRelationshipCount(schema: any): number {
  if (Array.isArray(schema?.relationships)) return schema.relationships.length;
  if (Array.isArray(schema?.schemaRelationships)) return schema.schemaRelationships.length;
  return 0;
}

export function getRelationshipSummary(schema: any): string {
  const links = Array.isArray(schema?.relationships)
    ? schema.relationships
    : Array.isArray(schema?.schemaRelationships)
      ? schema.schemaRelationships
      : [];
  return links
    .slice(0, 20)
    .map((rel: any) => {
      const left = String(rel?.leftTable || rel?.fromTable || rel?.sourceTable || rel?.source || "").trim();
      const leftCol = String(rel?.leftColumn || rel?.fromColumn || rel?.sourceColumn || "").trim();
      const right = String(rel?.rightTable || rel?.toTable || rel?.targetTable || rel?.target || "").trim();
      const rightCol = String(rel?.rightColumn || rel?.toColumn || rel?.targetColumn || "").trim();
      const joinType = String(rel?.type || rel?.relationshipType || "").trim();
      const lhs = [left, leftCol && `.${leftCol}`].filter(Boolean).join("");
      const rhs = [right, rightCol && `.${rightCol}`].filter(Boolean).join("");
      return [lhs, joinType && `(${joinType})`, rhs].filter(Boolean).join(" -> ");
    })
    .filter(Boolean)
    .join("\n");
}

export function createGroundedSchema(schema: any): GroundedSchema {
  const availableTables = getAvailableTables(schema);
  const projectedColumnsByTable: Record<string, string[]> = {};
  const candidateTables: string[] = [];
  let totalColumns = 0;
  let visibleColumns = 0;

  for (const table of availableTables) {
    const rawColumns = getSchemaColumns(schema, table);
    totalColumns += rawColumns.length;
    if (rawColumns.length === 0) continue;

    const visibleList = getVisibleColumnList(schema, table);
    const allNames = rawColumns.map((c) => getColumnName(c)).filter(Boolean);
    const nameMap = new Map(allNames.map((name) => [name.toLowerCase(), name]));

    let selectedNames: string[];
    if (visibleList && visibleList.length > 0) {
      selectedNames = visibleList
        .map((name) => nameMap.get(String(name).toLowerCase()))
        .filter((name): name is string => Boolean(name));
      visibleColumns += selectedNames.length;
    } else {
      selectedNames = allNames;
      visibleColumns += allNames.length;
    }

    if (selectedNames.length === 0) continue;
    projectedColumnsByTable[table] = selectedNames;
    candidateTables.push(table);
  }

  const schemaSummary = candidateTables
    .slice(0, 12)
    .map((table) => {
      const rawColumns = getSchemaColumns(schema, table);
      const selected = new Set((projectedColumnsByTable[table] || []).map((x) => x.toLowerCase()));
      const disabledSet = getDisabledFilterColumnSet(schema, table);
      const short = rawColumns
        .filter((c) => selected.has(getColumnName(c).toLowerCase()))
        .slice(0, 12)
        .map((c) => {
          const name = getColumnName(c);
          const type = getColumnType(c) || "?";
          // Mark columns the user explicitly disabled for filtering
          const noFilter = disabledSet !== null && disabledSet.has(name.toLowerCase());
          return noFilter ? `${name} (${type})[no-filter]` : `${name} (${type})`;
        })
        .join(", ");
      return `${table}: ${short}`;
    })
    .join("\n");

  return {
    availableTables,
    candidateTables,
    projectedColumnsByTable,
    schemaSummary,
    totalColumns,
    visibleColumns,
    hiddenColumns: Math.max(0, totalColumns - visibleColumns),
    relationships: getRelationshipCount(schema),
  };
}

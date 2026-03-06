/* eslint-disable @typescript-eslint/no-explicit-any */
import { isTemporalType } from "../data-type-utils";

function resolveSchemaInfoMap(schemaLike: any): Record<string, any> {
  if (schemaLike?.schemaInfo && typeof schemaLike.schemaInfo === "object") {
    return schemaLike.schemaInfo;
  }
  return (schemaLike && typeof schemaLike === "object") ? schemaLike : {};
}

export function buildStrictTableFallbackSql(schemaLike: any, connectorKind: "postgres" | "mssql", widgetId?: string) {
  const schemaInfo = resolveSchemaInfoMap(schemaLike);
  const entry = Object.entries(schemaInfo).find(([, info]) => (info as any)?.columns?.length);
  if (!entry) return "SELECT 1 AS value;";

  const [tableName, info] = entry as [string, any];
  const columns = Array.isArray(info?.columns) ? info.columns : [];
  const quoteIdent = (name: string) => {
    const raw = String(name || "").trim();
    if (connectorKind === "mssql") return `[${raw.replace(/]/g, "]]")}]`;
    return `"${raw.replace(/"/g, '""')}"`;
  };
  const getName = (col: any) => String(col?.name || col?.column_name || "");
  const selectedColumns = columns
    .map((c: any) => getName(c))
    .filter(Boolean)
    .slice(0, 8)
    .map((name: string) => quoteIdent(name))
    .join(", ");
  if (!selectedColumns) return "SELECT 1 AS value;";

  const primary = columns.find((c: any) => c?.isPrimary) || columns.find((c: any) => getName(c).toLowerCase() === "id");
  const temporal = columns.find((c: any) => isTemporalType(c?.data_type || c?.type || ""));
  const orderName = getName(primary) || getName(temporal) || getName(columns[0]);
  const orderBy = orderName ? quoteIdent(orderName) : "1";
  const tableRef = quoteIdent(tableName);
  const sizeToken = widgetId ? `{{size:${widgetId}}}` : "{{size}}";
  const offsetToken = widgetId ? `{{offset:${widgetId}}}` : "{{offset}}";

  if (connectorKind === "mssql") {
    return `SELECT COUNT(*) OVER() AS total_count, ${selectedColumns}
FROM ${tableRef}
ORDER BY ${orderBy} DESC
OFFSET ${offsetToken} ROWS FETCH NEXT ${sizeToken} ROWS ONLY;`;
  }

  return `SELECT COUNT(*) OVER() AS total_count, ${selectedColumns}
FROM ${tableRef}
ORDER BY ${orderBy} DESC
LIMIT ${sizeToken} OFFSET ${offsetToken};`;
}

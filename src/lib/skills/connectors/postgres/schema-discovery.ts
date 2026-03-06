import { connectToPostgres } from "@/app/actions/mcp";
import { dbGateway } from "@/lib/mcp/server";

import { registerSkill, type SkillDefinition } from "@/lib/skills/registry";
import type { ConnectorSchemaDiscoverInput, ConnectorSchemaDiscoverOutput } from "../contracts";

const quoteIdent = (name: string) => {
  const cleaned = String(name || "").trim().replace(/["`\[\]]/g, "");
  if (!cleaned) return '""';
  if (cleaned.includes(".")) {
    return cleaned
      .split(".")
      .filter(Boolean)
      .map((p) => `"${p.replace(/"/g, '""')}"`)
      .join(".");
  }
  return `"${cleaned.replace(/"/g, '""')}"`;
};

const normalizeTableIdentifier = (name: unknown) => {
  const cleaned = String(name || "")
    .trim()
    .replace(/["`\[\]]/g, "");
  if (!cleaned) return "";
  const parts = cleaned.split(".").filter(Boolean);
  return String(parts[parts.length - 1] || "").toLowerCase();
};

const skill: SkillDefinition<ConnectorSchemaDiscoverInput, ConnectorSchemaDiscoverOutput> = {
  id: "connector.postgres.schema-discovery",
  description: "Connector-specific schema discovery operations for PostgreSQL.",
  run: async (input) => {
    try {
      if (input.operation === "quoteIdent") {
        return { ok: true, data: quoteIdent(input.identifier) };
      }

      const connectionString = input.connectionString;
      if (input.operation === "connect") {
        const ok = await connectToPostgres(String(connectionString || ""));
        return { ok: Boolean(ok), data: Boolean(ok) };
      }

      if (input.operation === "listTables") {
        const tables = await dbGateway.listTables(connectionString);
        if (!Array.isArray(tables)) return { ok: false, error: "Failed to list tables" };
        const allowed = Array.isArray(input.allowedTables) && input.allowedTables.length > 0
          ? new Set(input.allowedTables.map((t) => normalizeTableIdentifier(t)).filter(Boolean))
          : null;
        const data = allowed
          ? tables.filter((t: unknown) => allowed.has(normalizeTableIdentifier(t)))
          : tables;
        return { ok: true, data };
      }

      if (input.operation === "getTableSchema") {
        const schema = await dbGateway.getTableSchema(input.tableName, connectionString);
        return { ok: true, data: schema };
      }

      if (input.operation === "getTablePreview") {
        const preview = await dbGateway.getTablePreview(input.tableName, connectionString);
        return { ok: true, data: Array.isArray(preview) ? preview : [] };
      }

      if (input.operation === "getRowCount") {
        const tableRef = quoteIdent(input.tableName);
        const result = await dbGateway.runQuery(`SELECT COUNT(*) as count FROM ${tableRef}`, connectionString);
        const first = Array.isArray(result) && result.length > 0 ? (result[0] as { count?: unknown }) : null;
        const value = first ? Number(first.count || 0) : 0;
        return { ok: true, data: value };
      }

      return { ok: false, error: "Unsupported operation" };
    } catch (error: unknown) {
      return { ok: false, error: String((error as Error)?.message || error || "Operation failed") };
    }
  },
};

let registered = false;
export function registerPostgresSchemaDiscoverySkill() {
  if (registered) return;
  registerSkill(skill);
  registered = true;
}

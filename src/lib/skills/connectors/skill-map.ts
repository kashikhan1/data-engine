import type { ConnectorKind, ConnectorSkillSet } from "./contracts";

const CONNECTOR_SKILL_MAP: Record<ConnectorKind, ConnectorSkillSet> = {
  postgres: {
    schemaDiscoverySkillId: "connector.postgres.schema-discovery",
    sqlValidatorSkillId: "connector.postgres.sql-validator",
  },
  mssql: {
    schemaDiscoverySkillId: "connector.mssql.schema-discovery",
    sqlValidatorSkillId: "connector.mssql.sql-validator",
  },
};

export function getConnectorSkillSet(kind: ConnectorKind): ConnectorSkillSet {
  return CONNECTOR_SKILL_MAP[kind];
}

export function isSupportedConnectorKind(value: string): value is ConnectorKind {
  return value === "postgres" || value === "mssql";
}

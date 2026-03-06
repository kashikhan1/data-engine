export type ConnectorKind = "postgres" | "mssql";

export type ConnectorSkillSelectionInput = {
  connectionString?: string;
  connectorType?: string;
  schemaHint?: string;
  projectContext?: string;
};

export type ConnectorRoutingContext = {
  requested: ConnectorKind;
  selected: ConnectorKind;
  source: "heuristic" | "llm_selected" | "validated_fallback";
  fallbackUsed: boolean;
  reason?: string;
};

export type ConnectorSkillSet = {
  schemaDiscoverySkillId: string;
  sqlValidatorSkillId: string;
};

export type ConnectorSchemaDiscoverInput =
  | { operation: "connect"; connectionString?: string }
  | { operation: "listTables"; connectionString?: string; allowedTables?: string[] }
  | { operation: "getTableSchema"; connectionString?: string; tableName: string }
  | { operation: "getTablePreview"; connectionString?: string; tableName: string }
  | { operation: "getRowCount"; connectionString?: string; tableName: string }
  | { operation: "quoteIdent"; identifier: string };

export type ConnectorSchemaDiscoverOutput = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type ConnectorSqlGenerateInput = {
  expertPrompt: string;
  widgetId: string;
  widgetType?: string;
  role: string;
  connectorInstructions?: string;
  focusedSchemaText: string;
  relationshipsText: string;
  widgetJson: string;
  filterSqlHints: string;
  widgetAgentHints: string;
  dateContextSummary: string;
};

export type ConnectorSqlGenerateOutput = {
  sql: string;
};

export type ConnectorSqlRepairInput = {
  compactSql: string;
  compactError: string;
  compactSchema: string;
  compactErrors: string;
  widgetGoal?: string;
  connectorInstructions?: string;
};

export type ConnectorSqlRepairOutput = {
  sql: string;
  explanation: string;
};

export type ConnectorValidationInput = {
  sql: string;
  connectionString?: string;
  connectorInstructions?: string;
  connectorType?: string;
  schemaForPrompt?: Record<string, unknown>;
  widget?: { id?: string; type?: string } | null;
};

export type ConnectorValidationOutput = {
  ok: boolean;
  error?: string;
};

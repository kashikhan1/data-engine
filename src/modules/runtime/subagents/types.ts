export interface SubagentInput {
  [key: string]: unknown;
}

export interface SubagentResult {
  [key: string]: unknown;
}

export interface SubagentContext {
  traceId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface SubagentConfig {
  maxRetries: number;
  timeoutMs: number;
  enableFallback: boolean;
}

export interface ReflectionConfig {
  enabled: boolean;
  maxIterations: number;
  acceptanceThreshold: number;
}

export interface Subagent<I extends SubagentInput = SubagentInput, O extends SubagentResult = SubagentResult> {
  id: string;
  run: (input: I, context?: SubagentContext) => Promise<O>;
}

export interface SubagentWithConfig<I extends SubagentInput = SubagentInput, O extends SubagentResult = SubagentResult> extends Subagent<I, O> {
  config?: SubagentConfig;
}

export interface SubagentWithReflection<I extends SubagentInput = SubagentInput, O extends SubagentResult = SubagentResult> extends Subagent<I, O> {
  config?: SubagentConfig;
  reflection?: ReflectionConfig;
}

export interface ParallelExecutionResult<T> {
  results: T[];
  successful: T[];
  failed: Array<{ index: number; error: string }>;
}

export interface ReflectionResult<T> {
  result: T;
  iterations: number;
  accepted: boolean;
  feedback: string[];
}

export interface SchemaInfo {
  columns: ColumnInfo[];
  foreignKeys?: ForeignKeyInfo[];
  primaryKeys?: string[];
}

export interface ColumnInfo {
  name: string;
  column_name?: string;
  type: string;
  data_type?: string;
  isPrimary?: boolean;
  isNullable?: boolean;
  isNumeric?: boolean;
  isTemporal?: boolean;
  isText?: boolean;
  category?: string;
}

export interface ForeignKeyInfo {
  column_name: string;
  foreign_table_name: string;
  foreign_column_name: string;
}

export interface TableInfo {
  columns: ColumnInfo[];
  foreignKeys?: ForeignKeyInfo[];
  primaryKeys?: string[];
}

export type SchemaContext = Record<string, TableInfo>;

export interface Widget {
  id?: string;
  type: WidgetType;
  title?: string;
  goal?: string;
  requiredTables?: string[];
  primaryTable?: string;
  uses?: string;
  notes?: string;
  confidence?: number;
  [key: string]: unknown;
}

export type WidgetType = "kpi" | "table" | "chart" | "line" | "bar" | "area" | "pie" | "scatter";

export interface DashboardPlan {
  title: string;
  actionable_plan?: string;
  widgets: Widget[];
}

export interface PlannerInput {
  query: string;
  schemaForPrompt: PlannerSchemaContext;
  allowedTypes: string[];
  projectContext?: string;
  [key: string]: unknown;
}

export interface PlannerSchemaContext {
  schemaInfo: SchemaContext;
  dataProfile?: Record<string, unknown>;
  /** Canonical key for relationships. Use this everywhere. */
  schemaRelationships?: Relationship[];
  /** Alias for schemaRelationships — normalized on read in all agents. */
  relationships?: Relationship[];
  tableCounts?: Record<string, number>;
  deepProfiledTables?: string[];
  filterCandidates?: FilterCandidates;
  domainSummary?: string;
  focusTable?: string;
  userSchemaNotes?: string;
  projectContext?: string;
  connectorInstructions?: string;
  userIntent?: string;
  sampleData?: Record<string, unknown>;
  filterSummary?: string;
  tableInsights?: Record<string, unknown>;
  schemaProperties?: {
    tableCount?: number;
    totalColumns?: number;
    visibleColumns?: number;
    hiddenColumns?: number;
    relationshipCount?: number;
    enabledWidgetTypes?: string[];
    disabledWidgetTypes?: string[];
  };
}

export interface Relationship {
  fromTable: string;
  toTable: string;
  via: string;
  type: string;
  targetColumn?: string;
}

export interface FilterCandidates {
  summary?: string;
  dateColumns?: Array<{ table: string; column: string }>;
  categoricalColumns?: Array<{ table: string; column: string }>;
}

export interface PlannerOutput {
  queryPlan: DashboardPlan;
  status: string;
  iterations?: number;
  improvements?: string[];
  [key: string]: unknown;
}

export interface QualityScore {
  score: number;
  issues: string[];
  accepted: boolean;
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  warnings: string[];
  score: number;
}

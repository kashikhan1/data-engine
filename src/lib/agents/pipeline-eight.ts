import { performance } from "perf_hooks";
import { ChatOpenAI } from "@langchain/openai";
import { ChatOllama } from "@langchain/ollama";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { dbGateway } from "@/lib/mcp/server";
import { connectToPostgres } from "@/app/actions/mcp";

type SchemaAgentOutput = {
  tables: Array<{
    name: string;
    rowCount?: number;
    columns: Array<{ name: string; type: string; role?: string; references?: string }>;
    samples: Record<string, any>[];
  }>;
  relationships: Array<{ from: string; to: string; type: string }>;
  dataQuality: string[];
  businessContext?: string;
};

type QueryEnhancerOutput = any;
type DashboardPlanOutput = any;

type SQLQuerySpec = {
  widgetId: number | string;
  title: string;
  sql: string;
  expectedColumns: string[];
  estimatedRows: number;
};

type SecurityValidation = {
  widgetId: number | string;
  title: string;
  approved: boolean;
  sanitizedSQL: string;
  checks: { name: string; passed: boolean }[];
  warnings: string[];
  appliedMasking: string[];
};

type ExecutionResult = {
  widgetId: number | string;
  title: string;
  status: "success" | "failed";
  executionTimeMs: number;
  rowsReturned: number;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
  data: Record<string, any>[];
  error: string | null;
  warnings: string[];
};

type AnalyticsVisualizationOutput = any;
type ExplanationOutput = any;

type PipelineResult = {
  schema?: SchemaAgentOutput;
  enhancedIntent?: QueryEnhancerOutput;
  dashboardPlan?: DashboardPlanOutput;
  queries?: SQLQuerySpec[];
  security?: SecurityValidation[];
  executions?: ExecutionResult[];
  analytics?: AnalyticsVisualizationOutput;
  explanation?: ExplanationOutput;
};

const filterSchemaForNonEmptyTables = (schema: SchemaAgentOutput): SchemaAgentOutput => {
  const nonEmptyTables = schema.tables.filter((table) => Number(table.rowCount || 0) > 0);
  const allowed = new Set(nonEmptyTables.map((table) => table.name));
  const relationships = schema.relationships.filter((rel) => {
    const fromTable = rel.from?.split(".")[0];
    const toTable = rel.to?.split(".")[0];
    return fromTable && toTable && allowed.has(fromTable) && allowed.has(toTable);
  });
  return {
    ...schema,
    tables: nonEmptyTables,
    relationships,
  };
};

// --- Model init (reuse env defaults) ---
const openAIApiKey = process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY;
const openAIModel = process.env.OPENAI_MODEL || process.env.NEXT_PUBLIC_OPENAI_MODEL || "gpt-4o-mini";
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || process.env.NEXT_PUBLIC_OLLAMA_BASE_URL;
const ollamaModel = process.env.OLLAMA_MODEL || process.env.NEXT_PUBLIC_OLLAMA_MODEL || "llama3.2";
const ollamaApiKey = process.env.OLLAMA_API_KEY || process.env.NEXT_PUBLIC_OLLAMA_API_KEY;

// Prefer Ollama if base URL is provided OR if no OpenAI key is present.
const useOllama = !!ollamaBaseUrl || !openAIApiKey;

const model = useOllama
  ? new ChatOllama({
      model: ollamaModel,
      baseUrl: ollamaBaseUrl || "http://localhost:11434",
      temperature: 0,
      numCtx: 32768,
      headers: ollamaApiKey ? { Authorization: `Bearer ${ollamaApiKey}` } : undefined,
    })
  : new ChatOpenAI({
      modelName: openAIModel,
      temperature: 0,
      openAIApiKey,
    });

const parseJSON = (text: string) => {
  try {
    const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
};

// --- Agent 1: Schema Discovery ---
export async function schemaAgent(userQuery: string, connectionString?: string): Promise<SchemaAgentOutput> {
  const connected = await connectToPostgres(connectionString || "");
  if (!connected) {
    throw new Error("Schema agent could not connect to database. Set POSTGRES_URL or pass a connection string.");
  }

  const tables = await dbGateway.listTables(connectionString);
  if (!Array.isArray(tables) || tables.length === 0) {
    return { tables: [], relationships: [], dataQuality: ["No tables discovered"], businessContext: "Unknown" };
  }

  const results: SchemaAgentOutput = { tables: [], relationships: [], dataQuality: [], businessContext: "Unknown" };

  for (const tableName of tables) {
    const schema = await dbGateway.getTableSchema(tableName, connectionString);
    const cols = (schema?.columns || []).map((c: any) => ({
      name: c.column_name || c.name,
      type: c.data_type || c.type,
      role: c.isPrimaryKey ? "primary_key" : c.isForeignKey ? "foreign_key" : undefined,
      references: (() => {
        const match = schema?.foreignKeys?.find((fk: any) => fk.column_name === c.column_name);
        if (!match) return undefined;
        return `${match.foreign_table_name}.${match.foreign_column_name}`;
      })(),
    }));

    const countResult = await dbGateway.runQuery(`SELECT COUNT(*) as count FROM "${tableName}"`, connectionString);
    const rowCount = Array.isArray(countResult) ? Number(countResult[0]?.count || 0) : undefined;
    const samples = await dbGateway.getTablePreview(tableName, connectionString);

    if (Array.isArray(schema?.foreignKeys)) {
      schema.foreignKeys.forEach((fk: any) => {
        results.relationships.push({
          from: `${tableName}.${fk.column_name}`,
          to: `${fk.foreign_table_name}.${fk.foreign_column_name}`,
          type: "many_to_one",
        });
      });
    }

    results.tables.push({
      name: tableName,
      rowCount,
      columns: cols,
      samples: Array.isArray(samples) ? samples : [],
    });
  }

  // Minimal data-quality heuristics
  if (results.tables.length > 0) {
    const note = `Profiled ${results.tables.length} tables; sample size 5 rows each where available.`;
    results.dataQuality.push(note);
  }

  return results;
}

// --- Agent 2: Query Enhancer ---
export async function queryEnhancerAgent(userQuery: string, schema: SchemaAgentOutput): Promise<QueryEnhancerOutput> {
  const system = `You are Query Enhancer Agent (Senior Analyst). Use schema and samples to output the enhanced intent JSON exactly as in docs/agent-system-prompts.md (Agent 2).`;
  const human = `User Query: ${userQuery}\nSchema (truncated): ${JSON.stringify(schema).slice(0, 8000)}`;

  const response = await model.invoke([new SystemMessage(system), new HumanMessage(human)]);
  const parsed = parseJSON(String(response.content));
  if (!parsed) throw new Error("Query Enhancer failed to return valid JSON.");
  return parsed;
}

// --- Agent 3: Dashboard Planner ---
export async function dashboardPlannerAgent(enhancedIntent: QueryEnhancerOutput, schema: SchemaAgentOutput): Promise<DashboardPlanOutput> {
  const filteredSchema = filterSchemaForNonEmptyTables(schema);
  const system = `You are Dashboard Planner Agent (Senior Software Architect & KPI Strategist). Return ONLY the JSON array of widgets as defined in docs/agent-system-prompts.md (Agent 3).`;
  const human = `Enhanced Intent: ${JSON.stringify(enhancedIntent)}\nSchema (truncated): ${JSON.stringify(filteredSchema).slice(0, 6000)}`;

  const response = await model.invoke([new SystemMessage(system), new HumanMessage(human)]);
  const parsed = parseJSON(String(response.content));
  if (!parsed || !Array.isArray(parsed)) throw new Error("Dashboard Planner did not return a JSON array.");
  return parsed;
}

// --- Agent 4: SQL Generator ---
function normalizeIntervalLiterals(sql: string): string {
  // Replace INTERVAL 'YYYY-MM-DD' with DATE 'YYYY-MM-DD' (Postgres treats the former as invalid)
  return sql.replace(/INTERVAL\s+'(\d{4}-\d{2}-\d{2})'/gi, (_m, dateLiteral) => `DATE '${dateLiteral}'`);
}

function sanitizeSqlText(sql: string): string {
  let cleaned = sql || "";
  cleaned = cleaned.replace(/```sql/gi, "").replace(/```/g, "");
  cleaned = cleaned.trim();
  return cleaned;
}

export async function sqlGeneratorAgent(widgets: DashboardPlanOutput, enhancedIntent: QueryEnhancerOutput, schema: SchemaAgentOutput): Promise<SQLQuerySpec[]> {
  const filteredSchema = filterSchemaForNonEmptyTables(schema);
  const system = `You are SQL Generator Agent (Senior SQL Engineer). Output ONLY a JSON array of query specs per docs/agent-system-prompts.md (Agent 4).
Best practices: keep queries simple and professional; avoid filtering on settings/config/JSON/blob-like columns unless explicitly required; avoid verbose IN lists; focus WHERE on date + 1–2 business dimensions.`;
  const human = `Widgets: ${JSON.stringify(widgets)}\nEnhanced Intent: ${JSON.stringify(enhancedIntent)}\nSchema (truncated): ${JSON.stringify(filteredSchema).slice(0, 6000)}`;

  const response = await model.invoke([new SystemMessage(system), new HumanMessage(human)]);
  const parsed = parseJSON(String(response.content));
  if (!parsed || !Array.isArray(parsed)) throw new Error("SQL Generator did not return a JSON array.");
  const allowedIds = new Set((widgets as any[]).map((w) => w.id));
  return (parsed as SQLQuerySpec[])
    .filter((q) => allowedIds.has(q.widgetId))
    .map((q) => ({
      ...q,
      sql: normalizeIntervalLiterals(sanitizeSqlText(q.sql || "")),
    }));
}

// --- Agent 5: Security Validator ---
function isDateShapedInterval(sql: string): boolean {
  // Detect misuse like INTERVAL '2025-07-17'
  return /INTERVAL\s+'(\d{4}-\d{2}-\d{2})'/i.test(sql);
}

export function securityValidatorAgent(queries: SQLQuerySpec[], allowedTables?: string[]): SecurityValidation[] {
  const forbidden = /\b(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|EXEC|GRANT|REVOKE)\b/i;
  const unionSelect = /\bUNION\b\s+SELECT/i;
  const commentAttack = /(\/\*.*\*\/)|(--[^\n]*)/;
  const stacked = /;\s*SELECT/i;

  return queries.map((q) => {
    const checks: SecurityValidation["checks"] = [];
    const warnings: string[] = [];
    let approved = true;
    const sql = q.sql || "";
    const upper = sql.toUpperCase();

    const addCheck = (name: string, passed: boolean) => {
      checks.push({ name, passed });
      if (!passed) approved = false;
    };

    addCheck("read_only", upper.trim().startsWith("SELECT") || upper.trim().startsWith("WITH"));
    addCheck("forbidden_keywords", !forbidden.test(sql));
    addCheck("union_injection", !unionSelect.test(sql));
    addCheck("comment_injection", !commentAttack.test(sql));
    addCheck("stacked_queries", !stacked.test(sql));
    addCheck("interval_literal_is_date", !isDateShapedInterval(sql));

    if (allowedTables && allowedTables.length > 0) {
      const tablesUsed = allowedTables.filter((t) => new RegExp(`\\b${t}\\b`, "i").test(sql));
      addCheck("table_access", tablesUsed.length > 0);
      if (tablesUsed.length === 0) warnings.push("No allowed tables detected in SQL.");
    }

    if (isDateShapedInterval(sql)) {
      warnings.push("Interval literal looks like an absolute date; replace with DATE 'YYYY-MM-DD' or use CURRENT_DATE - INTERVAL 'N days'.");
    }

    return {
      widgetId: q.widgetId,
      title: q.title,
      approved,
      sanitizedSQL: q.sql,
      checks,
      warnings,
      appliedMasking: [],
    };
  });
}

// --- Agent 6: Query Executor ---
export async function queryExecutorAgent(validations: SecurityValidation[]): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];

  for (const v of validations) {
    const start = performance.now();
    if (!v.approved) {
      results.push({
        widgetId: v.widgetId,
        title: v.title,
        status: "failed",
        executionTimeMs: 0,
        rowsReturned: 0,
        columns: [],
        data: [],
        error: "Query not approved by security validator.",
        warnings: v.warnings,
      });
      continue;
    }

    const data = await dbGateway.runQuery(v.sanitizedSQL);
    const duration = Math.round(performance.now() - start);

    if ((data as any)?.error) {
      results.push({
        widgetId: v.widgetId,
        title: v.title,
        status: "failed",
        executionTimeMs: duration,
        rowsReturned: 0,
        columns: [],
        data: [],
        error: (data as any).error,
        warnings: v.warnings,
      });
      continue;
    }

    const rows = Array.isArray(data) ? data : [];
    const first = rows[0] || {};
    const columns = Object.keys(first).filter((k) => k !== "__rowKey").map((name) => ({
      name,
      type: typeof first[name],
      nullable: first[name] === null || first[name] === undefined,
    }));

    results.push({
      widgetId: v.widgetId,
      title: v.title,
      status: "success",
      executionTimeMs: duration,
      rowsReturned: rows.length,
      columns,
      data: rows,
      error: null,
      warnings: v.warnings,
    });
  }

  return results;
}

// --- Agent 7: Analytics & Visualization ---
export async function analyticsVisualizationAgent(executions: ExecutionResult[], enhancedIntent: QueryEnhancerOutput): Promise<AnalyticsVisualizationOutput> {
  const system = `You are Analytics & Visualization Agent (Senior Data Scientist). Return ONLY JSON as specified in docs/agent-system-prompts.md (Agent 7).`;
  const human = `Query Results: ${JSON.stringify(executions).slice(0, 12000)}\nEnhanced Intent: ${JSON.stringify(enhancedIntent).slice(0, 4000)}`;

  const response = await model.invoke([new SystemMessage(system), new HumanMessage(human)]);
  const parsed = parseJSON(String(response.content));
  if (!parsed) throw new Error("Analytics & Visualization agent did not return valid JSON.");
  return parsed;
}

// --- Agent 8: Explanation ---
export async function explanationAgent(analytics: AnalyticsVisualizationOutput, userQuery: string): Promise<ExplanationOutput> {
  const system = `You are Explanation Agent (Senior Executive Analyst). Return ONLY the JSON object per docs/agent-system-prompts.md (Agent 8).`;
  const human = `User Query: ${userQuery}\nAnalytics & Visualizations: ${JSON.stringify(analytics).slice(0, 8000)}`;

  const response = await model.invoke([new SystemMessage(system), new HumanMessage(human)]);
  const parsed = parseJSON(String(response.content));
  if (!parsed) throw new Error("Explanation agent did not return valid JSON.");
  return parsed;
}

// --- Orchestrator ---
export async function runEightAgentPipeline(userQuery: string, connectionString?: string): Promise<PipelineResult> {
  const result: PipelineResult = {};

  result.schema = await schemaAgent(userQuery, connectionString);
  result.enhancedIntent = await queryEnhancerAgent(userQuery, result.schema);
  result.dashboardPlan = await dashboardPlannerAgent(result.enhancedIntent, result.schema);
  result.queries = await sqlGeneratorAgent(result.dashboardPlan, result.enhancedIntent, result.schema);
  result.security = securityValidatorAgent(result.queries || []);
  result.executions = await queryExecutorAgent(result.security);
  result.analytics = await analyticsVisualizationAgent(result.executions, result.enhancedIntent);
  result.explanation = await explanationAgent(result.analytics, userQuery);

  return result;
}

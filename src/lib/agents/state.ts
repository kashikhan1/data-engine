import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import {
    QueryPlanSchema,
    DashboardLayoutSchema,
    IntentSchema,
    ExecutionPlanSchema,
    QualityReportSchema,
    ErrorRecoverySchema,
} from "../schemas";
import { z } from "zod";

type JsonRow = Record<string, unknown>;
type SchemaInfo = Record<string, { columns?: JsonRow[];[key: string]: unknown }>;
type SampleData = Record<string, JsonRow[]>;
type QueryValidationMap = Record<string, string>;
type Relationship = {
    fromTable?: string;
    toTable?: string;
    via?: string;
    type?: string;
    targetColumn?: string;
    [key: string]: unknown;
};
type RuntimeContext = {
    connectionString?: string;
    dbUrl?: string;
    postgresUrl?: string;
    mssqlUrl?: string;
    focusTable?: string;
    projectContext?: string;
    projectAbout?: string;
    schemaOptions?: Record<string, unknown>;
    schemaSnapshot?: Record<string, unknown>;
    manualSchema?: Record<string, unknown>;
    disabledWidgetTypes?: string[];
    connectorInstructions?: string;
    connectorType?: string;
    runtimeParams?: Record<string, unknown>;
    [key: string]: unknown;
};
type SecurityClearance = { approved?: boolean;[key: string]: unknown };
type QueryExecutionResult = {
    widgetId: string | number;
    widgetTitle: string;
    type: string;
    data: JsonRow[];
    columns: string[];
    error?: string | null;
    sql?: string;
    goal?: string;
    vegaSpec?: Record<string, unknown>;
    plan_metric?: string;
    plan_dim?: string;
    [key: string]: unknown;
};

export const AgentState = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (x, y) => x.concat(y),
    }),
    intent: Annotation<z.infer<typeof IntentSchema> | null>({
        reducer: (x, y) => y ?? x,
    }),
    executionPlan: Annotation<z.infer<typeof ExecutionPlanSchema> | null>({
        reducer: (x, y) => y ?? x,
    }),
    queryPlan: Annotation<z.infer<typeof QueryPlanSchema> | null>({
        reducer: (x, y) => y ?? x,
    }),
    schemaInfo: Annotation<SchemaInfo | null>({
        reducer: (x, y) => y ?? x,
    }),
    sampleData: Annotation<SampleData | null>({
        reducer: (x, y) => y ?? x,
    }),
    securityClearance: Annotation<SecurityClearance | null>({
        reducer: (x, y) => y ?? x,
    }),
    sqlQueries: Annotation<string[]>({
        reducer: (x, y) => y,
    }),
    results: Annotation<QueryExecutionResult[]>({
        reducer: (x, y) => y,
    }),
    qualityReport: Annotation<z.infer<typeof QualityReportSchema> | null>({
        reducer: (x, y) => y ?? x,
    }),
    transformedData: Annotation<Record<string, unknown> | null>({
        reducer: (x, y) => y ?? x,
    }),
    dashboard: Annotation<z.infer<typeof DashboardLayoutSchema> | null>({
        reducer: (x, y) => y ?? x,
    }),
    insights: Annotation<string[]>({
        reducer: (x, y) => x.concat(y),
    }),
    errors: Annotation<string[]>({
        reducer: (x, y) => y,
    }),
    status: Annotation<string>({
        reducer: (x, y) => y,
    }),
    context: Annotation<RuntimeContext | null>({
        reducer: (x, y) => y ?? x,
    }),
    runId: Annotation<string | null>({
        reducer: (x, y) => y ?? x,
    }),
    retryCount: Annotation<number>({
        reducer: (x, y) => y,
    }),
    queryValidation: Annotation<QueryValidationMap>({
        reducer: (x, y) => y ?? x,
    }),
    errorRecovery: Annotation<z.infer<typeof ErrorRecoverySchema> | null>({
        reducer: (x, y) => y ?? x,
    }),
    schemaRelationships: Annotation<Relationship[]>({
        reducer: (x, y) => y,
    }),
    dataProfile: Annotation<Record<string, unknown> | null>({
        reducer: (x, y) => y ?? x,
    }),
    querySpecification: Annotation<Record<string, unknown> | null>({
        reducer: (x, y) => y ?? x,
    }),
    businessGlossary: Annotation<Record<string, string>>({
        reducer: (x, y) => ({ ...x, ...y }),
    }),
    analytics: Annotation<Record<string, unknown> | null>({
        reducer: (x, y) => y ?? x,
    }),
    manualSchema: Annotation<Record<string, unknown> | null>({
        reducer: (x, y) => y ?? x,
    }),
    repairedSQL: Annotation<QueryValidationMap>({
        reducer: (x, y) => y ?? x,
    }),
    retryWidgets: Annotation<string[]>({
        reducer: (x, y) => y,
    }),
    emptyWidgets: Annotation<QueryExecutionResult[]>({
        reducer: (x, y) => y,
    }),
    shouldRepair: Annotation<boolean>({
        reducer: (x, y) => y ?? x,
    }),
    shouldContinue: Annotation<boolean>({
        reducer: (x, y) => y ?? x,
    }),
    schema: Annotation<RuntimeContext | null>({
        reducer: (x, y) => y ?? x,
    }),
});

// Configuration constants
export const MAX_RETRIES = 3;
export const MAX_QUALITY_RETRIES = 2;

import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { QueryPlanSchema, DashboardLayoutSchema } from "../schemas";
import { z } from "zod";

export const AgentState = Annotation.Root({
    messages: Annotation<BaseMessage[]>({
        reducer: (x, y) => x.concat(y),
    }),
    intent: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    executionPlan: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    queryPlan: Annotation<z.infer<typeof QueryPlanSchema> | null>({
        reducer: (x, y) => y ?? x,
    }),
    schemaInfo: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    sampleData: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    securityClearance: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    sqlQueries: Annotation<string[]>({
        reducer: (x, y) => y,
    }),
    results: Annotation<any[]>({
        reducer: (x, y) => y,
    }),
    qualityReport: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    transformedData: Annotation<any | null>({
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
    context: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    runId: Annotation<string | null>({
        reducer: (x, y) => y ?? x,
    }),
    retryCount: Annotation<number>({
        reducer: (x, y) => y,
    }),
    queryValidation: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    errorRecovery: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    templates: Annotation<any[]>({
        reducer: (x, y) => y,
    }),
    metadata: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    schemaRelationships: Annotation<any[]>({
        reducer: (x, y) => y,
    }),
    dataProfile: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    querySpecification: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    businessGlossary: Annotation<Record<string, string>>({
        reducer: (x, y) => ({ ...x, ...y }),
    }),
    analytics: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    manualSchema: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    repairedSQL: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
    retryWidgets: Annotation<any[]>({
        reducer: (x, y) => y,
    }),
    emptyWidgets: Annotation<any[]>({
        reducer: (x, y) => y,
    }),
    shouldRepair: Annotation<boolean>({
        reducer: (x, y) => y ?? x,
    }),
    shouldContinue: Annotation<boolean>({
        reducer: (x, y) => y ?? x,
    }),
    schema: Annotation<any | null>({
        reducer: (x, y) => y ?? x,
    }),
});

// Configuration constants
export const MAX_RETRIES = 3;
export const MAX_QUALITY_RETRIES = 2;

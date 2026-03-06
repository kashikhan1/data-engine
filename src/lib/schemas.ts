import { z } from "zod";
import { WidgetTypeSchema } from "@/types/dashboard";

export const MetricSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    sql: z.string(),
    type: z.enum(["count", "sum", "avg", "min", "max", "number"]),
});

export const DimensionSchema = z.object({
    id: z.string(),
    name: z.string(),
    type: z.enum(["string", "number", "boolean", "time", "date"]),
});

export { WidgetTypeSchema };

export const WidgetSpecSchema = z.object({
    id: z.string(),
    title: z.string(),
    type: WidgetTypeSchema,
    metrics: z.array(z.string()),
    dimensions: z.array(z.string()),
    vegaSpec: z.any().optional(), // Vega-Lite specification
    sql: z.string().optional(),
    insights: z.string().optional(),
});

export const DashboardLayoutSchema = z.object({
    id: z.string(),
    name: z.string(),
    widgets: z.array(WidgetSpecSchema),
    filters: z.array(z.object({
        id: z.string(),
        type: z.string(),
        label: z.string(),
    })),
});

export const QueryPlanSchema = z.object({
    title: z.string().optional(),
    actionable_plan: z.string().optional(),
    rawPlan: z.string().optional(),
    intent: z.string().optional(),
    entities: z.array(z.string()).optional(),
    timeRange: z.object({
        start: z.string().optional(),
        end: z.string().optional(),
        grain: z.enum(["hour", "day", "week", "month"]).optional(),
    }).optional(),
    widgets: z.array(z.object({
        id: z.string(),
        title: z.string(),
        type: WidgetTypeSchema,
        goal: z.string().optional(),
        metric: z.string().optional(),
        dim: z.string().optional(),
        metrics: z.array(z.string()).optional(),
        dimensions: z.array(z.string()).optional(),
    })),
    filters: z.array(z.object({
        id: z.string().optional(),
        dimension: z.string(),
        label: z.string().optional(),
        type: z.string().optional(),
        value: z.any().optional(),
    })).optional(),
});

export const IntentSchema = z.object({
    intent: z.string(),
    entities: z.array(z.string()).default([]),
    metrics: z.array(z.string()).default([]),
    dimensions: z.array(z.string()).default([]),
    filters: z.array(z.string()).default([]),
    timeRange: z.object({
        start: z.string().optional(),
        end: z.string().optional(),
        grain: z.enum(["hour", "day", "week", "month"]).optional(),
    }).optional(),
    visualizationPreference: z.string().optional(),
});

export const ExecutionTaskSchema = z.object({
    id: z.string(),
    task: z.string(),
    dependencies: z.array(z.string()),
    status: z.enum(["pending", "completed", "failed"]),
});

export const ExecutionPlanSchema = z.object({
    tasks: z.array(ExecutionTaskSchema),
    strategy: z.string(),
});

export const QueryValidationSchema = z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
    suggestions: z.array(z.string()),
    costEstimate: z.string().optional(),
});

export const QualityReportSchema = z.object({
    score: z.number().min(0).max(100),
    issues: z.array(z.string()),
    completeness: z.number(),
    consistency: z.number(),
});

export const ReportRecipeSchema = z.object({
    id: z.string(),
    name: z.string(),
    queryPlan: QueryPlanSchema,
    parameters: z.record(z.string(), z.any()),
});

// Error Recovery Schema
export const ErrorRecoverySchema = z.object({
    errorType: z.enum(["connection", "syntax", "validation", "execution", "timeout", "other"]).default("other"),
    originalError: z.string().optional(),
    recoveryAction: z.string().default("Consult documentation or try a different request."),
    retryable: z.boolean().default(false),
    suggestion: z.string().optional(),
});

// Template Library Schema
export const TemplateSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    category: z.enum(["executive", "operational", "analytical", "custom"]),
    requiredTables: z.array(z.string()),
    requiredColumns: z.record(z.string(), z.array(z.string())),
    parameters: z.array(z.object({
        name: z.string(),
        type: z.string(),
        required: z.boolean(),
        defaultValue: z.any().optional(),
    })),
    widgets: z.array(WidgetSpecSchema),
});

// Metadata Management Schema
export const MetadataSchema = z.object({
    glossary: z.record(z.string(), z.object({
        businessName: z.string(),
        technicalName: z.string(),
        description: z.string(),
        type: z.string(),
    })),
    dataLineage: z.array(z.object({
        source: z.string(),
        transformations: z.array(z.string()),
        destination: z.string(),
    })),
});

// Schema Relationship Schema
export const SchemaRelationshipSchema = z.object({
    table: z.string(),
    columns: z.array(z.object({
        name: z.string(),
        type: z.string(),
        isPrimaryKey: z.boolean().optional(),
        isForeignKey: z.boolean().optional(),
        nullable: z.boolean().optional(),
    })),
    relationships: z.array(z.object({
        foreignTable: z.string(),
        via: z.string(),
        type: z.enum(["1-to-1", "1-to-many", "many-to-many"]),
    })),
    sampleData: z.array(z.any()).optional(),
});

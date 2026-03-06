/* eslint-disable @typescript-eslint/no-explicit-any */
// nodes.ts — compatibility shim.
// Runtime logic has moved to focused modules:
// - planner-runtime.ts
// - sql-runtime.ts
// - query-runtime.ts
'use server';

import {
    runQueryExecutor as runQueryExecutorImpl,
    repairFailedQuery as repairFailedQueryImpl,
    assembleFinalDashboard as assembleFinalDashboardImpl,
    runNarrativeGenerator as runNarrativeGeneratorImpl,
} from "./query-runtime";
import {
    runSchemaDiscovery as runSchemaDiscoveryImpl,
    type SchemaDiscoveryOptions,
    type RunSchemaDiscoveryInput,
} from "./schema-discovery";

export type { SchemaDiscoveryOptions } from "./schema-discovery";

export async function runSchemaDiscovery(
    inputOrConnection?: string | RunSchemaDiscoveryInput,
    options: SchemaDiscoveryOptions = {},
    allowedTables?: string[]
) {
    return runSchemaDiscoveryImpl(inputOrConnection as any, options, allowedTables);
}

export async function runQueryExecutor(
    queries: Record<string, string>,
    connectionString?: string,
    options?: {
        connectorInstructions?: string;
        connectorType?: string;
        /** Map of widgetId -> widgetType. Used to skip count queries for non-table widgets. */
        widgetTypes?: Record<string, string>;
        tablePagination?: Record<string, { page: number; pageSize: number; offset?: number; includeTotal?: boolean }>;
        runtimeParams?: Record<string, any>;
    }
) {
    return runQueryExecutorImpl(queries, connectionString, options);
}

export async function repairFailedQuery(context: {
    widgetId: string;
    widgetTitle: string;
    widgetType: string;
    widgetGoal?: string;
    widgetUses?: string;
    widgetNotes?: string;
    primaryTable?: string;
    filterableColumns?: Record<string, string[]>;
    originalSql: string;
    errorMessage: string;
    schema: any;
    errorLog?: Array<{ id: string; title?: string; sql?: string; error: string; timestamp?: string }>;
    connectionString?: string;
}): Promise<{ sql: string; explanation: string }> {
    return repairFailedQueryImpl(context);
}

export async function assembleFinalDashboard(
    plan: any,
    queries: any[],
    results: any[],
    insights: string[] = [],
    filterCandidates?: any,
    schemaContext?: {
        visibleColumns?: Record<string, string[]>;
        filterableColumns?: Record<string, string[]>;
    }
) {
    return assembleFinalDashboardImpl(plan, queries, results, insights, filterCandidates, schemaContext);
}

export async function runNarrativeGenerator(resultsList: any[]) {
    return runNarrativeGeneratorImpl(resultsList);
}

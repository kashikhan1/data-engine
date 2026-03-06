/* eslint-disable @typescript-eslint/no-explicit-any */
import {
    runDashboardPlannerStream,
} from "./planner-core";
import { runDashboardPlanner } from "./planner-runtime";
import { AIMessage } from "@langchain/core/messages";
import { AgentState } from "./state";

export async function dashboardPlannerAgent(state: typeof AgentState.State) {
    const intent = state.intent;
    const intentText = String(intent?.intent || "Dashboard Overview");
    const schemaSnapshot = (state.context?.schemaSnapshot || {}) as Record<string, any>;
    const schema = {
        schemaInfo: state.schemaInfo || {},
        tableInsights: state.dataProfile || null,
        relationships: state.schemaRelationships || [],
        tableCounts: state.tableCounts || {},
        sampleData: state.sampleData || {},
        deepProfiledTables: state.deepProfiledTables || [],
        projectContext: state.context?.projectContext || state.context?.projectAbout || "",
        domainSummary: (state as any)?.domainSummary || "",
        filterCandidates: (state as any).filterCandidates || null,
        focusTable: state.context?.focusTable,
        userSchemaNotes: state.context?.userSchemaNotes || "",
        disabledWidgetTypes: state.context?.disabledWidgetTypes || [],
        // Connection info — required for MCP evidence enrichment
        connectionString:
            state.context?.connectionString ||
            state.context?.connector?.connectionString ||
            state.context?.dbUrl ||
            state.context?.mssqlUrl ||
            state.context?.postgresUrl ||
            schemaSnapshot?.connectionString ||
            "",
        connectorType: state.context?.connectorType || state.context?.connector?.kind || "",
        connectorInstructions: state.context?.connectorInstructions || state.context?.connector?.instructions || "",
        // Filter/visibility policy — required for filter enforcement
        filterableColumns:
            (state.context as any)?.filterableColumns ||
            schemaSnapshot?.filterableColumns ||
            {},
        visibleColumns:
            (state.context as any)?.visibleColumns ||
            schemaSnapshot?.visibleColumns ||
            {},
    } as any;

    const result = await runDashboardPlanner(intentText, schema, (state.context as any)?.planningObjective);
    if (!result?.queryPlan?.widgets || result.queryPlan.widgets.length === 0) {
        return {
            queryPlan: { ...(result?.queryPlan || { title: "AI Analytics Dashboard", widgets: [] }), widgets: [] },
            errors: ["The planner failed to generate a valid dashboard plan."],
            status: result?.status || "Planning failed.",
            messages: [new AIMessage("[PLANNER] Failed to architect a plan.")],
        };
    }
    return {
        queryPlan: result.queryPlan,
        status: result.status,
        messages: [new AIMessage(`[PLANNER] ${result.status}`)]
    };
}

export {
    runDashboardPlannerStream,
};

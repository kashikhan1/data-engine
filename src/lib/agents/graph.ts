import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState, MAX_RETRIES, MAX_QUALITY_RETRIES } from "./state";
import {
    intentAgent,
    schemaAgent,
    queryEnhancerAgent,
    dashboardPlannerAgent,
    multiQueryOrchestratorAgent,
    securityCheckAgent,
    mcpCallingAgent,
    analyticsAgent,
    chartDesignAgent,
    smartLayoutBuilderAgent,
    widgetRendererAgent,
    insightGenerationAgent,
    qualityCheckAgent,
    sqlRepairAgent
} from "./nodes";
// No extended-nodes imports needed for now as we are strictly following the 8-agent sequential pipeline.
// import { errorRecoveryAgent } from "./extended-nodes";

const workflow = new StateGraph(AgentState)
    .addNode("intent_understanding", intentAgent)
    .addNode("schema_agent", schemaAgent)
    .addNode("query_enhancer", queryEnhancerAgent)
    .addNode("dashboard_planner", dashboardPlannerAgent)
    .addNode("multi_query_orchestrator", multiQueryOrchestratorAgent)
    .addNode("security_check", securityCheckAgent)
    .addNode("query_execution", mcpCallingAgent)
    .addNode("quality_check", qualityCheckAgent)
    .addNode("sql_repair", sqlRepairAgent)
    .addNode("analytics_agent", analyticsAgent)
    .addNode("visualization_agent", chartDesignAgent)
    .addNode("smart_layout_builder", smartLayoutBuilderAgent)
    .addNode("widget_renderer", widgetRendererAgent)
    .addNode("explanation_agent", insightGenerationAgent);

workflow.addEdge(START, "intent_understanding");
workflow.addEdge("intent_understanding", "schema_agent");
workflow.addEdge("schema_agent", "query_enhancer");
workflow.addEdge("query_enhancer", "dashboard_planner");
workflow.addEdge("dashboard_planner", "multi_query_orchestrator");
workflow.addEdge("multi_query_orchestrator", "security_check");
workflow.addEdge("security_check", "query_execution");
workflow.addEdge("query_execution", "quality_check");

// Conditional edge for quality check - retry if needed, otherwise continue
workflow.addConditionalEdges("quality_check", (state) => {
    if (state.shouldRepair && state.retryCount < MAX_QUALITY_RETRIES) {
        return "sql_repair";
    }
    return "analytics_agent";
});

// SQL repair goes back to orchestrator for retry execution
workflow.addEdge("sql_repair", "multi_query_orchestrator");

// Normal flow continues to analytics
workflow.addEdge("analytics_agent", "visualization_agent");
workflow.addEdge("visualization_agent", "smart_layout_builder");
workflow.addEdge("smart_layout_builder", "widget_renderer");
workflow.addEdge("widget_renderer", "explanation_agent");
workflow.addEdge("explanation_agent", END);

export const graph = workflow.compile();

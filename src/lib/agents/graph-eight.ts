import { START, END, StateGraph } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import {
  schemaAgent,
  queryEnhancerAgent,
  dashboardPlannerAgent,
  sqlGeneratorAgent,
  securityValidatorAgent,
  queryExecutorAgent,
  analyticsVisualizationAgent,
  explanationAgent,
} from "./pipeline-eight";

type EightAgentContext = {
  userQuery: string;
  connectionString?: string;
};

export const EightAgentState = Annotation.Root({
  userQuery: Annotation<string>({ reducer: (_x, y) => y }),
  connectionString: Annotation<string | undefined>({ reducer: (_x, y) => y }),
  schema: Annotation<any | null>({ reducer: (_x, y) => y }),
  enhancedIntent: Annotation<any | null>({ reducer: (_x, y) => y }),
  dashboardPlan: Annotation<any | null>({ reducer: (_x, y) => y }),
  queries: Annotation<any[] | null>({ reducer: (_x, y) => y }),
  security: Annotation<any[] | null>({ reducer: (_x, y) => y }),
  executions: Annotation<any[] | null>({ reducer: (_x, y) => y }),
  analytics: Annotation<any | null>({ reducer: (_x, y) => y }),
  explanation: Annotation<any | null>({ reducer: (_x, y) => y }),
});

// Nodes call the individual agents in order.
const schemaNode = async (state: typeof EightAgentState.State) => {
  const schema = await schemaAgent(state.userQuery, state.connectionString);
  return { schema };
};

const enhancerNode = async (state: typeof EightAgentState.State) => {
  if (!state.schema) throw new Error("Schema missing for Query Enhancer.");
  const enhancedIntent = await queryEnhancerAgent(state.userQuery, state.schema);
  return { enhancedIntent };
};

const plannerNode = async (state: typeof EightAgentState.State) => {
  if (!state.enhancedIntent || !state.schema) {
    throw new Error("Planner missing enhanced intent or schema.");
  }
  const dashboardPlan = await dashboardPlannerAgent(state.enhancedIntent, state.schema);
  return { dashboardPlan };
};

const sqlNode = async (state: typeof EightAgentState.State) => {
  if (!state.dashboardPlan || !state.enhancedIntent || !state.schema) {
    throw new Error("SQL Generator missing prerequisites.");
  }
  const queries = await sqlGeneratorAgent(state.dashboardPlan, state.enhancedIntent, state.schema);
  return { queries };
};

const securityNode = async (state: typeof EightAgentState.State) => {
  if (!state.queries) throw new Error("No queries to validate.");
  const security = securityValidatorAgent(state.queries);
  return { security };
};

const executorNode = async (state: typeof EightAgentState.State) => {
  if (!state.security) throw new Error("No security validation results.");
  const executions = await queryExecutorAgent(state.security);
  return { executions };
};

const analyticsNode = async (state: typeof EightAgentState.State) => {
  if (!state.executions || !state.enhancedIntent) {
    throw new Error("Analytics missing executions or enhanced intent.");
  }
  const analytics = await analyticsVisualizationAgent(state.executions, state.enhancedIntent);
  return { analytics };
};

const explanationNode = async (state: typeof EightAgentState.State) => {
  if (!state.analytics) throw new Error("Explanation missing analytics.");
  const explanation = await explanationAgent(state.analytics, state.userQuery);
  return { explanation };
};

const graph = new StateGraph(EightAgentState)
  .addNode("schema_agent", schemaNode)
  .addNode("query_enhancer", enhancerNode)
  .addNode("dashboard_planner", plannerNode)
  .addNode("sql_generator", sqlNode)
  .addNode("security_validator", securityNode)
  .addNode("query_executor", executorNode)
  .addNode("analytics_visualization", analyticsNode)
  .addNode("explanation_agent", explanationNode);

graph.addEdge(START, "schema_agent");
graph.addEdge("schema_agent", "query_enhancer");
graph.addEdge("query_enhancer", "dashboard_planner");
graph.addEdge("dashboard_planner", "sql_generator");
graph.addEdge("sql_generator", "security_validator");
graph.addEdge("security_validator", "query_executor");
graph.addEdge("query_executor", "analytics_visualization");
graph.addEdge("analytics_visualization", "explanation_agent");
graph.addEdge("explanation_agent", END);

export const eightAgentWorkflow = graph.compile();

export async function runEightAgentGraph(ctx: EightAgentContext) {
  return eightAgentWorkflow.invoke({
    userQuery: ctx.userQuery,
    connectionString: ctx.connectionString,
  });
}

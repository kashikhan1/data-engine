'use server';

import { runEightAgentGraph } from "@/lib/agents/graph-eight";

export async function runEightAgentWorkflow(params: { query: string; connectionString?: string }) {
    const { query, connectionString } = params;
    if (!query) throw new Error("Query is required");
    const result = await runEightAgentGraph({ userQuery: query, connectionString });
    return result;
}

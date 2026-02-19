import { createLogger } from "../observability";
import type { Subagent, SubagentContext, SubagentInput, SubagentResult } from "./types";

const log = createLogger("subagents.runner");

export async function runSubagentChain(
  agents: Subagent[],
  initialInput: SubagentInput,
  context?: SubagentContext
): Promise<SubagentResult> {
  let current: SubagentResult = { ...initialInput };

  for (const agent of agents) {
    log.debug("subagent_start", { id: agent.id, traceId: context?.traceId });
    current = await agent.run(current, context);
    log.debug("subagent_done", { id: agent.id, traceId: context?.traceId });
  }

  return current;
}

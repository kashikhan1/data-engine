import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { createDefaultChatModel } from "@/lib/llm/model";
import { extractJSON, streamModelWithRetry } from "@/lib/agents/llm-utils";
import type { PlannerStreamItem, PlannerAgentResultItem } from "./types";

export async function runJsonAgent<T>(params: {
  logPrefix: string;
  system: string;
  human: string;
  onToken?: (token: string) => void;
}): Promise<T> {
  const response = await streamModelWithRetry(
    () => createDefaultChatModel({ logPrefix: params.logPrefix, timeoutMs: 120000 }),
    [new SystemMessage(params.system), new HumanMessage(params.human)],
    params.onToken,
    2,
    300
  );
  const content = String((response as { content?: unknown })?.content || "");
  const parsed = extractJSON(content) as T | null;
  if (!parsed) throw new Error(`${params.logPrefix} returned invalid JSON.`);
  return parsed;
}

export async function* runAgentWithLiveTokens<T>(
  agentName: string,
  runner: (onToken: (token: string) => void) => Promise<T>
): AsyncGenerator<PlannerStreamItem | PlannerAgentResultItem<T>> {
  const queue: string[] = [];
  let done = false;
  let result: T | null = null;
  let failure: unknown = null;

  const task = runner((token) => {
    if (token) queue.push(token);
  })
    .then((value) => { result = value; done = true; })
    .catch((err) => { failure = err; done = true; });

  while (!done || queue.length > 0) {
    while (queue.length > 0) {
      const token = queue.shift();
      if (token) yield { kind: "event", event: { type: "planner_agent_token", agent: agentName, token } };
    }
    if (!done) await new Promise((r) => setTimeout(r, 30));
  }

  await task;
  if (failure) throw failure;
  yield { kind: "__result", result: result as T };
}

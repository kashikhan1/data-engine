import { createLogger } from "../observability";
import type {
  Subagent,
  SubagentContext,
  SubagentInput,
  SubagentResult,
  SubagentWithConfig,
  SubagentWithReflection,
  ParallelExecutionResult,
  ReflectionResult,
} from "./types";

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

export async function runSubagentWithRetry<T extends SubagentInput, R extends SubagentResult>(
  agent: SubagentWithConfig<T, R>,
  input: T,
  context?: SubagentContext,
  onRetry?: (attempt: number, error: Error) => void
): Promise<R> {
  const config = agent.config ?? { maxRetries: 2, timeoutMs: 60000, enableFallback: true };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      log.debug("subagent_attempt", { id: agent.id, attempt, traceId: context?.traceId });
      return await agent.run(input, context);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log.warn("subagent_retry", { id: agent.id, attempt, error: lastError.message, traceId: context?.traceId });
      
      if (onRetry && attempt < config.maxRetries) {
        onRetry(attempt + 1, lastError);
      }

      if (!config.enableFallback || attempt === config.maxRetries) {
        throw lastError;
      }
    }
  }

  throw lastError;
}

export async function runSubagentWithTimeout<T extends SubagentInput, R extends SubagentResult>(
  agent: Subagent<T, R>,
  input: T,
  timeoutMs: number,
  context?: SubagentContext
): Promise<R> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Subagent ${agent.id} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([agent.run(input, context), timeoutPromise]) as Promise<R>;
}

export async function runSubagentWithConfig<T extends SubagentInput, R extends SubagentResult>(
  agent: SubagentWithConfig<T, R>,
  input: T,
  context?: SubagentContext
): Promise<R> {
  const config = agent.config ?? { maxRetries: 2, timeoutMs: 60000, enableFallback: true };

  if (config.timeoutMs > 0) {
    return runSubagentWithTimeout(agent, input, config.timeoutMs, context);
  }

  return runSubagentWithRetry(agent, input, context);
}

export async function runSubagentsParallel<T extends SubagentInput, R extends SubagentResult>(
  agents: Subagent<T, R>[],
  input: T,
  context?: SubagentContext,
  concurrency: number = 5
): Promise<ParallelExecutionResult<R>> {
  const results: R[] = new Array(agents.length);
  const failed: Array<{ index: number; error: string }> = [];
  const successful: R[] = [];

  const tasks = agents.map((agent, index) => async () => {
    try {
      const result = await agent.run(input, context);
      results[index] = result;
      successful.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ index, error: message });
      log.warn("parallel_subagent_failed", { id: agent.id, index, error: message });
    }
  });

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => {
    return (async () => {
      let taskIndex = 0;
      while (taskIndex < tasks.length) {
        const task = tasks[taskIndex];
        taskIndex++;
        await task();
      }
    })();
  });

  await Promise.all(workers);

  return { results, successful, failed };
}

export async function runSubagentWithReflection<T extends SubagentInput, R extends SubagentResult>(
  agent: SubagentWithReflection<T, R>,
  input: T,
  context?: SubagentContext,
  evaluator?: (result: R, iteration: number) => Promise<{ accepted: boolean; feedback: string[] }>
): Promise<ReflectionResult<R>> {
  const reflection = agent.reflection ?? { enabled: false, maxIterations: 3, acceptanceThreshold: 0.8 };

  if (!reflection.enabled || !evaluator) {
    const result = await agent.run(input, context);
    return { result, iterations: 0, accepted: true, feedback: [] };
  }

  let current = await agent.run(input, context);
  const feedback: string[] = [];

  for (let iteration = 1; iteration <= reflection.maxIterations; iteration++) {
    log.debug("reflection_iteration", { id: agent.id, iteration, traceId: context?.traceId });

    const evaluation = await evaluator(current, iteration);
    feedback.push(...evaluation.feedback);

    if (evaluation.accepted) {
      log.info("reflection_accepted", { id: agent.id, iterations: iteration, traceId: context?.traceId });
      return { result: current, iterations: iteration, accepted: true, feedback };
    }

    if (iteration < reflection.maxIterations) {
      input = { ...input, _reflectionFeedback: evaluation.feedback, _iteration: iteration } as T;
      current = await agent.run(input, context);
    }
  }

  log.warn("reflection_max_iterations", { id: agent.id, iterations: reflection.maxIterations, traceId: context?.traceId });
  return { result: current, iterations: reflection.maxIterations, accepted: false, feedback };
}

export async function runSubagentChainWithFallback<T extends SubagentInput, R extends SubagentResult>(
  agents: Subagent<T, R>[],
  input: T,
  context?: SubagentContext,
  fallback?: () => Promise<R>
): Promise<R> {
  let lastError: Error | null = null;

  for (const agent of agents) {
    try {
      return await agent.run(input, context);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      log.warn("chain_fallback", { id: agent.id, error: lastError.message, traceId: context?.traceId });
    }
  }

  if (fallback) {
    log.info("using_fallback", { traceId: context?.traceId });
    return fallback();
  }

  throw lastError;
}

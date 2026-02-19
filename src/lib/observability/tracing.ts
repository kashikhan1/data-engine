import { createLogger } from "./logger";

const tracerLog = createLogger("tracing");

export interface TraceResult<T> {
  value: T;
  durationMs: number;
}

export async function traceAsync<T>(name: string, fn: () => Promise<T>): Promise<TraceResult<T>> {
  const start = Date.now();
  try {
    const value = await fn();
    const durationMs = Date.now() - start;
    tracerLog.debug("trace_success", { name, durationMs });
    return { value, durationMs };
  } catch (error) {
    const durationMs = Date.now() - start;
    tracerLog.error("trace_error", {
      name,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function traceSync<T>(name: string, fn: () => T): TraceResult<T> {
  const start = Date.now();
  try {
    const value = fn();
    const durationMs = Date.now() - start;
    tracerLog.debug("trace_success", { name, durationMs });
    return { value, durationMs };
  } catch (error) {
    const durationMs = Date.now() - start;
    tracerLog.error("trace_error", {
      name,
      durationMs,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

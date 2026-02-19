export interface SubagentInput {
  [key: string]: unknown;
}

export interface SubagentResult {
  [key: string]: unknown;
}

export interface SubagentContext {
  traceId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface Subagent<I extends SubagentInput = SubagentInput, O extends SubagentResult = SubagentResult> {
  id: string;
  run: (input: I, context?: SubagentContext) => Promise<O>;
}

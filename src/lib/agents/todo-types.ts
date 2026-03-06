export type TodoDomain = "widget" | "column" | "filter" | "agent" | "sql";
export type TodoStatus = "pending" | "running" | "done" | "blocked" | "failed" | "skipped";
export type TodoPriority = "critical" | "high" | "medium" | "low";
export type TodoSource = "rule" | "agent";

export type TodoItem = {
  id: string;
  domain: TodoDomain;
  scopeId: string;
  title: string;
  status: TodoStatus;
  priority: TodoPriority;
  ownerAgent?: string;
  reason?: string;
  suggestedFix?: string;
  source: TodoSource;
  createdAt: string;
  updatedAt: string;
};

export type TodoSummary = {
  byStatus: Record<TodoStatus, number>;
  byPriority: Record<TodoPriority, number>;
  total: number;
};

export type TodoListState = {
  runId: string;
  items: TodoItem[];
  summary: TodoSummary;
  agentUpdateLedger: Record<string, string[]>;
};

export function normalizeTodoScopeId(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function buildTodoSummary(items: TodoItem[]): TodoSummary {
  const byStatus: Record<TodoStatus, number> = {
    pending: 0,
    running: 0,
    done: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
  };
  const byPriority: Record<TodoPriority, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
  for (const item of items) {
    byStatus[item.status] += 1;
    byPriority[item.priority] += 1;
  }
  return { byStatus, byPriority, total: items.length };
}


import {
  buildTodoSummary,
  normalizeTodoScopeId,
  type TodoItem,
  type TodoListState,
  type TodoStatus,
} from "./todo-types";

type TodoUpdate = {
  todoId: string;
  status: TodoStatus;
  ownerAgent?: string;
  reason?: string;
  suggestedFix?: string;
};

const terminal = new Set<TodoStatus>(["done", "blocked", "failed", "skipped"]);

function canTransition(from: TodoStatus, to: TodoStatus): boolean {
  if (from === to) return true;
  if (terminal.has(from)) return false;
  if (from === "pending") return ["running", "done", "blocked", "failed", "skipped"].includes(to);
  if (from === "running") return ["done", "blocked", "failed"].includes(to);
  return false;
}

function clone(state: TodoListState): TodoListState {
  return {
    runId: state.runId,
    items: state.items.map((i) => ({ ...i })),
    summary: { ...state.summary, byStatus: { ...state.summary.byStatus }, byPriority: { ...state.summary.byPriority } },
    agentUpdateLedger: Object.fromEntries(Object.entries(state.agentUpdateLedger || {}).map(([k, v]) => [k, [...v]])),
  };
}

export function applyAgentTodoUpdates(
  state: TodoListState,
  agentName: string,
  updates: TodoUpdate[]
): TodoListState {
  if (!state) return state;
  const next = clone(state);
  const key = normalizeTodoScopeId(agentName || "unknown-agent");
  const ledgerSet = new Set(next.agentUpdateLedger[key] || []);
  const byId = new Map(next.items.map((i) => [i.id, i]));

  for (const update of updates) {
    const todoId = String(update.todoId || "").trim();
    if (!todoId || ledgerSet.has(todoId)) continue; // once-only per agent+todo
    const item = byId.get(todoId);
    if (!item) continue;
    if (!canTransition(item.status, update.status)) {
      ledgerSet.add(todoId);
      continue;
    }
    item.status = update.status;
    if (update.ownerAgent) item.ownerAgent = update.ownerAgent;
    if (update.reason) item.reason = update.reason;
    if (update.suggestedFix) item.suggestedFix = update.suggestedFix;
    item.updatedAt = new Date().toISOString();
    ledgerSet.add(todoId);
  }

  next.agentUpdateLedger[key] = Array.from(ledgerSet);
  next.summary = buildTodoSummary(next.items);
  return next;
}

export function addAgentSuggestedTodo(
  state: TodoListState,
  todo: Omit<TodoItem, "source" | "createdAt" | "updatedAt"> & { source?: "agent" | "rule" }
): TodoListState {
  const next = clone(state);
  const normalizedScope = normalizeTodoScopeId(todo.scopeId);
  const dedupeId = todo.id || `todo:${todo.domain}:${normalizedScope}`;
  const exists = next.items.some((i) => i.id === dedupeId);
  if (exists) return next;
  const ts = new Date().toISOString();
  next.items.push({
    ...todo,
    id: dedupeId,
    scopeId: normalizedScope,
    source: "agent",
    createdAt: ts,
    updatedAt: ts,
  });
  next.summary = buildTodoSummary(next.items);
  return next;
}


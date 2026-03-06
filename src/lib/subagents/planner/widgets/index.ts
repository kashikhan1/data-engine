import { createLogger } from "@/lib/observability";
import { registerWidgetPlannerSkills } from "@/lib/skills/planner";
import type { SchemaCapabilities } from "../../../agents/planner/schema-capabilities";
import type { PlannerStreamItem } from "../../../agents/planner/types";
import { kpiWidgetSubagent } from "./kpi";
import { lineWidgetSubagent } from "./line";
import { barWidgetSubagent } from "./bar";
import { areaWidgetSubagent } from "./area";
import { donutWidgetSubagent } from "./donut";
import { pieWidgetSubagent } from "./pie";
import { scatterWidgetSubagent } from "./scatter";
import { funnelWidgetSubagent } from "./funnel";
import { cohortWidgetSubagent } from "./cohort";
import { mapWidgetSubagent } from "./map";
import { tableWidgetSubagent } from "./table";
import type { WidgetAgentInput, WidgetAgentOutput } from "./types";

export type { WidgetAgentInput, WidgetAgentOutput } from "./types";
export { mergeWidgetPlans } from "./merger";

// ── Agent registry ────────────────────────────────────────────────────────────

export const ALL_WIDGET_SUBAGENTS = [
  kpiWidgetSubagent,
  lineWidgetSubagent,
  barWidgetSubagent,
  areaWidgetSubagent,
  donutWidgetSubagent,
  pieWidgetSubagent,
  scatterWidgetSubagent,
  funnelWidgetSubagent,
  cohortWidgetSubagent,
  mapWidgetSubagent,
  tableWidgetSubagent,
] as const;

const log = createLogger("subagents.planner.widgets");

function getWidgetTypeFromAgentId(agentId: string): string {
  return agentId.replace(/^widget-/, "");
}

function formatWidgetAgentName(agentId: string): string {
  return `Widget Agent: ${getWidgetTypeFromAgentId(agentId)}`;
}

function clipText(value: string, max = 1200): string {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 15)).trimEnd()}\n[...truncated]`;
}

function buildWidgetAgentInputContext(input: WidgetAgentInput, agentId: string): string {
  const widgetType = getWidgetTypeFromAgentId(agentId);
  const query = String(input?.query || "");
  const domain = String(input?.meta?.domain || "General");
  const primaryTable = String(input?.meta?.primaryTable || "unknown");
  const objectiveMode = String(input?.objective?.mode || "accuracy_first");
  const feasible = Array.isArray(input?.capabilities?.feasibleWidgetTypes)
    ? input.capabilities.feasibleWidgetTypes.join(", ")
    : "none";
  const intentLabels = Array.isArray(input?.meta?.intentLabels)
    ? input.meta.intentLabels.join(", ")
    : "none";

  return clipText(
    [
      `query=${query}`,
      `widgetType=${widgetType}`,
      `domain=${domain}`,
      `primaryTable=${primaryTable}`,
      `intentLabels=${intentLabels || "none"}`,
      `objective=${objectiveMode}`,
      `feasibleWidgetTypes=${feasible || "none"}`,
    ].join("\n")
  );
}

function selectWidgetSubagentsByCapabilities(capabilities: SchemaCapabilities) {
  const feasible = new Set((capabilities?.feasibleWidgetTypes || []).map((t) => t.toLowerCase()));
  if (feasible.size === 0) return [...ALL_WIDGET_SUBAGENTS];

  const selected = ALL_WIDGET_SUBAGENTS.filter((agent) =>
    feasible.has(getWidgetTypeFromAgentId(agent.id).toLowerCase())
  );

  // Safety fallback: never return empty, keep planner alive even if capability detection is misconfigured.
  return selected.length > 0 ? selected : [...ALL_WIDGET_SUBAGENTS];
}

function selectWidgetSubagents(input: WidgetAgentInput) {
  return selectWidgetSubagentsByCapabilities(input.capabilities);
}

export function getSelectedWidgetAgentIds(capabilities: SchemaCapabilities): string[] {
  return selectWidgetSubagentsByCapabilities(capabilities).map((agent) => agent.id);
}

// ── Parallel runner ───────────────────────────────────────────────────────────

/**
 * Runs only capability-selected widget subagents in parallel using Promise.allSettled.
 * Each agent that fails (throws) is treated as not-applicable and excluded.
 * Skills are registered idempotently before any agent runs.
 */
export async function runWidgetAgentsInParallel(
  input: WidgetAgentInput,
  onToken?: (agentId: string, token: string) => void
): Promise<WidgetAgentOutput[]> {
  registerWidgetPlannerSkills();
  const selectedAgents = selectWidgetSubagents(input);

  log.debug("parallel_start", {
    totalAgentCount: ALL_WIDGET_SUBAGENTS.length,
    selectedAgentCount: selectedAgents.length,
    selectedWidgetTypes: selectedAgents.map((agent) => getWidgetTypeFromAgentId(agent.id)),
  });

  const results = await Promise.allSettled(
    selectedAgents.map((agent) =>
      agent.run(input, {
        onToken: onToken ? (token: string) => onToken(formatWidgetAgentName(agent.id), token) : undefined,
      })
    )
  );

  const outputs: WidgetAgentOutput[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      outputs.push(result.value);
    } else {
      log.warn("widget_agent_failed", { reason: String(result.reason) });
    }
  }

  const applicable = outputs.filter((o) => o.applicable);
  log.debug("parallel_done", { total: outputs.length, applicable: applicable.length });

  return outputs;
}

// ── Streaming parallel runner ─────────────────────────────────────────────────

/**
 * AsyncGenerator variant of `runWidgetAgentsInParallel` with capability-based selection.
 * Yields `planner_agent_token` events as widget agents stream tokens.
 * Yields a `__result` item containing all WidgetAgentOutput[] when done.
 *
 * Uses a shared token queue — all agents push tokens concurrently,
 * the generator drains the queue while agents are running.
 */
export async function* streamWidgetAgentsInParallel(
  input: WidgetAgentInput
): AsyncGenerator<PlannerStreamItem | { kind: "__result"; result: WidgetAgentOutput[] }> {
  registerWidgetPlannerSkills();
  const selectedAgents = selectWidgetSubagents(input);

  log.debug("stream_parallel_start", {
    totalAgentCount: ALL_WIDGET_SUBAGENTS.length,
    selectedAgentCount: selectedAgents.length,
    selectedWidgetTypes: selectedAgents.map((agent) => getWidgetTypeFromAgentId(agent.id)),
  });

  const queue: Array<{ agentId: string; token: string }> = [];
  let done = false;
  let outputs: WidgetAgentOutput[] = [];
  let settled: PromiseSettledResult<WidgetAgentOutput>[] = [];

  for (const agent of selectedAgents) {
    yield {
      kind: "event",
      event: {
        type: "planner_agent_input",
        agent: formatWidgetAgentName(agent.id),
        content: buildWidgetAgentInputContext(input, agent.id),
      },
    };
    yield {
      kind: "event",
      event: { type: "planner_agent_status", agent: formatWidgetAgentName(agent.id), status: "start" },
    };
  }

  const task = Promise.allSettled(
    selectedAgents.map((agent) =>
      agent.run(input, {
        onToken: (token: string) => {
          if (token) queue.push({ agentId: formatWidgetAgentName(agent.id), token });
        },
      })
    )
  )
    .then((results) => {
      settled = results;
      outputs = results
        .filter(
          (r): r is PromiseFulfilledResult<WidgetAgentOutput> => r.status === "fulfilled"
        )
        .map((r) => r.value);
    })
    .catch((err) => {
      log.error("stream_parallel_error", { error: String(err) });
    })
    .finally(() => {
      done = true;
    });

  // Drain the shared queue while agents are running
  while (!done || queue.length > 0) {
    while (queue.length > 0) {
      const item = queue.shift()!;
      yield {
        kind: "event",
        event: {
          type: "planner_agent_token",
          agent: item.agentId,
          token: item.token,
        },
      };
    }
    if (!done) await new Promise((r) => setTimeout(r, 30));
  }

  await task;

  for (let i = 0; i < selectedAgents.length; i++) {
    const agent = selectedAgents[i];
    const item = settled[i];
    const output = item?.status === "fulfilled"
      ? (item as PromiseFulfilledResult<WidgetAgentOutput>).value
      : null;
    const failureReason = item?.status === "rejected" ? String(item.reason || "unknown error") : "";
    yield {
      kind: "event",
      event: {
        type: "planner_agent_status",
        agent: formatWidgetAgentName(agent.id),
        status: "done",
      },
    };
    if (output || failureReason) {
      const summary = output
        ? (output.applicable
        ? `Decision: ${output.goal || "Covers a core business question."} Signal: ${output.title || output.widgetType} (${output.widgetType}). Rationale: ${output.rationale || "Best fit to query/schema and objective."}`
        : `Decision: skip ${getWidgetTypeFromAgentId(agent.id)}. Rationale: ${output.rationale || "Not applicable."} Impact: prevents low-confidence or misleading insight.`)
        : `Decision: skip ${getWidgetTypeFromAgentId(agent.id)} due to runtime failure. Rationale: ${failureReason}. Impact: planner continues with remaining high-confidence widgets.`;
      yield {
        kind: "event",
        event: {
          type: "planner_agent_draft",
          agent: formatWidgetAgentName(agent.id),
          content: summary,
        },
      };
    }
  }

  const applicable = outputs.filter((o) => o.applicable);
  log.debug("stream_parallel_done", { total: outputs.length, applicable: applicable.length });

  yield { kind: "__result", result: outputs };
}

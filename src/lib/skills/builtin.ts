import { registerSkill, type SkillDefinition } from "./registry";

type SummarizeInput = {
  rows: Array<Record<string, unknown>>;
  maxRows?: number;
};

type SummarizeOutput = {
  rowCount: number;
  sample: Array<Record<string, unknown>>;
};

const summarizeRowsSkill: SkillDefinition<SummarizeInput, SummarizeOutput> = {
  id: "summarize-rows",
  description: "Return row count and sample rows for preview rendering.",
  run: async (input) => {
    const rows = Array.isArray(input?.rows) ? input.rows : [];
    const maxRows = typeof input?.maxRows === "number" ? Math.max(1, input.maxRows) : 3;
    return {
      rowCount: rows.length,
      sample: rows.slice(0, maxRows),
    };
  },
};

type NumericTopInput = {
  metrics: Array<{ key: string; value: number }>;
  limit?: number;
};

type NumericTopOutput = {
  top: Array<{ key: string; value: number }>;
};

const topMetricsSkill: SkillDefinition<NumericTopInput, NumericTopOutput> = {
  id: "top-metrics",
  description: "Sort numeric metrics descending and return the top N entries.",
  run: async (input) => {
    const metrics = Array.isArray(input?.metrics) ? input.metrics : [];
    const limit = typeof input?.limit === "number" ? Math.max(1, input.limit) : 5;
    return {
      top: [...metrics]
        .filter((m) => typeof m?.value === "number" && Number.isFinite(m.value))
        .sort((a, b) => b.value - a.value)
        .slice(0, limit),
    };
  },
};

let registered = false;

export function registerBuiltinSkills(): void {
  if (registered) return;
  registerSkill(summarizeRowsSkill);
  registerSkill(topMetricsSkill);
  registered = true;
}

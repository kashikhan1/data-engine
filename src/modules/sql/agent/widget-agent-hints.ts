/* eslint-disable @typescript-eslint/no-explicit-any */

function parseWidgetDetailsFromPlan(rawPlan: string) {
    if (!rawPlan) return [];
    const cleaned = rawPlan.replace(/\*\*|\*|__|#/g, '');
    const matches = Array.from(cleaned.matchAll(/(?:^|\n)\s*WIDGET\s*\d+[^]*?(?=(?:\n\s*WIDGET\s*\d+)|$)/gi));
    return matches.map((match) => {
        const block = match[0];
        const extractField = (label: string, nextLabels: string[]) => {
            const boundary = nextLabels.length > 0
                ? `(?:\\n\\s*(?:${nextLabels.join("|")})\\s*:)`
                : "(?:$)";
            const pattern = new RegExp(`${label}\\s*:\\s*([\\s\\S]*?)(?=${boundary}|$)`, "i");
            const found = block.match(pattern)?.[1] || "";
            return found.split("\n").map((line) => line.trim()).filter(Boolean).join(" ").trim();
        };
        const tablesRequiredValue = extractField("Tables required", ["Uses", "Filters applied", "Notes", "Confidence", "Rationale", "Why", "Shows"]);
        const usesValue = extractField("Uses", ["Filters applied", "Notes", "Confidence", "Rationale", "Why", "Shows"]);
        const filtersValue = extractField("Filters applied", ["Notes", "Confidence", "Rationale", "Uses", "Why", "Shows"]);
        const notesValue = extractField("Notes", ["Confidence", "Rationale", "Filters applied", "Uses", "Why", "Shows"]);
        const confidenceValue = extractField("Confidence", ["Rationale", "Notes", "Filters applied", "Uses", "Why", "Shows"]);
        const rationaleValue = extractField("Rationale", ["Confidence", "Notes", "Filters applied", "Uses", "Why", "Shows"]);
        return {
            tablesRequired: tablesRequiredValue,
            uses: usesValue,
            filters: filtersValue,
            notes: notesValue,
            confidence: confidenceValue,
            rationale: rationaleValue
        };
    });
}

function normalizeWidgetTitleKey(title: string) {
    return String(title || "")
        .toLowerCase()
        .replace(/\(\d+\)\s*$/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

function collectSchemaRefsFromText(text: string) {
    const refs: Array<{ table: string; column: string; raw: string }> = [];
    const regex = /([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(String(text || ""))) !== null) {
        refs.push({
            table: String(match[1]),
            column: String(match[2]),
            raw: `${match[1]}.${match[2]}`
        });
    }
    return refs;
}

function buildSchemaColumnSet(schemaForPrompt: any) {
    const valid = new Set<string>();
    Object.entries(schemaForPrompt?.schemaInfo || {}).forEach(([table, info]: [string, any]) => {
        const cols = Array.isArray(info?.columns) ? info.columns : [];
        cols.forEach((col: any) => {
            const name = String(col?.name || col?.column_name || "");
            if (!name) return;
            valid.add(`${String(table).toLowerCase()}.${name.toLowerCase()}`);
        });
    });
    return valid;
}

export function validateAgentWidgetHintsAgainstSchema(
    outputs: Record<string, any[]>,
    schemaForPrompt: any
) {
    const validRefs = buildSchemaColumnSet(schemaForPrompt);
    const validated: Record<string, any[]> = {};
    Object.entries(outputs || {}).forEach(([widgetId, items]) => {
        validated[widgetId] = (Array.isArray(items) ? items : []).map((entry: any) => {
            const text = [entry?.uses, entry?.filtersApplied, entry?.notes].filter(Boolean).join("\n");
            const refs = collectSchemaRefsFromText(text);
            const acceptedRefs = Array.from(new Set(
                refs
                    .map((r) => `${r.table.toLowerCase()}.${r.column.toLowerCase()}`)
                    .filter((ref) => validRefs.has(ref))
            ));
            const rejectedRefs = Array.from(new Set(
                refs
                    .map((r) => `${r.table.toLowerCase()}.${r.column.toLowerCase()}`)
                    .filter((ref) => !validRefs.has(ref))
            ));
            return {
                ...entry,
                acceptedRefs,
                rejectedRefs
            };
        });
    });
    return validated;
}

function sanitizeWidgetHintEntryForPrompt(entry: any) {
    const rejectedRefs = Array.isArray(entry?.rejectedRefs) ? entry.rejectedRefs : [];
    const acceptedRefs = Array.isArray(entry?.acceptedRefs) ? entry.acceptedRefs : [];
    const sanitizeText = (text: string) => {
        let cleaned = String(text || "");
        rejectedRefs.forEach((ref: string) => {
            const escaped = String(ref || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            if (!escaped) return;
            cleaned = cleaned.replace(new RegExp(`\\b${escaped}\\b`, "gi"), "[invalid_ref_removed]");
        });
        return cleaned.trim();
    };
    return {
        agent: entry?.agent,
        type: entry?.type,
        title: entry?.title,
        goal: entry?.goal,
        primaryTable: entry?.primaryTable,
        uses: sanitizeText(entry?.uses || ""),
        filtersApplied: sanitizeText(entry?.filtersApplied || ""),
        notes: sanitizeText(entry?.notes || ""),
        confidence: entry?.confidence,
        rationale: entry?.rationale,
        acceptedRefs,
        rejectedRefs,
        schemaGuard: rejectedRefs.length > 0
            ? `Rejected refs removed: ${rejectedRefs.join(", ")}. Use only acceptedRefs.`
            : "All references schema-validated."
    };
}

export function sanitizeWidgetAgentOutputsForPrompt(outputs: Record<string, any[]>) {
    const next: Record<string, any[]> = {};
    Object.entries(outputs || {}).forEach(([widgetId, entries]) => {
        next[widgetId] = (Array.isArray(entries) ? entries : []).map((entry: any) => sanitizeWidgetHintEntryForPrompt(entry));
    });
    return next;
}

export async function deriveWidgetAgentOutputsFromPlan(plan: any, effectiveWidgets: any[]) {
    const existing = plan?.widgetAgentOutputs;
    if (existing && typeof existing === "object" && Object.keys(existing).length > 0) {
        return existing as Record<string, any[]>;
    }

    const plannerDebug = (plan as any)?.plannerDebug;
    const agentDrafts = plannerDebug?.agentDrafts;
    if (!agentDrafts || typeof agentDrafts !== "object") return {};

    const { parseNaturalLanguagePlan } = await import('@/utils/plan-parser');
    const byKey = new Map<string, any[]>();
    const byType = new Map<string, any[]>();

    Object.entries(agentDrafts).forEach(([agent, draft]: [string, any]) => {
        const text = String(draft || "").trim();
        if (!text) return;
        const parsed = parseNaturalLanguagePlan(text);
        const details = parseWidgetDetailsFromPlan(text);
        parsed.forEach((widget: any, idx: number) => {
            const detail = details[idx] || {};
            const candidate = {
                agent,
                type: String(widget?.type || "").toLowerCase(),
                title: String(widget?.title || "").trim(),
                goal: String(widget?.goal || "").trim(),
                primaryTable: widget?.primaryTable,
                requiredTables: String(detail?.tablesRequired || "")
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                uses: String(detail?.uses || "").trim(),
                filtersApplied: String(detail?.filters || "").trim(),
                notes: String(detail?.notes || widget?.notes || "").trim(),
                confidence: String(detail?.confidence || "").trim(),
                rationale: String(detail?.rationale || "").trim()
            };
            if (!candidate.type || !candidate.title) return;
            const key = `${candidate.type}::${normalizeWidgetTitleKey(candidate.title)}`;
            byKey.set(key, [...(byKey.get(key) || []), candidate]);
            byType.set(candidate.type, [...(byType.get(candidate.type) || []), candidate]);
        });
    });

    const outputs: Record<string, any[]> = {};
    (effectiveWidgets || []).forEach((widget: any) => {
        const type = String(widget?.type || "").toLowerCase();
        const title = String(widget?.title || "").trim();
        const key = `${type}::${normalizeWidgetTitleKey(title)}`;
        const primary = byKey.get(key) || [];
        const fallback = (byType.get(type) || []).filter((c: any) => !primary.includes(c)).slice(0, 2);
        const merged = [...primary, ...fallback].slice(0, 5);
        if (merged.length > 0) {
            outputs[String(widget.id)] = merged;
        }
    });

    return outputs;
}

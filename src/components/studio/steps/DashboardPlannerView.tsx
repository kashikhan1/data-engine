'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useConfigStore, useWorkflowStore } from '@/state/stores';
import {
    Button,
    Card,
    Typography,
    Space,
    Divider,
    Input,
    Alert,
    Tooltip,
    Tag,
    Switch
} from 'antd';
import {
    ReloadOutlined,
    ArrowRightOutlined,
    EditOutlined,
    SaveOutlined,
    RollbackOutlined,
    BulbOutlined
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;
const PLANNER_DEBUG_STORAGE_KEY = 'planner_debug_outputs_v1';
const PLANNER_DEBUG_STORAGE_VERSION = 2;
const PLANNER_AUTO_RUN_KEY = 'planner_auto_run_key_v1';

type PlannerDebugPayload = {
    plannerAgents?: string | null;
    plannerAgentStatus?: Record<string, "start" | "done" | "error">;
    agentInputs?: Record<string, string>;
    agentStreams?: Record<string, string>;
    agentDrafts?: Record<string, string>;
    agentOrder?: string[];
    intentLabels?: string[];
    selectedAgent?: string | null;
};

export const DashboardPlannerView: React.FC = () => {
    const {
        query,
        schemaData,
        userSchemaNotes,
        schemaTimestamp,
        aiPlan,
        setAiPlan,
        userPlan,
        setUserPlan,
        plannerLiveDebug,
        setPlannerLiveDebug,
        resetPlannerLiveDebug,
        isProcessing,
        setProcessing,
        error,
        setError,
        setStep,
        staleStep,
        setStaleStep,
        todoListState,
        initTodoList,
        applyTodoItemUpdate,
        setTodoSummary
    } = useWorkflowStore();
    const { disabledWidgetTypes } = useConfigStore();

    const [isEditing, setIsEditing] = useState(false);
    const [localPlanText, setLocalPlanText] = useState('');
    const [plannerAgents, setPlannerAgents] = useState<string | null>(null);
    const [plannerAgentStatus, setPlannerAgentStatus] = useState<Record<string, "start" | "done" | "error">>({});
    const [agentInputs, setAgentInputs] = useState<Record<string, string>>({});
    const [agentStreams, setAgentStreams] = useState<Record<string, string>>({});
    const [agentDrafts, setAgentDrafts] = useState<Record<string, string>>({});
    const [intentLabels, setIntentLabels] = useState<string[]>([]);
    const [agentOrder, setAgentOrder] = useState<string[]>([]);
    const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
    const agentStreamBufferRef = useRef<Record<string, string>>({});
    const agentStreamFlushRef = useRef<number | null>(null);
    const plannerAgentStatusRef = useRef<Record<string, "start" | "done" | "error">>({});
    const agentInputsRef = useRef<Record<string, string>>({});
    const agentDraftsRef = useRef<Record<string, string>>({});
    const agentOrderRef = useRef<string[]>([]);
    const intentLabelsRef = useRef<string[]>([]);
    const selectedAgentRef = useRef<string | null>(null);
    const plannerAgentsRef = useRef<string | null>(null);
    const isPlanningRef = useRef(false);
    const autoRunKeyRef = useRef<string | null>(null);
    const plannerFilterCandidatesRef = useRef<string[]>([]);
    const stripEventStream = (text: string) => {
        const marker = "EVENT_STREAM:";
        const idx = text.indexOf(marker);
        return idx === -1 ? text : text.slice(0, idx).trim();
    };
    const extractPlannerAgents = (text: string) => {
        if (!text) return null;
        const marker = "EVENT_STREAM:";
        const idx = text.indexOf(marker);
        if (idx === -1) return null;
        const payload = text.slice(idx + marker.length);
        const lines = payload.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('{')) continue;
            try {
                const evt = JSON.parse(trimmed);
                if (evt?.type === 'planner_agents' && typeof evt.content === 'string') {
                    return evt.content;
                }
                if (evt?.type === 'planner_agent_status' && evt.agent && evt.status) {
                    setPlannerAgentStatus((prev) => ({ ...prev, [evt.agent]: evt.status }));
                }
            } catch {
                // ignore malformed lines
            }
        }
        return null;
    };
    const flushAgentStreams = () => {
        const pending = agentStreamBufferRef.current;
        agentStreamBufferRef.current = {};
        agentStreamFlushRef.current = null;
        const keys = Object.keys(pending);
        if (keys.length === 0) return;
        setAgentStreams((prev) => {
            const next = { ...prev };
            keys.forEach((key) => {
                next[key] = `${next[key] || ""}${pending[key]}`;
            });
            return next;
        });
        syncPlannerLiveDebug();
    };
    const bufferAgentToken = (agent: string, token: string) => {
        if (!agent || !token) return;
        agentStreamBufferRef.current[agent] = `${agentStreamBufferRef.current[agent] || ""}${token}`;
        if (agentStreamFlushRef.current === null) {
            agentStreamFlushRef.current = window.setTimeout(flushAgentStreams, 60);
        }
    };
    const buildPlannerDebugPayload = (): PlannerDebugPayload => {
        const pending = agentStreamBufferRef.current || {};
        const mergedStreams = { ...agentStreams };
        Object.entries(pending).forEach(([agent, chunk]) => {
            mergedStreams[agent] = `${mergedStreams[agent] || ""}${chunk}`;
        });
        const agentNamesFromHeader = String(plannerAgentsRef.current || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const statusMap = { ...plannerAgentStatusRef.current };
        const hasOutput = (agent: string) => {
            const streamText = String(mergedStreams?.[agent] || "").trim();
            const draftText = String(agentDraftsRef.current?.[agent] || "").trim();
            return streamText.length > 0 || draftText.length > 0;
        };
        Object.keys(statusMap).forEach((agent) => {
            if (statusMap[agent] === "error" && hasOutput(agent)) {
                statusMap[agent] = "done";
            }
        });
        agentNamesFromHeader.forEach((name) => {
            if (!statusMap[name]) statusMap[name] = "done";
        });
        const order = Array.from(new Set([
            ...agentOrderRef.current,
            ...agentNamesFromHeader,
            ...Object.keys(statusMap),
            ...Object.keys(agentDraftsRef.current || {}),
            ...Object.keys(mergedStreams || {})
        ]));
        return {
            plannerAgents: plannerAgentsRef.current,
            plannerAgentStatus: statusMap,
            agentInputs: { ...agentInputsRef.current },
            agentStreams: mergedStreams,
            agentDrafts: { ...agentDraftsRef.current },
            agentOrder: order,
            intentLabels: [...intentLabelsRef.current],
            selectedAgent: selectedAgentRef.current
        };
    };
    const syncPlannerLiveDebug = () => {
        setPlannerLiveDebug(buildPlannerDebugPayload());
    };
    const persistPlannerDebugToLocal = (rawPlan: string, payload: PlannerDebugPayload, title?: string, widgets?: any[]) => {
        try {
            if (!query || !schemaTimestamp) return;
            const cache = {
                query,
                schemaTimestamp,
                title: title || "AI Analytics Dashboard",
                rawPlan: stripEventStream(rawPlan || ""),
                widgets: Array.isArray(widgets) ? widgets : [],
                plannerDebug: payload,
                savedAt: new Date().toISOString()
            };
            const key = `${query}::${schemaTimestamp || ''}`;
            const raw = localStorage.getItem(PLANNER_DEBUG_STORAGE_KEY);
            let nextStore: any = {
                version: PLANNER_DEBUG_STORAGE_VERSION,
                latestKey: key,
                entries: {}
            };
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object' && parsed.version === PLANNER_DEBUG_STORAGE_VERSION && parsed.entries) {
                        nextStore = {
                            version: PLANNER_DEBUG_STORAGE_VERSION,
                            latestKey: parsed.latestKey || key,
                            entries: { ...parsed.entries }
                        };
                    } else if (parsed && typeof parsed === 'object' && parsed.query) {
                        const legacyKey = `${String(parsed.query)}::${String(parsed.schemaTimestamp || '')}`;
                        nextStore.entries[legacyKey] = parsed;
                    }
                } catch {
                    // ignore parse issues and overwrite structure
                }
            }
            nextStore.latestKey = key;
            nextStore.entries[key] = cache;
            localStorage.setItem(PLANNER_DEBUG_STORAGE_KEY, JSON.stringify(nextStore));
        } catch {
            // ignore persistence failures
        }
    };
    const buildFiltersFromRefs = (refs: string[]): any[] => {
        return refs.map((ref) => {
            const lower = String(ref || "").toLowerCase();
            const isDate = /date|time|created|updated|timestamp|month|year|week|period/.test(lower);
            const label = ref.split(".").pop()?.replace(/_/g, " ") || ref;
            return {
                id: ref.replace(/[^a-zA-Z0-9_.-]/g, "_"),
                dimension: ref,
                label: label.replace(/\b\w/g, (c) => c.toUpperCase()),
                type: isDate ? "date-range" : "select",
                value: isDate ? "this_month" : null,
            };
        });
    };

    const handlePlannerEvent = (evt: any) => {
        if (!evt?.type) return;
        if (evt.type === 'planner_agents' && typeof evt.content === 'string') {
            plannerAgentsRef.current = evt.content;
            setPlannerAgents(evt.content);
            syncPlannerLiveDebug();
            return;
        }
        if (evt.type === 'planner_agent_status' && evt.agent && evt.status) {
            plannerAgentStatusRef.current = { ...plannerAgentStatusRef.current, [evt.agent]: evt.status };
            setPlannerAgentStatus((prev) => ({ ...prev, [evt.agent]: evt.status }));
            if (evt.status === 'start') {
                if (!agentOrderRef.current.includes(evt.agent)) {
                    agentOrderRef.current = [...agentOrderRef.current, evt.agent];
                }
                if (!selectedAgentRef.current) {
                    selectedAgentRef.current = evt.agent;
                }
                setAgentOrder((prev) => (prev.includes(evt.agent) ? prev : [...prev, evt.agent]));
                setSelectedAgent((prev) => prev || evt.agent);
            }
            syncPlannerLiveDebug();
            return;
        }
        if (evt.type === 'planner_agent_token' && evt.agent && evt.token) {
            bufferAgentToken(evt.agent, evt.token);
            syncPlannerLiveDebug();
            return;
        }
        if (evt.type === 'planner_agent_input' && evt.agent) {
            const content = String(evt.content || "");
            agentInputsRef.current = { ...agentInputsRef.current, [evt.agent]: content };
            setAgentInputs((prev) => ({ ...prev, [evt.agent]: content }));
            if (!selectedAgentRef.current) selectedAgentRef.current = evt.agent;
            setAgentOrder((prev) => (prev.includes(evt.agent) ? prev : [...prev, evt.agent]));
            setSelectedAgent((prev) => prev || evt.agent);
            syncPlannerLiveDebug();
            return;
        }
        if (evt.type === 'planner_agent_draft' && evt.agent) {
            const content = evt.content || "";
            agentDraftsRef.current = { ...agentDraftsRef.current, [evt.agent]: content };
            if (!selectedAgentRef.current) selectedAgentRef.current = evt.agent;
            setAgentDrafts((prev) => ({ ...prev, [evt.agent]: content }));
            setAgentStreams((prev) => {
                const existing = String(prev?.[evt.agent] || "");
                if (existing.trim().length > 0) return prev;
                return { ...prev, [evt.agent]: String(content || "") };
            });
            if (!selectedAgent) setSelectedAgent(evt.agent);
            if ((evt.agent === "Plan Generator" || evt.agent === "Final Plan Agent") && content && !isEditing) {
                setLocalPlanText(content);
                const allowedTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
                (disabledWidgetTypes || []).forEach((t) => allowedTypes.delete(t));
                import('@/utils/plan-parser').then(({ extractDashboardTitle, parseNaturalLanguagePlan, parsePlanFilters }) => {
                    const widgets = parseNaturalLanguagePlan(content).filter((w: any) => allowedTypes.has(w?.type));
                    const title = extractDashboardTitle(content) || "AI Analytics Dashboard";
                    const interimFilters = plannerFilterCandidatesRef.current.length > 0
                        ? buildFiltersFromRefs(plannerFilterCandidatesRef.current)
                        : parsePlanFilters(content);
                    setAiPlan({
                        title,
                        rawPlan: content,
                        widgets,
                        filters: interimFilters,
                        plannerAgents: plannerAgents || undefined,
                        plannerDebug: buildPlannerDebugPayload(),
                        schemaTimestamp,
                        query
                    });
                }).catch(() => {
                    // ignore parse errors for drafts
                });
            }
            syncPlannerLiveDebug();
            return;
        }
        if (evt.type === 'planner_filter_candidates' && Array.isArray(evt.filters)) {
            plannerFilterCandidatesRef.current = evt.filters;
            return;
        }
        if (evt.type === 'planner_intents') {
            intentLabelsRef.current = Array.isArray(evt.intents) ? evt.intents : [];
            setIntentLabels(Array.isArray(evt.intents) ? evt.intents : []);
            syncPlannerLiveDebug();
            return;
        }
        if (evt.type === 'planner_error') {
            const message = typeof evt.message === 'string' ? evt.message : 'Planner failed.';
            setError(message);
            return;
        }
        if (evt.type === 'todo_list_initialized' && evt.todoList) {
            initTodoList(evt.todoList);
            return;
        }
        if (evt.type === 'todo_item_updated' && evt.item) {
            applyTodoItemUpdate(evt.item);
            return;
        }
        if (evt.type === 'todo_summary' && evt.summary) {
            setTodoSummary(evt.summary);
        }
    };
    useEffect(() => {
        selectedAgentRef.current = selectedAgent;
    }, [selectedAgent]);
    const handlePlan = async () => {
        if (!query || !schemaData) return;
        if (isPlanningRef.current) return;
        isPlanningRef.current = true;
        setProcessing(true);
        setError(null);
        setLocalPlanText(''); // Clear old plan to show new stream start
        setPlannerAgents(null);
        setPlannerAgentStatus({});
        setAgentInputs({});
        setAgentStreams({});
        setAgentDrafts({});
        setIntentLabels([]);
        setAgentOrder([]);
        setSelectedAgent(null);
        resetPlannerLiveDebug();
        plannerAgentsRef.current = null;
        plannerAgentStatusRef.current = {};
        agentInputsRef.current = {};
        agentDraftsRef.current = {};
        intentLabelsRef.current = [];
        agentOrderRef.current = [];
        selectedAgentRef.current = null;
        plannerFilterCandidatesRef.current = [];
        agentStreamBufferRef.current = {};
        if (agentStreamFlushRef.current !== null) {
            window.clearTimeout(agentStreamFlushRef.current);
            agentStreamFlushRef.current = null;
        }

        try {
            // Compute fresh filterableColumns from schemaInfo + localStorage toggles.
            // Mirrors SchemaDiscoveryView.applyColumnToggles exactly so the filter list is always current.
            const getFreshFilterCols = (): { filterableColumns: Record<string, string[]>; disabledFilterColumns: Record<string, string[]> } => {
                try {
                    const raw = localStorage.getItem('schema_column_toggles');
                    const toggles = raw ? JSON.parse(raw) as Record<string, Record<string, { filterable?: boolean }>> : {};
                    const schemaInfo = ((schemaData as any)?.schemaInfo || {}) as Record<string, any>;
                    const filterableCols: Record<string, string[]> = {};
                    const disabledCols: Record<string, string[]> = {};

                    // Same default-filterable logic as SchemaDiscoveryView.isDefaultFilterableColumn
                    const isDefaultFilterable = (col: any): boolean => {
                        const type = String(col?.type || col?.data_type || '').toLowerCase();
                        return /date|time|timestamp/.test(type) || type.includes('enum');
                    };

                    Object.entries(schemaInfo).forEach(([tableName, info]) => {
                        const columns: any[] = Array.isArray(info?.columns) ? info.columns : [];
                        const tableToggles = toggles[tableName] || {};

                        // Start from default-filterable columns
                        const filterableSet = new Set<string>(
                            columns
                                .map((c: any) => c?.name || c?.column_name)
                                .filter((name: string) => {
                                    if (!name) return false;
                                    const col = columns.find((c: any) => (c?.name || c?.column_name) === name);
                                    return isDefaultFilterable(col);
                                })
                        );

                        const disabledForTable: string[] = [];
                        columns.forEach((col: any) => {
                            const name: string = col?.name || col?.column_name;
                            if (!name) return;
                            const entry = tableToggles[name];
                            if (entry && 'filterable' in entry) {
                                if (entry.filterable === false) {
                                    filterableSet.delete(name);
                                    disabledForTable.push(name);
                                } else if (entry.filterable === true) {
                                    filterableSet.add(name);
                                }
                            }
                        });

                        const result = Array.from(filterableSet);
                        if (result.length > 0) filterableCols[tableName] = result;
                        if (disabledForTable.length > 0) disabledCols[tableName] = disabledForTable;
                    });

                    return { filterableColumns: filterableCols, disabledFilterColumns: disabledCols };
                } catch {
                    return {
                        filterableColumns: (schemaData as any)?.filterableColumns || {},
                        disabledFilterColumns: (schemaData as any)?.disabledFilterColumns || {}
                    };
                }
            };
            const { filterableColumns: freshFilterable, disabledFilterColumns: freshDisabled } = getFreshFilterCols();

            // Use streaming API for real-time feedback
            const response = await fetch('/api/plan/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query,
                    schema: {
                        ...schemaData,
                        filterableColumns: freshFilterable,
                        disabledFilterColumns: freshDisabled,
                        userSchemaNotes,
                        disabledWidgetTypes
                    }
                })
            });

            if (!response.ok) throw new Error('Planner connection failed. Please check if the LLM server is running.');

            const reader = response.body?.getReader();
            const decoder = new TextDecoder();
            let fullText = '';
            let buffer = '';

            if (reader) {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || ''; // Keep the last (potentially incomplete) line

                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('data: ')) {
                            try {
                                const data = JSON.parse(trimmed.substring(6));
                                if ((data?.kind === 'chunk' || (!data?.kind && data.chunk)) && data.chunk) {
                                    fullText += data.chunk;
                                    setLocalPlanText(stripEventStream(fullText));
                                } else if ((data?.kind === 'event' && data.event) || data?.event) {
                                    const evt = data.event || data;
                                    handlePlannerEvent(evt);
                                }
                            } catch {
                                // Ignore partials
                            }
                        }
                    }
                }
            }

            // Once streaming is done, finalize the plan structure (widgets, title, etc) client-side
            const { extractDashboardTitle, parseNaturalLanguagePlan, parsePlanFilters } = await import('@/utils/plan-parser');
            const cleanedPlanText = stripEventStream(fullText);
            const agentInfo = plannerAgentsRef.current || extractPlannerAgents(fullText) || plannerAgents || null;
            if (agentInfo) {
                plannerAgentsRef.current = agentInfo;
                setPlannerAgents(agentInfo);
            }
            const allowedTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
            (disabledWidgetTypes || []).forEach((t) => allowedTypes.delete(t));
            const parsedWidgets = parseNaturalLanguagePlan(cleanedPlanText).filter((w: any) => allowedTypes.has(w?.type));
            const title = extractDashboardTitle(cleanedPlanText) || "AI Analytics Dashboard";
            const plannerFilters = plannerFilterCandidatesRef.current.length > 0
                ? buildFiltersFromRefs(plannerFilterCandidatesRef.current)
                : parsePlanFilters(cleanedPlanText);
            const finalizedData = {
                title,
                rawPlan: cleanedPlanText,
                widgets: parsedWidgets,
                filters: plannerFilters,
                plannerAgents: agentInfo,
                plannerDebug: buildPlannerDebugPayload(),
                schemaTimestamp,
                query
            };
            setPlannerLiveDebug(finalizedData.plannerDebug);
            persistPlannerDebugToLocal(cleanedPlanText, finalizedData.plannerDebug, title, parsedWidgets);
            setAiPlan(finalizedData);
            // Clear stale flag for this step if successful
            if (staleStep === 2) setStaleStep(null);
        } catch (err: any) {
            console.error("Streaming error:", err);
            setError(err.message);
        } finally {
            isPlanningRef.current = false;
            setProcessing(false);
        }
    };

    useEffect(() => {
        if (userPlan?.rawPlan) {
            setLocalPlanText(userPlan.rawPlan);
            setPlannerAgents(userPlan?.plannerAgents || extractPlannerAgents(userPlan.rawPlan));
            const debug = (userPlan as any)?.plannerDebug as PlannerDebugPayload | undefined;
            if (debug) {
                setPlannerAgentStatus(debug.plannerAgentStatus || {});
                setAgentInputs(debug.agentInputs || {});
                setAgentStreams(debug.agentStreams || {});
                setAgentDrafts(debug.agentDrafts || {});
                setAgentOrder(Array.isArray(debug.agentOrder) ? debug.agentOrder : []);
                setIntentLabels(Array.isArray(debug.intentLabels) ? debug.intentLabels : []);
                setSelectedAgent(debug.selectedAgent || null);
                plannerAgentsRef.current = (userPlan?.plannerAgents || extractPlannerAgents(userPlan.rawPlan)) || null;
                plannerAgentStatusRef.current = debug.plannerAgentStatus || {};
                agentInputsRef.current = debug.agentInputs || {};
                agentDraftsRef.current = debug.agentDrafts || {};
                agentOrderRef.current = Array.isArray(debug.agentOrder) ? debug.agentOrder : [];
                intentLabelsRef.current = Array.isArray(debug.intentLabels) ? debug.intentLabels : [];
                selectedAgentRef.current = debug.selectedAgent || null;
                setPlannerLiveDebug(debug);
            } else {
                // Keep currently streamed debug state when plan payload lacks plannerDebug.
                plannerAgentsRef.current = (userPlan?.plannerAgents || extractPlannerAgents(userPlan.rawPlan)) || plannerAgentsRef.current || null;
            }
            return;
        }
        if (aiPlan?.rawPlan) {
            setLocalPlanText(aiPlan.rawPlan);
            setPlannerAgents(aiPlan?.plannerAgents || extractPlannerAgents(aiPlan.rawPlan));
            const debug = (aiPlan as any)?.plannerDebug as PlannerDebugPayload | undefined;
            if (debug) {
                setPlannerAgentStatus(debug.plannerAgentStatus || {});
                setAgentInputs(debug.agentInputs || {});
                setAgentStreams(debug.agentStreams || {});
                setAgentDrafts(debug.agentDrafts || {});
                setAgentOrder(Array.isArray(debug.agentOrder) ? debug.agentOrder : []);
                setIntentLabels(Array.isArray(debug.intentLabels) ? debug.intentLabels : []);
                setSelectedAgent(debug.selectedAgent || null);
                plannerAgentsRef.current = (aiPlan?.plannerAgents || extractPlannerAgents(aiPlan.rawPlan)) || null;
                plannerAgentStatusRef.current = debug.plannerAgentStatus || {};
                agentInputsRef.current = debug.agentInputs || {};
                agentDraftsRef.current = debug.agentDrafts || {};
                agentOrderRef.current = Array.isArray(debug.agentOrder) ? debug.agentOrder : [];
                intentLabelsRef.current = Array.isArray(debug.intentLabels) ? debug.intentLabels : [];
                selectedAgentRef.current = debug.selectedAgent || null;
                setPlannerLiveDebug(debug);
            } else {
                // Keep currently streamed debug state when plan payload lacks plannerDebug.
                plannerAgentsRef.current = (aiPlan?.plannerAgents || extractPlannerAgents(aiPlan.rawPlan)) || plannerAgentsRef.current || null;
            }
        }

        if ((!aiPlan?.rawPlan && !userPlan?.rawPlan) || !query || !schemaTimestamp) return;
        if ((aiPlan as any)?.plannerDebug || (userPlan as any)?.plannerDebug) return;
        try {
            const raw = localStorage.getItem(PLANNER_DEBUG_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const key = `${query}::${schemaTimestamp || ''}`;
            const cached = (() => {
                if (parsed && typeof parsed === 'object' && parsed.version === PLANNER_DEBUG_STORAGE_VERSION && parsed.entries) {
                    return parsed.entries[key] || parsed.entries[parsed.latestKey] || null;
                }
                if (parsed && typeof parsed === 'object' && parsed.query) {
                    return parsed;
                }
                return null;
            })();
            if (!cached) return;
            if (cached?.query !== query || cached?.schemaTimestamp !== schemaTimestamp) return;
            const debug = cached?.plannerDebug as PlannerDebugPayload | undefined;
            if (!debug) return;
            setPlannerAgents(cached?.plannerAgents || plannerAgents || null);
            setPlannerAgentStatus(debug.plannerAgentStatus || {});
            setAgentInputs(debug.agentInputs || {});
            setAgentStreams(debug.agentStreams || {});
            setAgentDrafts(debug.agentDrafts || {});
            setAgentOrder(Array.isArray(debug.agentOrder) ? debug.agentOrder : []);
            setIntentLabels(Array.isArray(debug.intentLabels) ? debug.intentLabels : []);
            setSelectedAgent(debug.selectedAgent || null);
            plannerAgentsRef.current = (cached?.plannerAgents || plannerAgents || null);
            plannerAgentStatusRef.current = debug.plannerAgentStatus || {};
            agentInputsRef.current = debug.agentInputs || {};
            agentDraftsRef.current = debug.agentDrafts || {};
            agentOrderRef.current = Array.isArray(debug.agentOrder) ? debug.agentOrder : [];
            intentLabelsRef.current = Array.isArray(debug.intentLabels) ? debug.intentLabels : [];
            selectedAgentRef.current = debug.selectedAgent || null;
            setPlannerLiveDebug(debug);
        } catch {
            // ignore cache parse failures
        }
    }, [aiPlan, userPlan]);

    useEffect(() => {
        if (!schemaTimestamp) return;
        const aiSchemaTs = (aiPlan as any)?.schemaTimestamp;
        const userSchemaTs = (userPlan as any)?.schemaTimestamp;
        if ((aiSchemaTs && aiSchemaTs !== schemaTimestamp) || (userSchemaTs && userSchemaTs !== schemaTimestamp)) {
            setLocalPlanText('');
            setAgentStreams({});
            setAgentInputs({});
            setAgentDrafts({});
            setPlannerAgents(null);
            setPlannerAgentStatus({});
            setSelectedAgent(null);
            setAgentOrder([]);
            resetPlannerLiveDebug();
            plannerAgentsRef.current = null;
            plannerAgentStatusRef.current = {};
            agentInputsRef.current = {};
            agentDraftsRef.current = {};
            agentOrderRef.current = [];
            intentLabelsRef.current = [];
            selectedAgentRef.current = null;
            setAiPlan(null as any);
            setUserPlan(null as any);
        }
    }, [schemaTimestamp, aiPlan, userPlan, setAiPlan, setUserPlan]);

    // Auto-run planner once when entering Step 2 without an existing plan.
    // Guard with a stable key to prevent duplicate runs on remount.
    useEffect(() => {
        if (!query || !schemaData) return;
        if (aiPlan || userPlan) return;
        if (String(localPlanText || "").trim().length > 0) return;
        if (isPlanningRef.current || isProcessing) return;
        const normalizedDisabledTypes = [...(disabledWidgetTypes || [])].sort().join(',');
        const key = `${query}::${schemaTimestamp || ''}::${normalizedDisabledTypes}`;
        if (autoRunKeyRef.current === key) return;
        autoRunKeyRef.current = key;
        try {
            const previous = localStorage.getItem(PLANNER_AUTO_RUN_KEY);
            if (previous === key) return;
            localStorage.setItem(PLANNER_AUTO_RUN_KEY, key);
        } catch {
            // ignore storage failures
        }
        handlePlan();
    }, [query, schemaData, schemaTimestamp, disabledWidgetTypes, aiPlan, userPlan, isProcessing, localPlanText]);

    const handleSave = async () => {
        if (!aiPlan) return;
        const { extractDashboardTitle, parseNaturalLanguagePlan, parsePlanFilters } = await import('@/utils/plan-parser');
        const allowedTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
        (disabledWidgetTypes || []).forEach((t) => allowedTypes.delete(t));
        setUserPlan({
            ...aiPlan,
            title: extractDashboardTitle(stripEventStream(localPlanText)) || aiPlan.title,
            rawPlan: stripEventStream(localPlanText),
            widgets: parseNaturalLanguagePlan(stripEventStream(localPlanText)).filter((w: any) => allowedTypes.has(w?.type)),
            filters: parsePlanFilters(stripEventStream(localPlanText)),
            plannerAgents: aiPlan?.plannerAgents || plannerAgents,
            plannerDebug: buildPlannerDebugPayload(),
            schemaTimestamp,
            query
        });
        persistPlannerDebugToLocal(localPlanText, buildPlannerDebugPayload(), aiPlan?.title, aiPlan?.widgets);
        setIsEditing(false);
    };


    const handleReset = () => {
        if (aiPlan) {
            setLocalPlanText(aiPlan.rawPlan);
            setUserPlan(aiPlan);
            setIsEditing(false);
        }
    };

    const handleContinue = () => {
        const sourcePlan = userPlan || aiPlan;
        if (!sourcePlan) return;
        const plannerDebug = buildPlannerDebugPayload();
        const nextPlan = {
            ...sourcePlan,
            plannerAgents: (sourcePlan as any)?.plannerAgents || plannerAgentsRef.current || plannerAgents || null,
            plannerDebug,
            schemaTimestamp: (sourcePlan as any)?.schemaTimestamp || schemaTimestamp,
            query: (sourcePlan as any)?.query || query
        };

        if (userPlan) {
            setUserPlan(nextPlan);
        } else {
            setAiPlan(nextPlan);
        }
        persistPlannerDebugToLocal(localPlanText || nextPlan.rawPlan || "", plannerDebug, nextPlan.title, nextPlan.widgets);
        setStep(3);
    };

    const viewPlannerAgentStatus = Object.keys(plannerAgentStatus).length > 0
        ? plannerAgentStatus
        : (plannerLiveDebug?.plannerAgentStatus || {});
    const viewAgentInputs = Object.keys(agentInputs).length > 0
        ? agentInputs
        : (plannerLiveDebug?.agentInputs || {});
    const viewAgentStreams = Object.keys(agentStreams).length > 0
        ? agentStreams
        : (plannerLiveDebug?.agentStreams || {});
    const viewAgentDrafts = Object.keys(agentDrafts).length > 0
        ? agentDrafts
        : (plannerLiveDebug?.agentDrafts || {});
    const viewAgentOrder = agentOrder.length > 0
        ? agentOrder
        : (plannerLiveDebug?.agentOrder || []);
    const currentPlan = userPlan || aiPlan;
    const runningAgents = Object.values(viewPlannerAgentStatus).filter((status) => status === "start").length;
    const showPlan = currentPlan || localPlanText;
    const baseWidgets = aiPlan?.widgets || currentPlan?.widgets || [];
    const allowedWidgetTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
    (disabledWidgetTypes || []).forEach((t) => allowedWidgetTypes.delete(t));
    const parsedWidgetsFromPlan = (() => {
        if (!localPlanText) return null;
        try {
            const { parseNaturalLanguagePlan } = require('@/utils/plan-parser');
            return parseNaturalLanguagePlan(localPlanText);
        } catch {
            return null;
        }
    })();
    const normalizeWidgetPart = (value: unknown) => String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
    const getWidgetStableKey = (widget: any) => {
        const explicitId = String(widget?.id || "").trim();
        if (explicitId) return `id:${explicitId}`;
        const type = normalizeWidgetPart(widget?.type);
        const title = normalizeWidgetPart(widget?.title);
        const goal = normalizeWidgetPart(widget?.goal);
        const primary = normalizeWidgetPart(widget?.primaryTable);
        const uses = normalizeWidgetPart(widget?.uses);
        return `sig:${type}|${title}|${goal}|${primary}|${uses}`;
    };
    const filteredBaseWidgets = ((Array.isArray(baseWidgets) && baseWidgets.length > 0)
        ? baseWidgets
        : (Array.isArray(parsedWidgetsFromPlan) ? parsedWidgetsFromPlan : []))
        .filter((w: any) => allowedWidgetTypes.has(w?.type));
    const enabledWidgetKeys = new Set(
        (currentPlan?.widgets || [])
            .filter((w: any) => allowedWidgetTypes.has(w?.type))
            .map((w: any) => getWidgetStableKey(w))
    );
    const enabledWidgetTypeList = Array.from(allowedWidgetTypes);
    const disabledWidgetTypeList = Array.isArray(disabledWidgetTypes) ? disabledWidgetTypes : [];
    const kpiEnabled = allowedWidgetTypes.has("kpi");
    const schemaColumnTotals = (() => {
        const info = schemaData?.schemaInfo || {};
        const tables = Object.keys(info);
        const total = tables.reduce((sum, table) => sum + (Array.isArray(info?.[table]?.columns) ? info[table].columns.length : 0), 0);
        const visible = schemaData?.visibleColumns && typeof schemaData.visibleColumns === "object"
            ? tables.reduce((sum, table) => sum + (Array.isArray(schemaData?.visibleColumns?.[table]) ? schemaData.visibleColumns[table].length : 0), 0)
            : total;
        return {
            total,
            visible,
            hidden: Math.max(0, total - visible)
        };
    })();
    const filterCandidates = schemaData?.filterCandidates;
    const nonEmptyTables = (() => {
        const counts = schemaData?.tableCounts;
        if (!counts) return schemaData?.tables || [];
        return Object.entries(counts)
            .filter(([, count]) => Number(count) > 0)
            .map(([table]) => table);
    })();
    const enabledFilters = (() => {
        // Primary source: schemaData.filterableColumns — always current, updated by SchemaDiscoveryView on every toggle.
        // Never read from aiPlan/userPlan.filters here — those are cached from a previous plan run.
        const filterableColumns = (schemaData as any)?.filterableColumns as Record<string, string[]> | undefined;
        if (filterableColumns && typeof filterableColumns === 'object') {
            const schemaInfo = ((schemaData as any)?.schemaInfo || {}) as Record<string, any>;
            const items: Array<{ label: string; type: string; defaultValue?: string }> = [];
            Object.entries(filterableColumns).forEach(([tableName, cols]) => {
                if (!Array.isArray(cols)) return;
                const tableInfo = schemaInfo[tableName];
                const columns: any[] = Array.isArray(tableInfo?.columns) ? tableInfo.columns : [];
                cols.forEach((colName) => {
                    const col = columns.find((c: any) => (c?.name || c?.column_name) === colName);
                    const type = String(col?.type || col?.data_type || '').toLowerCase();
                    const isDate = /date|time|timestamp/.test(type);
                    items.push({
                        label: `${tableName}.${colName}`,
                        type: isDate ? 'date-range' : 'select',
                        defaultValue: isDate ? 'this_month' : undefined,
                    });
                });
            });
            if (items.length > 0) return items;
        }
        // Fallback: schema discovery filter candidates
        const items: Array<{ label: string; type: string; defaultValue?: string }> = [];
        const primaryDate = filterCandidates?.primaryDate;
        if (primaryDate?.table && primaryDate?.column) {
            items.push({
                label: `${primaryDate.table}.${primaryDate.column}`,
                type: 'date-range',
                defaultValue: 'this_month'
            });
        }
        (filterCandidates?.categoricalColumns || []).slice(0, 4).forEach((col: any) => {
            if (!col?.table || !col?.column) return;
            items.push({
                label: `${col.table}.${col.column}`,
                type: 'multi-select'
            });
        });
        return items;
    })();

    const scenarioCoverage = (() => {
        const match = localPlanText.match(/SCENARIO COVERAGE:\s*([\s\S]*?)(?:\nWIDGET\s+\d+:|$)/i);
        if (!match?.[1]) return [];
        return match[1]
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
    })();

    const toggleWidget = (widgetKey: string, nextEnabled: boolean) => {
        const sourcePlan = userPlan || aiPlan;
        if (!sourcePlan) return;
        const currentWidgets = (currentPlan?.widgets || []).filter((w: any) => allowedWidgetTypes.has(w?.type));
        let nextWidgets = currentWidgets;
        const currentWidgetKeySet = new Set(currentWidgets.map((w: any) => getWidgetStableKey(w)));

        if (!nextEnabled) {
            nextWidgets = currentWidgets.filter((w: any) => getWidgetStableKey(w) !== widgetKey);
        } else {
            const toAdd = filteredBaseWidgets.find((w: any) => getWidgetStableKey(w) === widgetKey);
            if (!toAdd) return;
            if (currentWidgetKeySet.has(widgetKey)) return;
            const merged = [...currentWidgets, toAdd];
            const order = filteredBaseWidgets.map((w: any) => getWidgetStableKey(w));
            merged.sort((a: any, b: any) => order.indexOf(getWidgetStableKey(a)) - order.indexOf(getWidgetStableKey(b)));
            nextWidgets = merged;
        }

        const preservedDebug = buildPlannerDebugPayload();
        setUserPlan({
            ...sourcePlan,
            widgets: nextWidgets,
            plannerAgents: (sourcePlan as any)?.plannerAgents || plannerAgentsRef.current || plannerAgents || null,
            plannerDebug: preservedDebug,
            schemaTimestamp: (sourcePlan as any)?.schemaTimestamp || schemaTimestamp,
            query: (sourcePlan as any)?.query || query
        });
        setStaleStep(3);
    };

    return (
        <div style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 20, padding: '16px 20px', borderRadius: 16, border: '1px solid #242a36', background: '#0f1218' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <Title level={2} style={{ margin: 0 }}>
                        <BulbOutlined style={{ marginRight: 12 }} />
                        Dashboard Blueprint
                    </Title>
                    <div style={{ marginTop: 8 }}>
                        <Text type="secondary">Review the plan, adjust KPIs, then continue</Text>
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                        <Tag color="blue">Step 2 of 5</Tag>
                        {isProcessing && <Tag color="geekblue">Streaming...</Tag>}
                        {isProcessing && runningAgents > 0 && <Tag color="blue">Agents running: {runningAgents}</Tag>}
                        {intentLabels.length > 0 && <Tag color="cyan">Intent: {intentLabels.join(", ")}</Tag>}
                        <Tag color={kpiEnabled ? "green" : "red"}>{kpiEnabled ? "KPI enabled" : "KPI disabled"}</Tag>
                    </div>
                    <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                        {query && <Tag color="blue">Prompt: {query}</Tag>}
                        {schemaData?.tables && <Tag color="geekblue">Tables: {nonEmptyTables.length}</Tag>}
                        {schemaData?.schemaInfo && <Tag color="geekblue">Columns: {schemaColumnTotals.visible}/{schemaColumnTotals.total} visible</Tag>}
                        {schemaTimestamp && <Tag color="default">Schema: {new Date(schemaTimestamp).toLocaleString()}</Tag>}
                    </div>
                    {plannerAgents && (
                        <div style={{ marginTop: 10 }}>
                            <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>Planner Agents</Text>
                            <Tag color="purple" style={{ whiteSpace: 'normal', lineHeight: '18px', maxWidth: '100%' }}>
                                {plannerAgents}
                            </Tag>
                        </div>
                    )}
                </div>
                <Space>
                    <Button
                        icon={<ReloadOutlined />}
                        onClick={handlePlan}
                        loading={isProcessing}
                        disabled={!query}
                    >
                        {isProcessing ? 'Generating...' : 'Rerun Planner'}
                    </Button>
                    <Button
                        type="primary"
                        icon={<ArrowRightOutlined />}
                        onClick={handleContinue}
                        disabled={!currentPlan || isProcessing || !query}
                    >
                        Continue
                    </Button>
                </Space>
            </div>

            {isProcessing && !localPlanText && Object.keys(viewPlannerAgentStatus).length === 0 && (
                <Alert
                    type="info"
                    showIcon
                    description="Planning your dashboard — analyzing schema, inferring domain, and generating widgets. Agent streams will appear below."
                    style={{ marginBottom: 16, background: 'rgba(19,91,236,0.08)', border: '1px solid rgba(19,91,236,0.25)' }}
                />
            )}

            {
                error && (
                    <Alert
                        title={<span style={{ color: '#fff' }}>Planning Error</span>}
                        description={<span style={{ color: 'rgba(255, 255, 255, 0.7)' }}>{error}</span>}
                        type="error"
                        showIcon
                        style={{ marginBottom: 24, background: 'rgba(245, 34, 45, 0.1)', border: '1px solid rgba(245, 34, 45, 0.3)' }}
                    />
                )
            }

            {
                !query && (
                    <Card style={{ background: '#0f1218', border: '1px solid #242a36', padding: '40px 0', textAlign: 'center', marginBottom: 24 }}>
                        <BulbOutlined style={{ fontSize: 48, color: '#135bec', marginBottom: 24 }} />
                        <Title level={3}>Waiting for a prompt</Title>
                        <Paragraph type="secondary">
                            Enter a query in the chat board or discovery notes to help the AI understand what kind of dashboard you want to build.
                        </Paragraph>
                    </Card>
                )
            }

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 350px', gap: 24 }}>
                {/* Main Plan Area */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {(isProcessing || Object.keys(viewAgentInputs).length > 0 || Object.keys(viewAgentStreams).length > 0 || Object.keys(viewAgentDrafts).length > 0 || Object.keys(viewPlannerAgentStatus).length > 0) && (
                        <Card title="Agent Streams" size="small">
                            {Array.from(new Set([
                                ...viewAgentOrder,
                                ...Object.keys(viewPlannerAgentStatus || {}),
                                ...Object.keys(viewAgentInputs || {}),
                                ...Object.keys(viewAgentStreams || {}),
                                ...Object.keys(viewAgentDrafts || {})
                            ])).length === 0 ? (
                                <Text type="secondary">Waiting for agent streams...</Text>
                            ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                        {Array.from(new Set([
                                            ...viewAgentOrder,
                                            ...Object.keys(viewPlannerAgentStatus || {}),
                                            ...Object.keys(viewAgentInputs || {}),
                                            ...Object.keys(viewAgentStreams || {}),
                                            ...Object.keys(viewAgentDrafts || {})
                                        ])).map((agent) => (
                                            <Button
                                                key={agent}
                                                size="small"
                                                type={selectedAgent === agent ? "primary" : "default"}
                                                onClick={() => setSelectedAgent(agent)}
                                            >
                                                {agent}
                                            </Button>
                                        ))}
                                    </div>
                                    {selectedAgent && (
                                        <div style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: 12 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                                                <Text strong>{selectedAgent}</Text>
                                                {viewPlannerAgentStatus?.[selectedAgent] && (
                                                    <Tag color={viewPlannerAgentStatus[selectedAgent] === 'done' ? 'green' : viewPlannerAgentStatus[selectedAgent] === 'error' ? 'red' : 'blue'}>
                                                        {viewPlannerAgentStatus[selectedAgent] === 'start' ? 'running' : viewPlannerAgentStatus[selectedAgent]}
                                                    </Tag>
                                                )}
                                            </div>
                                            <Text type="secondary">Input context</Text>
                                            <TextArea
                                                value={viewAgentInputs?.[selectedAgent] || ""}
                                                autoSize={{ minRows: 3, maxRows: 8 }}
                                                style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 6 }}
                                                readOnly
                                            />
                                            <Text type="secondary">Raw token stream</Text>
                                            <TextArea
                                                value={viewAgentStreams?.[selectedAgent] || viewAgentDrafts?.[selectedAgent] || ""}
                                                autoSize={{ minRows: 3, maxRows: 8 }}
                                                style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 6 }}
                                                readOnly
                                            />
                                            {viewAgentDrafts?.[selectedAgent] && (
                                                <div style={{ marginTop: 10 }}>
                                                    <Text type="secondary">Pre-compile draft</Text>
                                                    <TextArea
                                                        value={viewAgentDrafts[selectedAgent]}
                                                        autoSize={{ minRows: 3, maxRows: 10 }}
                                                        style={{ fontFamily: 'var(--font-mono)', fontSize: 12, marginTop: 6 }}
                                                        readOnly
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )}
                        </Card>
                    )}
                    {showPlan && (
                        <Card
                            title={
                                <Space>
                                    <span>Strategic Narrative</span>
                                    {userPlan && userPlan.rawPlan !== aiPlan?.rawPlan && <Tag color="orange">Edited</Tag>}
                                </Space>
                            }
                            extra={
                                <Space>
                                    {isEditing ? (
                                        <>
                                            <Button size="small" icon={<RollbackOutlined />} onClick={handleReset}>Reset</Button>
                                            <Button size="small" type="primary" icon={<SaveOutlined />} onClick={handleSave}>Save</Button>
                                        </>
                                    ) : (
                                        <Button size="small" icon={<EditOutlined />} onClick={() => setIsEditing(true)}>Edit Plan</Button>
                                    )}
                                </Space>
                            }
                        >
                            {isEditing ? (
                                <TextArea
                                    value={localPlanText}
                                    onChange={(e) => setLocalPlanText(e.target.value)}
                                    autoSize={{ minRows: 15, maxRows: 30 }}
                                    style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
                                />
                            ) : (
                                <Paragraph style={{ whiteSpace: 'pre-wrap', fontSize: 15, lineHeight: 1.6 }}>
                                    {localPlanText}
                                </Paragraph>
                            )}
                        </Card>
                    )}
                </div>

                {/* Sidebar: Structured Widgets Preview */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {Object.keys(viewPlannerAgentStatus).length > 0 && (
                        <Card title="Planner Agents" size="small">
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {Object.entries(viewPlannerAgentStatus).map(([agent, status]) => (
                                    <div key={agent} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                        <Text>{agent}</Text>
                                        <Tag color={status === 'done' ? 'green' : status === 'error' ? 'red' : 'blue'}>
                                            {status === 'start' ? 'running' : status}
                                        </Tag>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}
                    {showPlan && (
                        <>
                            <Card title="Planner Constraints" size="small">
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <Text>KPI status</Text>
                                        <Tag color={kpiEnabled ? "green" : "red"}>{kpiEnabled ? "Enabled" : "Disabled"}</Tag>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <Text>Enabled widget types</Text>
                                        <Tag color="blue">{enabledWidgetTypeList.length}</Tag>
                                    </div>
                                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                        {enabledWidgetTypeList.map((type) => <Tag key={`enabled-${type}`} color="green">{type}</Tag>)}
                                    </div>
                                    {disabledWidgetTypeList.length > 0 && (
                                        <>
                                            <Text type="secondary">Disabled widget types</Text>
                                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                                {disabledWidgetTypeList.map((type) => <Tag key={`disabled-${type}`}>{type}</Tag>)}
                                            </div>
                                        </>
                                    )}
                                    <Divider style={{ margin: '8px 0' }} />
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <Text>Schema columns</Text>
                                        <Tag color="geekblue">{schemaColumnTotals.visible}/{schemaColumnTotals.total} visible</Tag>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                        <Text type="secondary">Hidden columns</Text>
                                        <Text type="secondary">{schemaColumnTotals.hidden}</Text>
                                    </div>
                                </div>
                            </Card>

                            <Card title="Widgets Overview" size="small">
                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                    {filteredBaseWidgets.map((widget: any, index: number) => {
                                        const widgetKey = getWidgetStableKey(widget);
                                        return (
                                        <div key={widgetKey} style={{
                                            borderBottom: index < filteredBaseWidgets.length - 1 ? '1px solid rgba(255, 255, 255, 0.08)' : 'none',
                                            padding: '12px 0'
                                        }}>
                                            <div style={{ width: '100%' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                                    <Text strong>{widget.title}</Text>
                                                    <Space size={8}>
                                                        <Tag color="cyan">{widget.type}</Tag>
                                                        <Switch
                                                            size="small"
                                                            checked={enabledWidgetKeys.has(widgetKey)}
                                                            onChange={(checked) => toggleWidget(widgetKey, checked)}
                                                            disabled={!allowedWidgetTypes.has(widget?.type)}
                                                        />
                                                    </Space>
                                                </div>
                                                <Text type="secondary" style={{ fontSize: 12 }}>
                                                    {widget.goal}
                                                </Text>
                                            </div>
                                        </div>
                                    )})}
                                </div>
                            </Card>

                            {todoListState && (
                                <Card title="Dynamic TODO List" size="small">
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                                        <Tag>Pending: {todoListState.summary.byStatus.pending || 0}</Tag>
                                        <Tag color="processing">Running: {todoListState.summary.byStatus.running || 0}</Tag>
                                        <Tag color="success">Done: {todoListState.summary.byStatus.done || 0}</Tag>
                                        <Tag color="error">Blocked/Failed: {(todoListState.summary.byStatus.blocked || 0) + (todoListState.summary.byStatus.failed || 0)}</Tag>
                                    </div>
                                    {(["widget", "column", "filter", "agent", "sql"] as const).map((domain) => {
                                        const items = (todoListState.items || []).filter((item) => item.domain === domain);
                                        if (items.length === 0) return null;
                                        return (
                                            <div key={`todo-domain-${domain}`} style={{ marginBottom: 10 }}>
                                                <Text type="secondary" style={{ textTransform: 'uppercase', fontSize: 11 }}>{domain}</Text>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                                                    {items.slice(0, 18).map((item) => (
                                                        <div key={item.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                                            <Tooltip title={item.reason || item.suggestedFix || item.scopeId}>
                                                                <Text ellipsis style={{ maxWidth: 220 }}>{item.title}</Text>
                                                            </Tooltip>
                                                            <Tag color={item.status === "done" ? "green" : item.status === "running" ? "blue" : item.status === "blocked" || item.status === "failed" ? "red" : "default"}>
                                                                {item.status}
                                                            </Tag>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </Card>
                            )}

                            {scenarioCoverage.length > 0 && (
                                <Card title="Scenario Coverage" size="small">
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                        {scenarioCoverage.map((line, idx) => (
                                            <Text key={`${line}-${idx}`} type="secondary" style={{ fontSize: 12 }}>
                                                {line}
                                            </Text>
                                        ))}
                                    </div>
                                </Card>
                            )}

                            <Card title="Enabled Filters" size="small">
                                {enabledFilters.length > 0 ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                        {enabledFilters.map((filter, idx) => (
                                            <div key={`${filter.label}-${idx}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                                                <Text>{filter.label}</Text>
                                                <Space size={4}>
                                                    <Tag color="blue">{filter.type}</Tag>
                                                    {filter.defaultValue && <Tag color="geekblue">{filter.defaultValue}</Tag>}
                                                </Space>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <Text type="secondary">No filters enabled in schema discovery.</Text>
                                )}
                            </Card>

                            <Alert
                                title="Plan dependency"
                                description="Modifying the text plan above will be used as context for the SQL generation step."
                                type="info"
                                showIcon
                            />
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

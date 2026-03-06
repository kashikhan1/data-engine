"use client";

import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Send, Sparkles, Lightbulb, History, X, ChevronLeft, ChevronDown, ChevronUp, LayoutDashboard, MessageSquare, FileBarChart, Database, Table2, AlertCircle, CheckCircle2, FileText, TrendingUp, ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useRunStore, useDashboardStore, useConfigStore, useWorkflowStore, useUIStore } from "@/state/stores";
import { runQueryExecutor, assembleFinalDashboard, runNarrativeGenerator, repairFailedQuery } from "@/modules/sql/agent";
import { runSchemaDiscovery } from "@/modules/schema/agent";
import { buildExecutionContext as buildSharedExecutionContext } from "@/lib/execution-context";
import { getPaginationForId } from "@/lib/pagination";
import { AgentTimeline } from "./AgentTimeline";
import styles from "./Chat.module.css";

type ChatMode = 'dashboard' | 'chat' | 'report';

interface Message {
    id: string;
    type: "user" | "ai" | "system" | "error";
    content: string;
    timestamp: string;
    qaResult?: QAResult | null;
    reportResult?: ReportResult | null;
}

interface QAResult {
    sql: string;
    data: any[];
    columns: string[];
    rowCount: number;
    repaired?: boolean;
    error?: string;
    narrative?: string;
}

interface ReportSection {
    id: string;
    title: string;
    description: string;
    sql: string;
    data: any[];
    columns: string[];
    rowCount: number;
    error?: string;
    narrative?: string;
}

interface ReportResult {
    title: string;
    summary: string;
    insights: string[];
    recommendation: string;
    sections: ReportSection[];
    generatedAt: string;
    question: string;
}

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
const PLANNER_DEBUG_STORAGE_KEY = "planner_debug_outputs_v1";
const PLANNER_DEBUG_STORAGE_VERSION = 2;

type PipelineStage = "schema" | "plan" | "sql" | "execute" | "dashboard";

const SUGGESTION_CHIPS: Record<ChatMode, string[]> = {
    dashboard: [
        "Show revenue by country for last month",
        "Weekly active users trend",
        "Top 10 products by sales",
        "Customer retention cohort analysis",
        "Compare Q3 vs Q4 revenue",
    ],
    chat: [
        "How many orders placed today?",
        "Top 5 customers by revenue this month",
        "Which products have low stock right now?",
        "Average order value per category",
        "List the 10 most recent transactions",
        "How many new customers signed up this week?",
        "What is the total revenue for this month so far?",
        "Which categories had the most returns?",
    ],
    report: [
        "Monthly sales performance report",
        "Customer acquisition and churn analysis",
        "Inventory health and stock-out risks",
        "Revenue breakdown by region and product",
        "Top customers by lifetime value",
        "Sales rep performance summary this quarter",
        "Product profitability and margin analysis",
        "Weekly order volume and fulfillment trends",
    ],
};

const MODE_CONFIG: Record<ChatMode, { label: string; icon: any; description: string; color: string }> = {
    dashboard: {
        label: "Dashboard",
        icon: LayoutDashboard,
        description: "Create interactive visual dashboards",
        color: "#3b82f6"
    },
    chat: {
        label: "Chat",
        icon: MessageSquare,
        description: "Ask questions and get instant results",
        color: "#10b981"
    },
    report: {
        label: "Report",
        icon: FileBarChart,
        description: "Generate comprehensive data reports",
        color: "#8b5cf6"
    },
};

interface ChatPanelProps {
    onCollapse?: () => void;
}

const ensurePlanWidgets = (widgets: any[] | undefined, schemaLike: any): any[] => {
    if (Array.isArray(widgets) && widgets.length > 0) return widgets;
    const schemaInfo = schemaLike?.schemaInfo || {};
    const firstTable = Object.keys(schemaInfo)[0] || "unknown_table";
    return [
        {
            id: "w1",
            type: "kpi",
            title: "Total Records",
            goal: "COUNT(*)",
            primaryTable: firstTable,
            requiredTables: [firstTable],
            uses: `${firstTable}.*`,
        },
        {
            id: "w2",
            type: "table",
            title: "Sample Rows",
            goal: "Inspect detailed rows",
            primaryTable: firstTable,
            requiredTables: [firstTable],
            uses: `${firstTable}.*`,
        }
    ];
};

export function ChatPanel({ onCollapse }: ChatPanelProps) {
    const [input, setInput] = useState("");
    const [chatMode, setChatMode] = useState<ChatMode>('dashboard');
    const [messages, setMessages] = useState<Message[]>([
        {
            id: "welcome",
            type: "ai",
            content: "Hello! I'm your AI Data Analyst. Choose a mode and ask me anything about your data.",
            timestamp: new Date().toISOString(),
        },
    ]);
    const [qaLoading, setQaLoading] = useState(false);
    const [reportLoading, setReportLoading] = useState(false);
    const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
    const [showSuggestions, setShowSuggestions] = useState(true);
    const [showHistory, setShowHistory] = useState(false);
    const [awaitingSqlContinue, setAwaitingSqlContinue] = useState(false);
    const [awaitingExecutionApprove, setAwaitingExecutionApprove] = useState(false);
    const [followUpSuggestions, setFollowUpSuggestions] = useState<string[]>([]);

    const inputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const { isStreaming, steps, error: runError, startRun, handleEvent, endRun } = useRunStore();
    const { recentQueries, addToRecentQueries, activeFilters, filtersActivated, setDashboard, dashboard } = useDashboardStore();
    const {
        schemaData,
        query: workflowQuery,
        userSchemaNotes,
        userPlan,
        aiPlan,
        userQueries,
        aiQueries,
        executionResults,
        dashboardConfig,
        setSchemaData,
        setQuery,
        setStep,
        setAiPlan,
        setUserPlan,
        setAiQueries,
        setUserQueries,
        setExecutionResults,
        setDashboardConfig,
        setProcessing,
        isProcessing,
        currentStep,
        staleStep,
        setError,
        setStaleStep,
        addSqlError,
        sqlErrorLog,
        todoListState,
        initTodoList,
        applyTodoItemUpdate,
        setTodoSummary,
        resetTodoList,
        setPlannerLiveDebug,
        resetPlannerLiveDebug,
    } = useWorkflowStore();
    const { setCurrentView } = useUIStore();

    // Auto-scroll to bottom
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [messages, steps]);

    // Handle run error
    useEffect(() => {
        if (runError) {
            setMessages(prev => [...prev, {
                id: `error-${Date.now()}`,
                type: "error",
                content: runError,
                timestamp: new Date().toISOString(),
            }]);
        }
    }, [runError]);

    const { projectContext, postgresUrl, dataSources, selectedDataSourceId, setSelectedDataSourceId, setPostgresUrl, disabledWidgetTypes } = useConfigStore();
    const [isPipelineRunning, setIsPipelineRunning] = useState(false);
    const [showPipelineOutput, setShowPipelineOutput] = useState(true);
    const [activeOutputTab, setActiveOutputTab] = useState<'schema' | 'plan' | 'sql' | 'execute' | 'dashboard'>('schema');
    const [isEditingPlan, setIsEditingPlan] = useState(false);
    const [planDraft, setPlanDraft] = useState('');
    const [sqlDrafts, setSqlDrafts] = useState<Record<string, string>>({});
    const [showConnectorPicker, setShowConnectorPicker] = useState(true);
    const [, setPipelineLogs] = useState<string[]>([]);
    const [pipelineStageLogs, setPipelineStageLogs] = useState<{
        schema: string[];
        plan: string[];
        sql: string[];
        execute: string[];
        dashboard: string[];
    }>({ schema: [], plan: [], sql: [], execute: [], dashboard: [] });
    const [showLivePanel, setShowLivePanel] = useState(true);
    const autoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const autoRefreshInFlightRef = useRef(false);
    const appendPipelineStageLog = useCallback((stage: PipelineStage, line: string) => {
        setPipelineStageLogs((prev) => ({
            ...prev,
            [stage]: [...prev[stage].slice(-99), line]
        }));
    }, []);
    const appendPipelineLog = useCallback((stage: PipelineStage, line: string) => {
        setPipelineLogs((prev) => [...prev.slice(-199), line]);
        appendPipelineStageLog(stage, line);
    }, [appendPipelineStageLog]);
    const connectors = (dataSources || []).filter((ds) => {
        const type = String(ds?.type || "").toLowerCase();
        const isSqlType = type.includes("mcp") || type.includes("postgres") || type.includes("mssql") || type.includes("sql");
        if (!isSqlType) return false;
        const status = String(ds?.status || "").toLowerCase();
        const hasConnection = Boolean(String(ds?.connectionString || "").trim());
        return status === "connected" && hasConnection;
    });
    // Always prefer the explicitly-selected data source by ID, regardless of health-check status.
    // This prevents a transient "Error" health status from falling back to the wrong database.
    const selectedDataSourceById = (dataSources || []).find(
        (ds) => ds.id === selectedDataSourceId && Boolean(String(ds?.connectionString || "").trim())
    ) || null;
    const selectedConnector = selectedDataSourceById || connectors.find((ds) => ds.id === selectedDataSourceId) || connectors[0] || null;
    const resolvedConnectionString = selectedConnector?.connectionString || postgresUrl || schemaData?.connectionString || undefined;
    const resolvedConnectorType = selectedConnector?.type || schemaData?.connectorType || "";
    const resolvedConnectorInstructions = selectedConnector?.instructions || schemaData?.connectorInstructions || "";
    const hasConnectedSqlSource = useMemo(() => {
        const candidates = selectedConnector ? [selectedConnector] : connectors;
        const connected = candidates.some((ds) => {
            const type = String(ds?.type || "").toLowerCase();
            const isSql = type.includes("postgres") || type.includes("mssql") || type.includes("sql");
            const status = String(ds?.status || "").toLowerCase();
            return isSql && status === "connected" && Boolean(ds?.connectionString);
        });
        return connected || Boolean(resolvedConnectionString);
    }, [connectors, selectedConnector, resolvedConnectionString]);

    const handleSelectConnector = (ds: any) => {
        setSelectedDataSourceId(ds.id);
        if (ds.connectionString) {
            setPostgresUrl(ds.connectionString);
        }
    };
    useEffect(() => {
        if (!selectedDataSourceId && connectors.length > 0) {
            setSelectedDataSourceId(connectors[0].id);
            if (connectors[0].connectionString && !postgresUrl) {
                setPostgresUrl(connectors[0].connectionString);
            }
        }
    }, [connectors, postgresUrl, selectedDataSourceId, setPostgresUrl, setSelectedDataSourceId]);

    const buildPaginationConfigForId = (id: string) => {
        return getPaginationForId(Object.fromEntries(activeFilters), id, {
            includeTotal: true,
            allowGlobalFallback: true
        });
    };

    const buildExecutionContext = (planFilters: any[] = [], planWidgets: any[] = []) => {
        return buildSharedExecutionContext({
            planFilters,
            activeFilters,
            candidateWidgets: getExecutionWidgets(planWidgets),
            includeTotal: true,
            allowGlobalFallback: true
        });
    };
    const persistPlannerDebugToLocal = (input: {
        query: string;
        schemaTimestamp?: string | null;
        title?: string;
        rawPlan?: string;
        widgets?: any[];
        plannerDebug?: PlannerDebugPayload;
        plannerAgents?: string | null;
    }) => {
        try {
            if (!input?.query) return;
            const schemaKey = String(input.schemaTimestamp || schemaData?.schemaTimestamp || "");
            const entryKey = `${input.query}::${schemaKey}`;
            const payload = {
                query: input.query,
                schemaTimestamp: schemaKey || null,
                title: input.title || "AI Analytics Dashboard",
                rawPlan: String(input.rawPlan || ""),
                widgets: Array.isArray(input.widgets) ? input.widgets : [],
                plannerAgents: input.plannerAgents || null,
                plannerDebug: input.plannerDebug || null,
                savedAt: new Date().toISOString()
            };
            const raw = localStorage.getItem(PLANNER_DEBUG_STORAGE_KEY);
            let nextStore: any = {
                version: PLANNER_DEBUG_STORAGE_VERSION,
                latestKey: entryKey,
                entries: {}
            };
            if (raw) {
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === "object" && parsed.version === PLANNER_DEBUG_STORAGE_VERSION && parsed.entries) {
                        nextStore = {
                            version: PLANNER_DEBUG_STORAGE_VERSION,
                            latestKey: parsed.latestKey || entryKey,
                            entries: { ...parsed.entries }
                        };
                    } else if (parsed && typeof parsed === "object" && parsed.query) {
                        const legacyKey = `${String(parsed.query)}::${String(parsed.schemaTimestamp || "")}`;
                        nextStore.entries[legacyKey] = parsed;
                    }
                } catch {
                    // ignore parse issues and overwrite with fresh structure
                }
            }
            nextStore.latestKey = entryKey;
            nextStore.entries[entryKey] = payload;
            localStorage.setItem(PLANNER_DEBUG_STORAGE_KEY, JSON.stringify(nextStore));
        } catch {
            // ignore localStorage failures
        }
    };

    const getExecutionWidgets = (fallback: any[] = []) => {
        const dashboardWidgets = dashboard?.widgets || [];
        if (dashboardWidgets.length > 0) return dashboardWidgets;
        const workflowWidgets = dashboardConfig?.widgets || [];
        if (workflowWidgets.length > 0) return workflowWidgets;
        return fallback;
    };

    const loadManualSchema = () => {
        try {
            const raw = localStorage.getItem('selected_schema');
            if (!raw) return null;
            const payload = JSON.parse(raw);
            const manualSchema = payload?.schemaData || payload;
            if (!manualSchema || typeof manualSchema !== 'object') return null;

            const schemaInfo: Record<string, any> = {};
            const sampleData: Record<string, any[]> = {};
            const relationships: any[] = [];
            const tableCounts: Record<string, number> = payload?.tableCounts || {};
            const tables = Object.keys(manualSchema || {});

            tables.forEach((tableName) => {
                const entry = manualSchema[tableName];
                const columns = Array.isArray(entry?.columns?.columns)
                    ? entry.columns.columns
                    : Array.isArray(entry?.columns)
                        ? entry.columns
                        : [];
                schemaInfo[tableName] = {
                    columns: columns.map((col: any) => ({
                        ...col,
                        name: col.name || col.column_name,
                        type: col.type || col.data_type
                    })),
                    primaryKeys: entry?.columns?.primaryKeys || entry?.primaryKeys || [],
                    foreignKeys: entry?.columns?.foreignKeys || entry?.foreignKeys || []
                };
                sampleData[tableName] = Array.isArray(entry?.sampleRows) ? entry.sampleRows : [];
                if (tableCounts[tableName] === undefined) {
                    tableCounts[tableName] = sampleData[tableName].length;
                }

                (schemaInfo[tableName].foreignKeys || []).forEach((fk: any) => {
                    if (!fk?.foreign_table_name || !fk?.foreign_column_name) return;
                    relationships.push({
                        from: { table: tableName, column: fk.column_name },
                        to: { table: fk.foreign_table_name, column: fk.foreign_column_name },
                        type: "many-to-one"
                    });
                });
            });

            return {
                tables,
                schemaInfo,
                sampleData,
                tableCounts,
                relationships,
                connectionString: resolvedConnectionString,
                filterCandidates: null,
                rawAnalysis: "Loaded schema from local selection.",
                filterSummary: "",
                projectContext
            };
        } catch {
            return null;
        }
    };

    const runSequentialPipeline = async (query: string) => {
        const runId = `local_${Date.now()}`;
        startRun(runId);
        setAwaitingSqlContinue(false);
        setPipelineLogs([]);
        setPipelineStageLogs({ schema: [], plan: [], sql: [], execute: [], dashboard: [] });
        resetTodoList();
        setDashboardConfig(null);
        setDashboard(null);
        setIsPipelineRunning(true);
        setProcessing(true);
        setError(null);
        setStaleStep(null);

        // IMPORTANT: Do NOT reset schema if it exists. We only want to clear the plan and downstream.
        // resetWorkflow(); // This was clearing schemaData which is bad if we are just re-planning.

        // Manually reset downstream state instead of full reset
        setAiPlan(null as any);
        setUserPlan(null as any);
        setAiQueries(null as any);
        setUserQueries(null as any);
        setExecutionResults(null as any);
        setDashboardConfig(null);

        setCurrentView('build');
        setQuery(query);
        setStep(1);

        const sendStep = (step: any, status: any, message?: string) => {
            const ts = new Date().toISOString();
            const stageLabel =
                step === "schema" || step === "kpi" ? "Schema"
                    : step === "plan" ? "Planner"
                        : step === "sql" ? "SQL Engineer"
                            : step === "execute" ? "Executor"
                                : (step === "viz" || step === "narrative") ? "Dashboard"
                                    : String(step);
            const statusLabel =
                status === "running" ? "Running"
                    : status === "done" ? "Done"
                        : status === "error" ? "Error"
                            : String(status);
            handleEvent({
                type: "step",
                step,
                status,
                message,
                ts
            } as any);
            if (message) {
                handleEvent({
                    type: "log",
                    step,
                    message,
                    ts
                } as any);
                setPipelineLogs((prev) => [...prev.slice(-199), `${stageLabel}: ${statusLabel} - ${message}`]);
                const stage =
                    (step === "schema" || step === "kpi") ? "schema"
                        : step === "plan" ? "plan"
                        : step === "sql" ? "sql"
                        : step === "execute" ? "execute"
                            : (step === "viz" || step === "narrative") ? "dashboard"
                                : null;
                if (stage) {
                    setPipelineStageLogs((prev) => ({
                        ...prev,
                        [stage]: [...prev[stage as PipelineStage].slice(-99), `${statusLabel}: ${message}`]
                    }));
                }
            }
        };

        try {
            // Step 1: Schema discovery
            sendStep("schema", "running", "Schema discovery");
            let resolvedSchema = schemaData;
            if (resolvedSchema && resolvedConnectionString) {
                const cachedConn = String((resolvedSchema as any)?.connectionString || "").trim();
                const activeConn = String(resolvedConnectionString || "").trim();
                if (cachedConn && activeConn && cachedConn !== activeConn) {
                    resolvedSchema = null;
                } else {
                    // Also invalidate if selected-tables filter changed
                    const storedTablesRaw = localStorage.getItem('schema_selected_tables');
                    const selectedTables: string[] = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
                    if (selectedTables.length > 0) {
                        const cachedTables: string[] = Array.isArray((resolvedSchema as any)?.tables)
                            ? (resolvedSchema as any).tables
                            : Object.keys((resolvedSchema as any)?.schemaInfo || {});
                        const sel = [...selectedTables].map(t => t.toLowerCase()).sort().join(',');
                        const cached = [...cachedTables].map(t => t.toLowerCase()).sort().join(',');
                        if (sel !== cached) resolvedSchema = null;
                    }
                }
            }
            if (!resolvedSchema) {
                const tryDiscover = async (attempts: number) => {
                    let lastError: any = null;
                    for (let i = 0; i < attempts; i++) {
                        try {
                            const storedTablesRaw = localStorage.getItem('schema_selected_tables');
                            const allowedTables = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
                            if (!resolvedConnectionString) continue;
                            const data = await runSchemaDiscovery(
                                resolvedConnectionString,
                                {
                                    enableSemanticSearch: true,
                                    enableTableKpis: true,
                                    enableTableMatrix: true,
                                    enableTableFilters: true,
                                    projectContext
                                },
                                allowedTables.length > 0 ? allowedTables : undefined
                            );
                            if (data?.tables && data.tables.length > 0) return data;
                            lastError = new Error("Schema discovery returned no tables.");
                        } catch (err: any) {
                            lastError = err;
                        }
                    }
                    throw lastError || new Error("Schema discovery failed.");
                };
                try {
                    resolvedSchema = await tryDiscover(3);
                } catch {
                    resolvedSchema = loadManualSchema();
                }
            }
            if (!resolvedSchema || !resolvedSchema.tables || resolvedSchema.tables.length === 0) {
                throw new Error("No schema selected or found.");
            }
            setSchemaData(resolvedSchema);
            sendStep("schema", "done", "Schema ready");

            sendStep("kpi", "running", "KPI profiling");
            sendStep("kpi", "done", "KPI ready");

            // Step 2: Plan
            setStep(2);
            resetPlannerLiveDebug();
            sendStep("plan", "running", "Planning dashboard");
            setActiveOutputTab('plan');
            setShowPipelineOutput(true);
            const planResponse = await fetch('/api/plan/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query,
                    schema: {
                        ...resolvedSchema,
                        userSchemaNotes,
                        disabledWidgetTypes,
                        connectorInstructions: resolvedConnectorInstructions,
                        connectorType: resolvedConnectorType,
                        connectionString: resolvedConnectionString
                    },
                    connectorInstructions: resolvedConnectorInstructions,
                    connectorType: resolvedConnectorType,
                    connectionString: resolvedConnectionString
                })
            });
            if (!planResponse.ok || !planResponse.body) {
                throw new Error("Planner connection failed.");
            }
            const planReader = planResponse.body.getReader();
            const planDecoder = new TextDecoder();
            let planBuffer = '';
            let planText = '';
            let plannerAgents: string | null = null;
            const plannerAgentStatus: Record<string, "start" | "done" | "error"> = {};
            const agentInputs: Record<string, string> = {};
            const agentStreams: Record<string, string> = {};
            const agentDrafts: Record<string, string> = {};
            const agentOrder: string[] = [];
            const intentLabels: string[] = [];
            let selectedAgent: string | null = null;
            const pushPlannerLiveDebug = () => {
                setPlannerLiveDebug({
                    plannerAgents,
                    plannerAgentStatus: { ...plannerAgentStatus },
                    agentInputs: { ...agentInputs },
                    agentStreams: { ...agentStreams },
                    agentDrafts: { ...agentDrafts },
                    agentOrder: [...agentOrder],
                    intentLabels: [...intentLabels],
                    selectedAgent
                });
            };
            while (true) {
                const { done, value } = await planReader.read();
                if (done) break;
                planBuffer += planDecoder.decode(value, { stream: true });
                const lines = planBuffer.split('\n');
                planBuffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data: ')) continue;
                    try {
                        const data = JSON.parse(trimmed.substring(6));
                        if ((data?.kind === 'chunk' || (!data?.kind && data.chunk)) && data.chunk) {
                            planText += data.chunk;
                            if (!plannerAgents && planText.includes("EVENT_STREAM:")) {
                                const marker = "EVENT_STREAM:";
                                const idx = planText.indexOf(marker);
                                if (idx !== -1) {
                                    const payload = planText.slice(idx + marker.length);
                                    const eventLines = payload.split('\n');
                                    for (const eventLine of eventLines) {
                                        const eventTrimmed = eventLine.trim();
                                        if (!eventTrimmed.startsWith('{')) continue;
                                        try {
                                            const evt = JSON.parse(eventTrimmed);
                                            if (evt?.type === 'planner_agents' && typeof evt.content === 'string') {
                                                plannerAgents = evt.content;
                                                break;
                                            }
                                        } catch {
                                            // ignore malformed event lines
                                        }
                                    }
                                }
                            }
                            setPlanDraft(planText);
                            setUserPlan({
                                title: "AI Analytics Dashboard",
                                rawPlan: planText,
                                widgets: [],
                                plannerDebug: {
                                    plannerAgents,
                                    plannerAgentStatus: { ...plannerAgentStatus },
                                    agentInputs: { ...agentInputs },
                                    agentStreams: { ...agentStreams },
                                    agentDrafts: { ...agentDrafts },
                                    agentOrder: [...agentOrder],
                                    intentLabels: [...intentLabels],
                                    selectedAgent
                                } as PlannerDebugPayload
                            });
                        } else if ((data?.kind === 'event' && data.event) || data?.event || data?.type) {
                            const evt = data.event || data;
                            if (evt?.type === 'planner_agents' && typeof evt.content === 'string') {
                                plannerAgents = evt.content;
                                const line = `PLAN AGENTS: ${evt.content}`;
                                setPipelineLogs((prev) => [...prev.slice(-199), line]);
                                setPipelineStageLogs((prev) => ({ ...prev, plan: [...prev.plan.slice(-99), line] }));
                                pushPlannerLiveDebug();
                            }
                            if (evt?.type === 'planner_agent_status' && evt.agent && evt.status) {
                                plannerAgentStatus[evt.agent] = evt.status;
                                if (evt.status === 'start' && !agentOrder.includes(evt.agent)) agentOrder.push(evt.agent);
                                if (!selectedAgent && evt.agent) selectedAgent = evt.agent;
                                const line = `PLAN ${String(evt.agent)}: ${String(evt.status).toUpperCase()}`;
                                setPipelineLogs((prev) => [...prev.slice(-199), line]);
                                setPipelineStageLogs((prev) => ({ ...prev, plan: [...prev.plan.slice(-99), line] }));
                                pushPlannerLiveDebug();
                            }
                            if (evt?.type === 'planner_agent_token' && evt.agent && evt.token) {
                                agentStreams[evt.agent] = `${agentStreams[evt.agent] || ""}${evt.token}`;
                                pushPlannerLiveDebug();
                            }
                            if (evt?.type === 'planner_agent_input' && evt.agent) {
                                agentInputs[evt.agent] = String(evt.content || "");
                                if (!selectedAgent && evt.agent) selectedAgent = evt.agent;
                                if (!agentOrder.includes(evt.agent)) agentOrder.push(evt.agent);
                                const preview = String(evt.content || "").replace(/\s+/g, " ").trim().slice(0, 180);
                                const line = `PLAN ${String(evt.agent)} INPUT: ${preview || "INPUT READY"}`;
                                setPipelineLogs((prev) => [...prev.slice(-199), line]);
                                setPipelineStageLogs((prev) => ({ ...prev, plan: [...prev.plan.slice(-99), line] }));
                                pushPlannerLiveDebug();
                            }
                            if (evt?.type === 'planner_agent_draft' && evt.agent) {
                                agentDrafts[evt.agent] = String(evt.content || "");
                                if (!selectedAgent && evt.agent) selectedAgent = evt.agent;
                                const preview = String(evt.content || "").replace(/\s+/g, " ").trim().slice(0, 180);
                                const line = `PLAN ${String(evt.agent)}: ${preview || "DRAFT READY"}`;
                                setPipelineLogs((prev) => [...prev.slice(-199), line]);
                                setPipelineStageLogs((prev) => ({ ...prev, plan: [...prev.plan.slice(-99), line] }));
                                pushPlannerLiveDebug();
                            }
                            if (evt?.type === 'planner_intents' && Array.isArray(evt.intents)) {
                                intentLabels.splice(0, intentLabels.length, ...evt.intents.map((x: any) => String(x)));
                                const line = `PLAN INTENTS: ${evt.intents.map((x: any) => String(x)).join(", ")}`;
                                setPipelineLogs((prev) => [...prev.slice(-199), line]);
                                setPipelineStageLogs((prev) => ({ ...prev, plan: [...prev.plan.slice(-99), line] }));
                                pushPlannerLiveDebug();
                            }
                            if (evt?.type === 'todo_list_initialized' && evt.todoList) {
                                initTodoList(evt.todoList);
                                const line = `TODO INIT: ${(evt.todoList?.items || []).length || 0} items`;
                                setPipelineLogs((prev) => [...prev.slice(-199), line]);
                                setPipelineStageLogs((prev) => ({ ...prev, plan: [...prev.plan.slice(-99), line] }));
                            }
                            if (evt?.type === 'todo_item_updated' && evt.item) {
                                applyTodoItemUpdate(evt.item);
                                const line = `TODO ${String(evt.item.domain).toUpperCase()}: ${evt.item.title} -> ${evt.item.status}`;
                                setPipelineLogs((prev) => [...prev.slice(-199), line]);
                                setPipelineStageLogs((prev) => ({ ...prev, plan: [...prev.plan.slice(-99), line] }));
                            }
                            if (evt?.type === 'todo_summary' && evt.summary) {
                                setTodoSummary(evt.summary);
                            }
                            if (evt?.type === 'planner_schema_usage') {
                                const line = `PLAN SCHEMA INPUT: ${evt.tables || 0} tables, ${evt.columns || 0} columns (${evt.visibleColumns || 0} visible, ${evt.hiddenColumns || 0} hidden), ${evt.relationships || 0} relationships`;
                                setPipelineLogs((prev) => [...prev.slice(-199), line]);
                                setPipelineStageLogs((prev) => ({ ...prev, plan: [...prev.plan.slice(-99), line] }));
                            }
                            if (evt?.type === 'planner_error') {
                                const line = `PLAN ERROR: ${String(evt.message || "Planner failed")}`;
                                setPipelineLogs((prev) => [...prev.slice(-199), line]);
                                setPipelineStageLogs((prev) => ({ ...prev, plan: [...prev.plan.slice(-99), line] }));
                            }
                        }
                    } catch {
                        // ignore malformed chunks
                    }
                }
            }
            const { extractDashboardTitle, parseNaturalLanguagePlan, parsePlanFilters } = await import('@/utils/plan-parser');
            const cleanedPlanText = planText.split("EVENT_STREAM:")[0]?.trim() || planText.trim();
            const allowedTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
            (disabledWidgetTypes || []).forEach((t) => allowedTypes.delete(t));
            const parsedWidgets = parseNaturalLanguagePlan(cleanedPlanText).filter((w: any) => allowedTypes.has(w?.type));
            const safeWidgets = ensurePlanWidgets(parsedWidgets, resolvedSchema);
            const title = extractDashboardTitle(cleanedPlanText) || "AI Analytics Dashboard";
            const finalizedPlan = {
                title,
                rawPlan: plannerAgents
                    ? `${cleanedPlanText}\n\nEVENT_STREAM:\n{"type":"planner_agents","content":"${plannerAgents}"}`
                    : cleanedPlanText,
                widgets: safeWidgets,
                filters: parsePlanFilters(cleanedPlanText),
                plannerAgents,
                plannerDebug: {
                    plannerAgents,
                    plannerAgentStatus,
                    agentInputs,
                    agentStreams,
                    agentDrafts,
                    agentOrder,
                    intentLabels,
                    selectedAgent
                } as PlannerDebugPayload
            };
            setPlannerLiveDebug(finalizedPlan.plannerDebug as PlannerDebugPayload);
            persistPlannerDebugToLocal({
                query,
                schemaTimestamp: schemaData?.schemaTimestamp || null,
                title: finalizedPlan.title,
                rawPlan: finalizedPlan.rawPlan,
                widgets: finalizedPlan.widgets,
                plannerAgents,
                plannerDebug: finalizedPlan.plannerDebug as PlannerDebugPayload
            });
            setAiPlan(finalizedPlan);
            setUserPlan(finalizedPlan);
            sendStep("plan", "done", "Plan ready");
            setAwaitingSqlContinue(true);
            setActiveOutputTab('plan');
            setShowPipelineOutput(true);
            setCurrentView("build");

            // Stop after plan and wait for explicit user continue.
            setPipelineLogs((prev) => [...prev.slice(-199), "Planner: Done - Plan ready. Waiting for Continue to SQL."]);
            setPipelineStageLogs((prev) => ({ ...prev, plan: [...prev.plan.slice(-99), "Done: Plan ready. Waiting for Continue to SQL."] }));
            endRun(true);
            setProcessing(false);
            setIsPipelineRunning(false);
            return;
        } catch (err: any) {
            const message = err?.message || "Pipeline failed";
            handleEvent({
                type: "error",
                message,
                ts: new Date().toISOString()
            } as any);
            setError(message);
            endRun(false, message);
            return;
        } finally {
            setProcessing(false);
            setIsPipelineRunning(false);
        }
    };
    // ─── Chat Q&A Handler ───
    const handleChatQA = async (query: string) => {
        setQaLoading(true);
        const thinkingId = `thinking-${Date.now()}`;
        setMessages(prev => [...prev, {
            id: thinkingId,
            type: "system",
            content: "Analyzing your question...",
            timestamp: new Date().toISOString(),
        }]);

        try {
            const resolvedSchema = await ensureSchema();
            if (!resolvedSchema) throw new Error("No schema available.");

            const response = await fetch('/api/chat-qa', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question: query,
                    schema: scopeSchemaForQuery(resolvedSchema),
                    connectorInstructions: resolvedConnectorInstructions,
                    connectorType: resolvedConnectorType,
                    connectionString: resolvedConnectionString
                })
            });

            if (!response.ok || !response.body) throw new Error("Chat Q&A connection failed.");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let lastStatus = '';
            let result: QAResult | null = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    try {
                        const payload = JSON.parse(trimmed.slice(5).trim());
                        if (payload.message && payload.status !== lastStatus) {
                            lastStatus = payload.status;
                            setMessages(prev => prev.map(m =>
                                m.id === thinkingId ? { ...m, content: payload.message } : m
                            ));
                        }
                        if (payload.status === 'completed') {
                            result = {
                                sql: payload.sql,
                                data: payload.data || [],
                                columns: payload.columns || [],
                                rowCount: payload.rowCount || 0,
                                repaired: payload.repaired || false,
                                narrative: payload.narrative || ''
                            };
                        }
                        if (payload.status === 'error') {
                            result = {
                                sql: payload.sql || '',
                                data: [],
                                columns: [],
                                rowCount: 0,
                                error: payload.message
                            };
                        }
                    } catch { /* ignore malformed */ }
                }
            }

            // Remove thinking message
            setMessages(prev => prev.filter(m => m.id !== thinkingId));

            if (result && !result.error) {
                setMessages(prev => [...prev, {
                    id: `qa-${Date.now()}`,
                    type: "ai",
                    content: result!.narrative || `Found ${result!.rowCount} result${result!.rowCount !== 1 ? "s" : ""}.`,
                    timestamp: new Date().toISOString(),
                    qaResult: result
                }]);
                setFollowUpSuggestions(SUGGESTION_CHIPS.chat.filter(s => s !== query).slice(0, 4));
            } else {
                setMessages(prev => [...prev, {
                    id: `qa-error-${Date.now()}`,
                    type: "error",
                    content: result?.error || "Query failed.",
                    timestamp: new Date().toISOString(),
                    qaResult: result
                }]);
            }
        } catch (err: any) {
            setMessages(prev => prev.filter(m => m.id !== thinkingId));
            setMessages(prev => [...prev, {
                id: `error-${Date.now()}`,
                type: "error",
                content: `Chat Q&A failed: ${err.message || String(err)}`,
                timestamp: new Date().toISOString(),
            }]);
        } finally {
            setQaLoading(false);
        }
    };

    // ─── Report Handler ───
    const handleReport = async (query: string) => {
        setReportLoading(true);
        const thinkingId = `thinking-${Date.now()}`;
        setMessages(prev => [...prev, {
            id: thinkingId,
            type: "system",
            content: "Preparing report...",
            timestamp: new Date().toISOString(),
        }]);

        try {
            const resolvedSchema = await ensureSchema();
            if (!resolvedSchema) throw new Error("No schema available.");

            const response = await fetch('/api/report/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    question: query,
                    schema: scopeSchemaForQuery(resolvedSchema),
                    connectorInstructions: resolvedConnectorInstructions,
                    connectorType: resolvedConnectorType,
                    connectionString: resolvedConnectionString
                })
            });

            if (!response.ok || !response.body) throw new Error("Report API connection failed.");

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let lastStatus = '';
            let report: ReportResult | null = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    try {
                        const payload = JSON.parse(trimmed.slice(5).trim());
                        if (payload.message && payload.status !== lastStatus) {
                            lastStatus = payload.status;
                            setMessages(prev => prev.map(m =>
                                m.id === thinkingId ? { ...m, content: payload.message } : m
                            ));
                        }
                        if (payload.status === 'completed' && payload.report) {
                            report = payload.report;
                        }
                        if (payload.status === 'error') {
                            throw new Error(payload.message);
                        }
                    } catch (e: any) {
                        if (e.message && e.message !== 'Unexpected end of JSON input') throw e;
                    }
                }
            }

            setMessages(prev => prev.filter(m => m.id !== thinkingId));

            if (report) {
                // Auto-expand first section
                if (report.sections?.length > 0) {
                    setExpandedSections(new Set([report.sections[0].id]));
                }
                setMessages(prev => [...prev, {
                    id: `report-${Date.now()}`,
                    type: "ai",
                    content: report!.summary || `Report: ${report!.title}`,
                    timestamp: new Date().toISOString(),
                    reportResult: report
                }]);
                setFollowUpSuggestions(SUGGESTION_CHIPS.report.filter(s => s !== query).slice(0, 4));
            } else {
                setMessages(prev => [...prev, {
                    id: `error-${Date.now()}`,
                    type: "error",
                    content: "Report generation returned no results.",
                    timestamp: new Date().toISOString(),
                }]);
            }
        } catch (err: any) {
            setMessages(prev => prev.filter(m => m.id !== thinkingId));
            setMessages(prev => [...prev, {
                id: `error-${Date.now()}`,
                type: "error",
                content: `Report failed: ${err.message || String(err)}`,
                timestamp: new Date().toISOString(),
            }]);
        } finally {
            setReportLoading(false);
        }
    };

    const handleSend = async () => {
        const query = input.trim();
        if (!query || isPipelineRunning || isStreaming || qaLoading || reportLoading) return;
        if (!hasConnectedSqlSource || !resolvedConnectionString) {
            setMessages(prev => [...prev, {
                id: `error-${Date.now()}`,
                type: "error",
                content: "No SQL data source is connected. Open Data Sources, connect Postgres/MSSQL, then try again.",
                timestamp: new Date().toISOString(),
            }]);
            setCurrentView("data-sources");
            return;
        }

        // Add user message
        const userMessage: Message = {
            id: `user-${Date.now()}`,
            type: "user",
            content: `${MODE_CONFIG[chatMode].label}: ${query}`,
            timestamp: new Date().toISOString(),
        };
        setMessages(prev => [...prev, userMessage]);
        setInput("");
        setShowSuggestions(false);
        setFollowUpSuggestions([]);

        addToRecentQueries(query);

        // Route based on mode
        if (chatMode === 'chat') {
            await handleChatQA(query);
            return;
        }

        if (chatMode === 'report') {
            await handleReport(query);
            return;
        }

        // Dashboard mode (existing pipeline)
        try {
            setMessages(prev => [...prev, {
                id: `ai-${Date.now()}`,
                type: "ai",
                content: "Running full pipeline: schema → plan → SQL → execution → dashboard.",
                timestamp: new Date().toISOString(),
            }]);
            await runSequentialPipeline(query);
        } catch (err: any) {
            console.error("Pipeline failed:", err);
            setError(err.message || String(err));
            setProcessing(false);
            setMessages(prev => [...prev, {
                id: `error-${Date.now()}`,
                type: "error",
                content: `Pipeline failed: ${err.message || String(err)}`,
                timestamp: new Date().toISOString(),
            }]);
        }
    };

    const handleSuggestionClick = (suggestion: string) => {
        setInput(suggestion);
        inputRef.current?.focus();
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const handleHistoryClick = (query: string) => {
        setInput(query);
        setShowHistory(false);
        inputRef.current?.focus();
    };

    const plan = userPlan || aiPlan;
    const queries = userQueries || aiQueries || [];
    const filterKey = JSON.stringify(Object.fromEntries(Array.from(activeFilters.entries())));
    const resolvedTables = schemaData?.tables || Object.keys(schemaData?.schemaInfo || {});
    const executionSummary = Array.isArray(executionResults) ? executionResults : [];

    useEffect(() => {
        if (!plan?.rawPlan) return;
        setPlanDraft(plan.rawPlan);
    }, [plan?.rawPlan]);

    useEffect(() => {
        if (!plan?.rawPlan) return;
        const hasDebug = Boolean((plan as any)?.plannerDebug);
        if (hasDebug) return;
        try {
            const raw = localStorage.getItem(PLANNER_DEBUG_STORAGE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            const schemaKey = String(schemaData?.schemaTimestamp || "");
            const queryKey = String(workflowQuery || "");
            const entryKey = `${queryKey}::${schemaKey}`;
            const cached = (() => {
                if (parsed && typeof parsed === "object" && parsed.version === PLANNER_DEBUG_STORAGE_VERSION && parsed.entries) {
                    return parsed.entries[entryKey] || parsed.entries[parsed.latestKey] || null;
                }
                if (parsed && typeof parsed === "object" && parsed.query) {
                    return parsed;
                }
                return null;
            })();
            if (!cached) return;
            if (!cached?.plannerDebug) return;
            if (cached?.rawPlan && plan?.rawPlan && String(cached.rawPlan) !== String(plan.rawPlan)) {
                // fallback match when query/schema key doesn't align
                const byRawPlan: any = parsed?.entries
                    ? Object.values(parsed.entries).find((entry: any) => String(entry?.rawPlan || "") === String(plan.rawPlan))
                    : null;
                if (!byRawPlan?.plannerDebug) return;
                const mergedRaw = {
                    ...plan,
                    plannerAgents: (plan as any)?.plannerAgents || byRawPlan?.plannerAgents || null,
                    plannerDebug: byRawPlan.plannerDebug
                };
                setAiPlan(mergedRaw);
                setUserPlan(mergedRaw);
                return;
            }
            const merged = {
                ...plan,
                plannerAgents: (plan as any)?.plannerAgents || cached?.plannerAgents || null,
                plannerDebug: cached.plannerDebug
            };
            setAiPlan(merged);
            setUserPlan(merged);
        } catch {
            // ignore cache parse issues
        }
    }, [plan?.rawPlan, workflowQuery, schemaData?.schemaTimestamp, setAiPlan, setUserPlan]);

    useEffect(() => {
        const map: Record<number, typeof activeOutputTab> = {
            1: 'schema',
            2: 'plan',
            3: 'sql',
            4: 'execute',
            5: 'dashboard'
        };
        const next = map[currentStep as number];
        if (next && next !== activeOutputTab) {
            setActiveOutputTab(next);
        }
    }, [currentStep, activeOutputTab]);

    useEffect(() => {
        if (!queries || queries.length === 0) return;
        const next: Record<string, string> = {};
        queries.forEach((q: any) => {
            next[q.id] = q.sql;
        });
        setSqlDrafts(next);
    }, [queries]);

    // Reads the saved column toggles from localStorage and applies them to produce:
    // - disabledFilterColumns: columns explicitly turned OFF for filtering by the user
    // - filterableColumns: updated list of enabled filter columns (base from schema minus disabled, plus explicit enables)
    // This runs on every schema fetch so the latest toggle state is always used.
    const applyLatestTogglesToSchema = (base: Record<string, unknown>): { disabledFilterColumns: Record<string, string[]>; filterableColumns: Record<string, string[]> } => {
        try {
            const raw = localStorage.getItem('schema_column_toggles');
            const toggles = raw ? JSON.parse(raw) as Record<string, Record<string, { show?: boolean; filterable?: boolean }>> : {};

            const disabled: Record<string, string[]> = {};
            const filterableCols: Record<string, string[]> = {};

            const baseFilterable = (base?.filterableColumns || {}) as Record<string, string[]>;
            const schemaInfo = (base?.schemaInfo || {}) as Record<string, unknown>;
            const allTables = Array.from(new Set([...Object.keys(schemaInfo), ...Object.keys(baseFilterable)]));

            for (const table of allTables) {
                const baseList: string[] = Array.isArray(baseFilterable[table]) ? [...baseFilterable[table]] : [];
                const tableToggles = toggles[table] || {};
                const disabledForTable: string[] = [];

                // Build enabled set starting from base, then apply explicit overrides
                const enabledSet = new Set<string>(baseList.map((c: string) => c.toLowerCase()));
                Object.entries(tableToggles).forEach(([col, entry]) => {
                    if (entry && 'filterable' in entry) {
                        if (entry.filterable === false) {
                            enabledSet.delete(col.toLowerCase());
                            disabledForTable.push(col);
                        } else if (entry.filterable === true) {
                            enabledSet.add(col.toLowerCase());
                        }
                    }
                });

                // Rebuild filterableColumns preserving original casing
                const candidates = [
                    ...baseList,
                    ...Object.keys(tableToggles).filter(c => tableToggles[c]?.filterable === true)
                ];
                filterableCols[table] = candidates
                    .filter(c => enabledSet.has(c.toLowerCase()))
                    .filter((c, i, arr) => arr.findIndex(x => x.toLowerCase() === c.toLowerCase()) === i);

                if (disabledForTable.length > 0) disabled[table] = disabledForTable;
            }

            return { disabledFilterColumns: disabled, filterableColumns: filterableCols };
        } catch {
            return { disabledFilterColumns: {}, filterableColumns: (base?.filterableColumns || {}) as Record<string, string[]> };
        }
    };

    const ensureSchema = async () => {
        const tryDiscover = async (attempts: number) => {
            let lastError: any = null;
            for (let i = 0; i < attempts; i++) {
                try {
                    const storedTablesRaw = localStorage.getItem('schema_selected_tables');
                    const allowedTables = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
                    if (!resolvedConnectionString) continue;
                    const data = await runSchemaDiscovery(
                        resolvedConnectionString,
                        {
                            enableSemanticSearch: true,
                            enableTableKpis: true,
                            enableTableMatrix: true,
                            enableTableFilters: true,
                            projectContext
                        },
                        allowedTables.length > 0 ? allowedTables : undefined
                    );
                    if (data?.tables && data.tables.length > 0) return data;
                    lastError = new Error("Schema discovery returned no tables.");
                } catch (err: any) {
                    lastError = err;
                }
            }
            throw lastError || new Error("Schema discovery failed.");
        };
        if (schemaData) {
            const cachedConn = String((schemaData as any)?.connectionString || "").trim();
            const activeConn = String(resolvedConnectionString || "").trim();
            if (!activeConn || !cachedConn || cachedConn === activeConn) {
                // Check if the selected-tables filter has changed since the schema was cached.
                const storedTablesRaw = localStorage.getItem('schema_selected_tables');
                const selectedTables: string[] = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
                const cachedTables: string[] = Array.isArray((schemaData as any)?.tables)
                    ? (schemaData as any).tables
                    : Object.keys((schemaData as any)?.schemaInfo || {});

                if (selectedTables.length > 0) {
                    const sel = [...selectedTables].map(t => t.toLowerCase()).sort().join(',');
                    const cached = [...cachedTables].map(t => t.toLowerCase()).sort().join(',');
                    if (sel !== cached) {
                        // Filter changed — fall through to re-run discovery
                    } else {
                        const { disabledFilterColumns, filterableColumns } = applyLatestTogglesToSchema(schemaData as Record<string, unknown>);
                        return { ...schemaData, disabledFilterColumns, filterableColumns };
                    }
                } else {
                    const { disabledFilterColumns, filterableColumns } = applyLatestTogglesToSchema(schemaData as Record<string, unknown>);
                    return { ...schemaData, disabledFilterColumns, filterableColumns };
                }
            }
        }
        try {
            const data = await tryDiscover(3);
            const { disabledFilterColumns, filterableColumns } = applyLatestTogglesToSchema(data as Record<string, unknown>);
            const withToggles = { ...data, disabledFilterColumns, filterableColumns };
            setSchemaData(withToggles);
            return withToggles;
        } catch {
            // continue to manual fallback
        }
        const manual = loadManualSchema();
        if (manual) {
            const { disabledFilterColumns, filterableColumns } = applyLatestTogglesToSchema(manual as Record<string, unknown>);
            const withToggles = { ...manual, disabledFilterColumns, filterableColumns };
            setSchemaData(withToggles);
            return withToggles;
        }
        throw new Error("No schema selected or found.");
    };

    /**
     * Restrict a schema object to only the allowed tables from localStorage
     * and stamp it with the active connection string + connector type.
     * This ensures chat-QA and report modes never reference tables the user
     * hasn't selected, regardless of what the cached schemaData contains.
     */
    const scopeSchemaForQuery = (schema: any): any => {
        const storedRaw = localStorage.getItem('schema_selected_tables');
        const allowedTables: string[] = storedRaw ? JSON.parse(storedRaw) : [];
        const allowedNorm = allowedTables.length > 0
            ? new Set(allowedTables.map((t) => String(t || '').trim().toLowerCase()))
            : null;

        const normalize = (t: string) => String(t || '').trim().toLowerCase();

        const scopedTables = allowedNorm
            ? (Array.isArray(schema?.tables) ? schema.tables : []).filter((t: string) => allowedNorm.has(normalize(t)))
            : schema?.tables || [];

        const scopedSchemaInfo = allowedNorm
            ? Object.fromEntries(
                Object.entries(schema?.schemaInfo || {}).filter(([t]) => allowedNorm.has(normalize(t)))
              )
            : schema?.schemaInfo || {};

        return {
            ...schema,
            tables: scopedTables,
            schemaInfo: scopedSchemaInfo,
            // Always stamp with the live active connection so APIs use the right DB
            connectionString: resolvedConnectionString,
            connectorType: resolvedConnectorType,
        };
    };

    const executeQueries = async (queryList: any[]) => {
        const queryMap: Record<string, string> = {};
        queryList.forEach((q: any) => {
            queryMap[q.id] = q.sql;
        });
        const executionContext = buildExecutionContext((userPlan || aiPlan)?.filters || [], (userPlan || aiPlan)?.widgets || []);
        const tablePagination = executionContext.tablePagination;
        const runtimeParams = executionContext.runtimeParams;
        const runtimePaginationParams = Object.fromEntries(
            Object.entries(runtimeParams).filter(([key]) =>
                key.startsWith("__page:")
                || key.startsWith("__pageSize:")
                || key.startsWith("__offset:")
                || key === "page"
                || key === "size"
                || key === "pageSize"
                || key === "page_size"
                || key === "storePage"
                || key === "storeSize"
                || key === "rowsOnPage"
                || key === "offset"
            )
        );
        console.log("[PAGINATION_DEBUG][CHAT] executeQueries", {
            queryIds: Object.keys(queryMap),
            tablePagination,
            runtimePaginationParams
        });
        const execResults = await runQueryExecutor(queryMap, resolvedConnectionString, {
            connectorInstructions: resolvedConnectorInstructions,
            connectorType: resolvedConnectorType,
            tablePagination,
            runtimeParams
        });
        const resultsList = Object.entries(execResults).map(([id, result]: [string, any]) => ({
            id,
            ...result,
            title: queryList.find((q: any) => q.id === id)?.title || id
        }));
        setExecutionResults(resultsList);
        resultsList.forEach((res: any) => {
            if (res.status === 'error') {
                addSqlError({
                    id: res.id,
                    title: res.title,
                    error: res.error
                });
            }
        });
        const planToUse = userPlan || aiPlan;
        if (planToUse && schemaData) {
            const errorResults = resultsList.filter((res: any) => res.status === 'error');
            if (errorResults.length > 0) {
                const repairTasks = errorResults.map(async (res: any) => {
                    const widgetInfo = planToUse.widgets?.find((w: any) => w.id === res.id);
                    const originalSql = queryList.find((q: any) => q.id === res.id)?.sql;
                    if (!widgetInfo || !originalSql) return null;
                    try {
                        const repairResult = await repairFailedQuery({
                            widgetId: res.id,
                            widgetTitle: widgetInfo.title || res.id,
                            widgetType: widgetInfo.type || 'unknown',
                            widgetGoal: widgetInfo.goal,
                            originalSql,
                            errorMessage: res.error || 'Execution failed',
                            schema: {
                                ...schemaData,
                                connectorInstructions: resolvedConnectorInstructions || schemaData?.connectorInstructions,
                                connectorType: resolvedConnectorType || schemaData?.connectorType,
                                connectionString: resolvedConnectionString || schemaData?.connectionString || postgresUrl
                            },
                            errorLog: sqlErrorLog,
                            connectionString: resolvedConnectionString
                        });
                        return { id: res.id, repairResult };
                    } catch (repairErr: any) {
                        addSqlError({
                            id: res.id,
                            title: widgetInfo?.title || res.id,
                            error: repairErr.message || 'Auto-repair failed'
                        });
                        return { id: res.id, repairError: repairErr?.message || 'Auto-repair failed' };
                    }
                });

                const repairResults = await Promise.all(repairTasks);
                let nextQueries = [...queryList];
                let nextResults = [...resultsList];

                const rerunTasks = repairResults
                    .filter((entry: any) => entry && entry.repairResult)
                    .map(async (entry: any) => {
                        const { id, repairResult } = entry;
                        nextQueries = nextQueries.map((q: any) => q.id === id ? { ...q, sql: repairResult.sql } : q);
                        const rerun = await runQueryExecutor({ [id]: repairResult.sql }, resolvedConnectionString, {
                            connectorInstructions: resolvedConnectorInstructions,
                            connectorType: resolvedConnectorType,
                            tablePagination: {
                                [id]: buildPaginationConfigForId(id)
                            },
                            runtimeParams: buildExecutionContext((userPlan || aiPlan)?.filters || [], []).runtimeParams
                        });
                        return { id, fixed: rerun[id], repairResult };
                    });

                const rerunResults = await Promise.all(rerunTasks);
                rerunResults.forEach((res) => {
                    if (!res) return;
                    nextResults = nextResults.map((r: any) =>
                        r.id === res.id
                            ? { ...res.fixed, id: res.id, title: r.title || res.id, repairedSql: res.repairResult.sql, repairExplanation: res.repairResult.explanation }
                            : r
                    );
                });

                setUserQueries(nextQueries);
                setExecutionResults(nextResults);
                return nextResults;
            }
        }
        return resultsList;
    };

    const assembleDashboard = async (planToUse: any, queryList: any[], resultsList: any[], schemaToUse: any) => {
        let insights: string[] = [];
        try {
            insights = await runNarrativeGenerator(resultsList as any[]);
        } catch {
            insights = ["Data retrieval successful. Full analysis ready for inspection."];
        }
        const finalDashboard = await assembleFinalDashboard(
            planToUse, queryList as any[], resultsList as any[], insights,
            schemaToUse?.filterCandidates,
            { visibleColumns: schemaToUse?.visibleColumns, filterableColumns: schemaToUse?.filterableColumns }
        );
        setDashboardConfig(finalDashboard);
        return finalDashboard;
    };

    useEffect(() => {
        const shouldAutoRefresh = staleStep === 4;
        if (!shouldAutoRefresh) return;
        if (!plan || !schemaData || !queries || queries.length === 0) return;
        if (isStreaming || isPipelineRunning || isProcessing || autoRefreshInFlightRef.current) return;

        if (autoRefreshTimerRef.current) {
            clearTimeout(autoRefreshTimerRef.current);
        }

        autoRefreshTimerRef.current = setTimeout(async () => {
            autoRefreshInFlightRef.current = true;
            try {
                setStep(4);
                setActiveOutputTab('execute');
                const resultsList = await executeQueries(queries);
                await assembleDashboard(plan, queries, resultsList || [], schemaData);
                setStep(5);
                setStaleStep(null);
            } catch (err: any) {
                setError(err?.message || "Failed to refresh dashboard data.");
            } finally {
                autoRefreshInFlightRef.current = false;
            }
        }, 120);

        return () => {
            if (autoRefreshTimerRef.current) {
                clearTimeout(autoRefreshTimerRef.current);
            }
        };
    }, [staleStep, plan, queries, schemaData, filterKey, isStreaming, isPipelineRunning, isProcessing, setError, setStep, setStaleStep]);

    const streamSqlAndExecuteParallel = async (
        planToUse: any,
        schemaToUse: any,
        sendStep?: (step: any, status: any, message?: string) => void,
        options?: { generateOnly?: boolean; prebuiltSqlMap?: Record<string, string> }
    ) => {
        setPipelineLogs([]);
        setPipelineStageLogs({ schema: [], plan: [], sql: [], execute: [], dashboard: [] });
        appendPipelineLog("sql", "Running: Initializing SQL stream");
        setStep(3);
        sendStep?.("sql", "running", "Generating SQL");
        setActiveOutputTab('sql');
        setShowPipelineOutput(true);

        const response = await fetch('/api/widget-pipeline/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                plan: planToUse,
                schema: schemaToUse,
                filters: Object.fromEntries(activeFilters),
                applyFilters: filtersActivated,
                errorLog: sqlErrorLog,
                connectorType: resolvedConnectorType,
                connectorInstructions: resolvedConnectorInstructions,
                connectionString: resolvedConnectionString,
                todoListState,
                generateOnly: options?.generateOnly ?? false,
                prebuiltSqlMap: options?.prebuiltSqlMap ?? {},
            })
        });
        if (!response.ok || !response.body) {
            const bodyText = await response.text().catch(() => "");
            throw new Error(bodyText || "SQL generator connection failed.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const queryMap: Record<string, string> = {};
        const resultsMap: Record<string, any> = {};
        const inflight = new Map<string, Promise<any>>();
        let executeStarted = false;
        let dashboardStarted = false;
        let sqlCompletionLogged = false;

        const upsertQueries = () => {
            const queryList = Object.entries(queryMap).map(([id, sql]) => ({
                id,
                sql,
                title: planToUse.widgets?.find((w: any) => w.id === id)?.title || id
            }));
            setAiQueries(queryList);
            setUserQueries(queryList);
            return queryList;
        };

        const upsertResults = (queryList: any[]) => {
            const resultsList = Object.entries(resultsMap).map(([id, result]: [string, any]) => ({
                id,
                ...result,
                title: queryList.find((q) => q.id === id)?.title || id
            }));
            setExecutionResults(resultsList);
            return resultsList;
        };

        const updateDashboardPartial = async (queryList: any[], resultsList: any[]) => {
            if (!dashboardStarted) {
                dashboardStarted = true;
                setStep(5);
                sendStep?.("viz", "running", "Assembling dashboard");
            }
            const partial = await assembleFinalDashboard(planToUse, queryList, resultsList, [], schemaToUse?.filterCandidates,
                { visibleColumns: schemaToUse?.visibleColumns, filterableColumns: schemaToUse?.filterableColumns });
            setDashboardConfig(partial);
            handleEvent({
                type: "partial_dashboard",
                dashboard: partial,
                ts: new Date().toISOString()
            } as any);
        };


        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                let payload: any;
                try {
                    payload = JSON.parse(trimmed.slice(5).trim());
                } catch {
                    continue;
                }
                if (payload.status === 'error') {
                    throw new Error(payload.message || 'Widget pipeline failed.');
                }
                if (payload.status === 'started') appendPipelineLog("sql", "Running: Stream started");
                if (payload.status === 'todo_sql_started' && payload.todoList) {
                    initTodoList(payload.todoList);
                    appendPipelineLog("sql", `TODO SQL STARTED: ${(payload.todoList?.items || []).length || 0} items`);
                }
                if (payload.status === 'todo_sql_widget_update' && payload.item) {
                    applyTodoItemUpdate(payload.item);
                    appendPipelineLog("sql", `TODO SQL: ${payload.item.title} -> ${payload.item.status}`);
                }
                if (payload.status === 'todo_sql_summary' && payload.summary) {
                    setTodoSummary(payload.summary);
                    appendPipelineLog("sql", `TODO SQL SUMMARY: total=${payload.summary?.total || 0}`);
                }
                const widgetId = payload.widgetId as string | undefined;
                const status = String(payload.status || "");
                const widgetLabel = widgetId ? ` for ${widgetId}` : "";
                if (status === 'sql_builder_running' && widgetId) {
                    appendPipelineLog("sql", `Running: Builder started${widgetLabel}`);
                }
                if (status === 'sql_generation_path' && widgetId) {
                    const mode = String(payload.path || "full");
                    appendPipelineLog("sql", `SQL path${widgetLabel}: ${mode.toUpperCase()}`);
                }
                if (status === 'sql_builder_done' && widgetId && payload.sql) {
                    queryMap[widgetId] = payload.sql;
                    upsertQueries();
                    appendPipelineLog("sql", `Done: Builder finished${widgetLabel}`);
                }
                if (status === 'sql_validator_running' && widgetId) {
                    appendPipelineLog("sql", `Running: Validator checking${widgetLabel}`);
                }
                if (status === 'sql_validator_fixed' && widgetId && payload.sql) {
                    queryMap[widgetId] = payload.sql;
                    upsertQueries();
                    appendPipelineLog("sql", `Done: Validator fixed${widgetLabel}`);
                }
                if (status === 'sql_validator_done' && widgetId) {
                    appendPipelineLog("sql", `Done: Validator approved${widgetLabel}`);
                }
                if (status === 'sql_review_ready' && widgetId && payload.sql) {
                    queryMap[widgetId] = payload.sql;
                    upsertQueries();
                    appendPipelineLog("sql", `Review ready${widgetLabel}`);
                }
                if (status === 'execution_running' && !executeStarted) {
                    executeStarted = true;
                    setStep(4);
                    sendStep?.("execute", "running", "Executing queries");
                }
                if (status === 'execution_running' && widgetId) {
                    appendPipelineLog("execute", `Running: Executing${widgetLabel}`);
                }
                if (status === 'execution_retry' && widgetId) {
                    if (payload.sql) {
                        queryMap[widgetId] = payload.sql;
                        upsertQueries();
                    }
                    appendPipelineLog("execute", `Warning: Auto-repair retry${widgetLabel} (attempt ${payload.attempt || "?"})`);
                }
                if (status === 'manual_required' && widgetId) {
                    appendPipelineLog("execute", `Warning: Manual fix needed${widgetLabel}`);
                }
                if (status === 'execution_done' && widgetId && payload.result) {
                    resultsMap[widgetId] = payload.result;
                    const queryList = upsertQueries();
                    const resultsList = upsertResults(queryList);
                    const task = updateDashboardPartial(queryList, resultsList);
                    inflight.set(widgetId, task);
                    appendPipelineLog("execute", `Done: Execution completed${widgetLabel}`);
                }
                if (status === 'formatter_done' && widgetId && payload.result) {
                    resultsMap[widgetId] = payload.result;
                    const queryList = upsertQueries();
                    const resultsList = upsertResults(queryList);
                    const task = updateDashboardPartial(queryList, resultsList);
                    inflight.set(widgetId, task);
                    appendPipelineLog("dashboard", `Running: Widget formatted${widgetLabel}`);
                }
                if (status === 'completed') {
                    const queryCount = Object.keys(queryMap).length;
                    appendPipelineLog("sql", `✓ SQL generation completed: ${queryCount} queries generated`);
                    appendPipelineLog("sql", "Done: Stream completed");
                    sqlCompletionLogged = true;
                }
                if (widgetId && status.startsWith("sql_") && ![
                    "sql_builder_running",
                    "sql_builder_done",
                    "sql_validator_running",
                    "sql_validator_fixed",
                    "sql_validator_done",
                ].includes(status)) {
                    appendPipelineLog("sql", `${status.replace(/_/g, " ")}${widgetLabel}`);
                }
            }
        }

        if (Object.keys(queryMap).length === 0) {
            throw new Error("SQL Engineering produced no queries from DB streaming pipeline.");
        }
        if (!sqlCompletionLogged) {
            const queryCount = Object.keys(queryMap).length;
            appendPipelineLog("sql", `✓ SQL generation completed: ${queryCount} queries generated`);
        }
        sendStep?.("sql", "done", "SQL generation complete");
        appendPipelineLog("sql", "Done: SQL generation complete");

        // HITL: generateOnly mode — pause here and wait for user to approve execution
        if (options?.generateOnly) {
            upsertQueries();
            setAwaitingExecutionApprove(true);
            setActiveOutputTab('sql');
            return;
        }

        await Promise.all(Array.from(inflight.values()));
        const queryList = upsertQueries();
        let resultsList = upsertResults(queryList);
        if (resultsList.length === 0 && queryList.length > 0) {
            setStep(4);
            sendStep?.("execute", "running", "Executing queries");
            setPipelineLogs((prev) => [...prev.slice(-199), "Executor: Running - Executing generated SQL queries"]);
            appendPipelineLog("execute", "Running: Executing generated SQL queries");
            resultsList = await executeQueries(queryList);
        }
        sendStep?.("execute", "done", "Execution complete");
        appendPipelineLog("dashboard", "Running: Assembling final output");
        let insights: string[] = [];
        try {
            insights = await runNarrativeGenerator(resultsList as any[]);
            sendStep?.("narrative", "done", "Insights ready");
        } catch {
            insights = ["Data retrieval successful. Full analysis ready for inspection."];
        }

        const finalDashboard = await assembleFinalDashboard(planToUse, queryList, resultsList, insights, schemaToUse?.filterCandidates,
            { visibleColumns: schemaToUse?.visibleColumns, filterableColumns: schemaToUse?.filterableColumns });
        setDashboardConfig(finalDashboard);
        handleEvent({
            type: "partial_dashboard",
            dashboard: finalDashboard,
            ts: new Date().toISOString()
        } as any);
        sendStep?.("viz", "done", "Dashboard ready");
        appendPipelineLog("dashboard", "Done: Dashboard ready");
    };

    const rerunFromPlan = async (options?: { generateOnly?: boolean }) => {
        const schemaToUse = await ensureSchema();
        if (!schemaToUse) throw new Error("Schema context missing. Please run Schema Discovery first.");
        let nextPlan: any;
        const hasCurrentPlanWidgets = Array.isArray(plan?.widgets) && plan.widgets.length > 0;
        if (hasCurrentPlanWidgets) {
            const raw = String(plan?.rawPlan || planDraft || "").trim();
            const cleaned = raw ? (raw.split("EVENT_STREAM:")[0]?.trim() || raw) : "";
            nextPlan = {
                ...plan,
                rawPlan: cleaned || String(plan?.rawPlan || ""),
                widgets: ensurePlanWidgets(plan.widgets, schemaToUse),
            };
        } else {
            const { extractDashboardTitle, parseNaturalLanguagePlan, parsePlanFilters } = await import('@/utils/plan-parser');
            const sourcePlanText = (planDraft || plan?.rawPlan || "").trim();
            if (!sourcePlanText) throw new Error("Plan is empty.");
            const cleaned = sourcePlanText.split("EVENT_STREAM:")[0]?.trim() || sourcePlanText;
            const parsedWidgets = parseNaturalLanguagePlan(cleaned);
            const fallbackWidgets = Array.isArray(plan?.widgets) ? plan.widgets : [];
            const safeWidgets = ensurePlanWidgets(parsedWidgets.length > 0 ? parsedWidgets : fallbackWidgets, schemaToUse);
            nextPlan = {
                title: extractDashboardTitle(cleaned) || plan?.title || "AI Analytics Dashboard",
                rawPlan: cleaned,
                widgets: safeWidgets,
                filters: parsePlanFilters(cleaned)
            };
        }
        setAiPlan(nextPlan);
        setUserPlan(nextPlan);
        const runId = `local_continue_${Date.now()}`;
        startRun(runId);
        setAwaitingSqlContinue(false);
        setAwaitingExecutionApprove(false);
        setPipelineLogs([]);
        setPipelineStageLogs({ schema: [], plan: [], sql: [], execute: [], dashboard: [] });
        resetTodoList();
        setDashboardConfig(null);
        setDashboard(null);
        setIsPipelineRunning(true);
        setProcessing(true);
        setError(null);
        const sendStep = (step: any, status: any, message?: string) => {
            const ts = new Date().toISOString();
            const stageLabel =
                step === "schema" || step === "kpi" ? "Schema"
                    : step === "plan" ? "Planner"
                        : step === "sql" ? "SQL Engineer"
                            : step === "execute" ? "Executor"
                                : (step === "viz" || step === "narrative") ? "Dashboard"
                                    : String(step);
            const statusLabel =
                status === "running" ? "Running"
                    : status === "done" ? "Done"
                        : status === "error" ? "Error"
                            : String(status);
            handleEvent({
                type: "step",
                step,
                status,
                message,
                ts
            } as any);
            if (message) {
                handleEvent({
                    type: "log",
                    step,
                    message,
                    ts
                } as any);
                setPipelineLogs((prev) => [...prev.slice(-199), `${stageLabel}: ${statusLabel} - ${message}`]);
                const stage =
                    (step === "schema" || step === "kpi") ? "schema"
                        : step === "plan" ? "plan"
                        : step === "sql" ? "sql"
                        : step === "execute" ? "execute"
                            : (step === "viz" || step === "narrative") ? "dashboard"
                                : null;
                if (stage) {
                    setPipelineStageLogs((prev) => ({
                        ...prev,
                        [stage]: [...prev[stage as PipelineStage].slice(-99), `${statusLabel}: ${message}`]
                    }));
                }
            }
        };
        try {
            await streamSqlAndExecuteParallel(nextPlan, schemaToUse, sendStep, options);
            endRun(true);
        } catch (err: any) {
            const message = err?.message || "Pipeline failed";
            handleEvent({
                type: "error",
                message,
                ts: new Date().toISOString()
            } as any);
            setError(message);
            endRun(false, message);
            throw err;
        } finally {
            setProcessing(false);
            setIsPipelineRunning(false);
        }
    };

    const continueToSql = async () => {
        setAwaitingSqlContinue(false);
        setAwaitingExecutionApprove(false);
        setActiveOutputTab('sql');
        setShowPipelineOutput(true);
        setCurrentView("build");
        setStep(3);
        // HITL: generate SQL only first — user reviews before execution
        await rerunFromPlan({ generateOnly: true });
    };

    /** HITL: User reviewed SQL and clicked "Run Queries" — execute using current userQueries as-is. */
    const approveAndExecute = async () => {
        setAwaitingExecutionApprove(false);
        const schemaToUse = await ensureSchema();
        if (!schemaToUse) throw new Error("Schema context missing.");
        const planToUse = userPlan || aiPlan;
        if (!planToUse) throw new Error("No plan available.");

        // Build prebuiltSqlMap from the user-reviewed (possibly edited) queries
        const prebuiltSqlMap: Record<string, string> = {};
        (queries || []).forEach((q: any) => {
            if (q?.id && q?.sql) prebuiltSqlMap[q.id] = q.sql;
        });

        const runId = `local_execute_${Date.now()}`;
        startRun(runId);
        setPipelineLogs([]);
        setPipelineStageLogs({ schema: [], plan: [], sql: [], execute: [], dashboard: [] });
        setIsPipelineRunning(true);
        setProcessing(true);
        setError(null);
        const sendStep = (step: any, status: any, message?: string) => {
            const ts = new Date().toISOString();
            handleEvent({ type: "step", step, status, message, ts } as any);
        };
        try {
            await streamSqlAndExecuteParallel(planToUse, schemaToUse, sendStep, { prebuiltSqlMap });
            endRun(true);
        } catch (err: any) {
            const message = err?.message || "Execution failed";
            setError(message);
            endRun(false, message);
        } finally {
            setProcessing(false);
            setIsPipelineRunning(false);
        }
    };

    const rerunFromSql = async () => {
        const schemaToUse = await ensureSchema();
        if (!schemaToUse) throw new Error("Schema context missing. Please run Schema Discovery first.");
        const base = queries;
        const nextQueries = base.map((q: any) => ({
            ...q,
            sql: sqlDrafts[q.id] ?? q.sql
        }));
        setUserQueries(nextQueries);
        setStep(4);
        const resultsList = await executeQueries(nextQueries);
        setStep(5);
        await assembleDashboard(plan, nextQueries, resultsList, schemaToUse);
    };

    const renderPipelineOutput = () => {
        if (!showPipelineOutput) return null;
        const summary = todoListState?.summary;
        const byDomain = (todoListState?.items || []).reduce<Record<string, any[]>>((acc, item) => {
            const key = String(item?.domain || "other");
            if (!acc[key]) acc[key] = [];
            acc[key].push(item);
            return acc;
        }, {});
        const renderTodoList = (domains: string[]) => {
            const items = domains.flatMap((domain) => byDomain[domain] || []);
            if (items.length === 0) return null;
            const grouped = domains
                .map((domain) => ({ domain, items: byDomain[domain] || [] }))
                .filter((group) => group.items.length > 0);
            return (
                <div className={styles.outputItem}>
                    <div className={styles.outputItemHeader}>
                        <span>Dynamic TODO List</span>
                        <span className={styles.outputPill}>total {summary?.total || items.length}</span>
                    </div>
                    {!!summary && (
                        <div className={styles.outputMeta}>
                            <span>Pending: {summary.byStatus?.pending || 0}</span>
                            <span>Running: {summary.byStatus?.running || 0}</span>
                            <span>Done: {summary.byStatus?.done || 0}</span>
                            <span>Blocked: {(summary.byStatus?.blocked || 0) + (summary.byStatus?.failed || 0)}</span>
                        </div>
                    )}
                    {grouped.map((group) => (
                        <div key={`todo-group-${group.domain}`} style={{ marginTop: 8 }}>
                            <div style={{ fontSize: 12, textTransform: "uppercase", opacity: 0.7, marginBottom: 6 }}>{group.domain}</div>
                            {group.items.map((item) => (
                                <div key={item.id} className={styles.outputMeta}>
                                    <span>{item.title}</span>
                                    <span className={styles.outputPill}>{item.status}</span>
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            );
        };

        if (activeOutputTab === 'schema') {
            return (
                <div className={styles.outputBody}>
                    {pipelineStageLogs.schema.length > 0 && (
                        <div className={styles.outputLog}>
                            {pipelineStageLogs.schema.slice(-8).map((line, idx) => (
                                <div key={`log-schema-${idx}`} className={styles.outputLogLine}>{line}</div>
                            ))}
                        </div>
                    )}
                    <div className={styles.outputMeta}>
                        <span>Tables: {resolvedTables.length || 0}</span>
                        <span>Filters: {schemaData?.filterSummary || 'None detected'}</span>
                    </div>
                    <div className={styles.outputBlock}>
                        {resolvedTables.length > 0 ? resolvedTables.map((table: string) => (
                            <span key={table} className={styles.outputPill}>{table}</span>
                        )) : <span className={styles.outputEmpty}>No schema loaded yet.</span>}
                    </div>
                </div>
            );
        }

        if (activeOutputTab === 'plan') {
            return (
                <div className={styles.outputBody}>
                    {pipelineStageLogs.plan.length > 0 && (
                        <div className={styles.outputLog}>
                            {pipelineStageLogs.plan.slice(-8).map((line, idx) => (
                                <div key={`log-plan-${idx}`} className={styles.outputLogLine}>{line}</div>
                            ))}
                        </div>
                    )}
                    <div className={styles.outputMeta}>
                        <span>Title: {plan?.title || '—'}</span>
                        <span>Widgets: {plan?.widgets?.length || 0}</span>
                    </div>
                    {isEditingPlan ? (
                        <textarea
                            className={styles.outputEditor}
                            value={planDraft}
                            onChange={(e) => setPlanDraft(e.target.value)}
                        />
                    ) : (
                        <pre className={styles.outputCode}>{plan?.rawPlan || planDraft || 'No plan generated yet.'}</pre>
                    )}
                    {renderTodoList(["widget", "column", "filter", "agent"])}
                </div>
            );
        }

        if (activeOutputTab === 'sql') {
            return (
                <div className={styles.outputBody}>
                    {pipelineStageLogs.sql.length > 0 && (
                        <div className={styles.outputLog}>
                            {pipelineStageLogs.sql.slice(-12).map((line, idx) => (
                                <div key={`log-sql-${idx}`} className={styles.outputLogLine}>{line}</div>
                            ))}
                        </div>
                    )}
                    {queries.length > 0 ? (
                        <div className={styles.outputList}>
                            {queries.map((q: any) => (
                                <div key={q.id} className={styles.outputItem}>
                                    <div className={styles.outputItemHeader}>
                                        <span>{q.title || q.id}</span>
                                        <span className={styles.outputPill}>{q.id}</span>
                                    </div>
                                    <textarea
                                        className={styles.outputEditor}
                                        value={sqlDrafts[q.id] ?? q.sql}
                                        onChange={(e) => setSqlDrafts((prev) => ({ ...prev, [q.id]: e.target.value }))}
                                    />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <span className={styles.outputEmpty}>No SQL generated yet.</span>
                    )}
                    {renderTodoList(["sql", "agent"])}
                </div>
            );
        }

        if (activeOutputTab === 'execute') {
            return (
                <div className={styles.outputBody}>
                    {pipelineStageLogs.execute.length > 0 && (
                        <div className={styles.outputLog}>
                            {pipelineStageLogs.execute.slice(-12).map((line, idx) => (
                                <div key={`log-exec-${idx}`} className={styles.outputLogLine}>{line}</div>
                            ))}
                        </div>
                    )}
                    {executionSummary.length > 0 ? (
                        <div className={styles.outputList}>
                            {executionSummary.map((res: any) => (
                                <div key={res.id} className={styles.outputItem}>
                                    <div className={styles.outputItemHeader}>
                                        <span>{res.title || res.id}</span>
                                        <span className={styles.outputPill}>{res.status || (res.error ? 'error' : 'success')}</span>
                                    </div>
                                    <pre className={styles.outputCode}>
                                        {res.error ? `Error: ${res.error}` : `Rows: ${res.data?.length || 0}`}
                                    </pre>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <span className={styles.outputEmpty}>No execution results yet.</span>
                    )}
                </div>
            );
        }

        return (
            <div className={styles.outputBody}>
                {pipelineStageLogs.dashboard.length > 0 && (
                    <div className={styles.outputLog}>
                        {pipelineStageLogs.dashboard.slice(-12).map((line, idx) => (
                            <div key={`log-dash-${idx}`} className={styles.outputLogLine}>{line}</div>
                        ))}
                    </div>
                )}
                <div className={styles.outputMeta}>
                    <span>Dashboard: {dashboardConfig?.name || '—'}</span>
                    <span>Widgets: {dashboardConfig?.widgets?.length || 0}</span>
                </div>
                <pre className={styles.outputCode}>
                    {dashboardConfig ? JSON.stringify(dashboardConfig, null, 2) : 'Dashboard not assembled yet.'}
                </pre>
            </div>
        );
    };

    // ─── Q&A Result Renderer ───
    const renderQAResult = (qa: QAResult) => {
        if (qa.error) {
            return (
                <div className={styles.qaResult}>
                    <div className={styles.qaError}>
                        <AlertCircle size={16} />
                        <span>{qa.error}</span>
                    </div>
                    {qa.sql && (
                        <div className={styles.qaSqlBlock}>
                            <div className={styles.qaSqlHeader}>
                                <Database size={14} />
                                <span>Generated SQL</span>
                            </div>
                            <pre className={styles.qaSqlCode}>{qa.sql}</pre>
                        </div>
                    )}
                </div>
            );
        }
        const humanizeCol = (col: string) =>
            col.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

        const formatCell = (val: any): string => {
            if (val == null) return "—";
            if (typeof val === "number") return val.toLocaleString();
            const s = String(val);
            // ISO date-like: format nicely
            if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(s)) {
                try {
                    return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
                } catch { return s; }
            }
            return s;
        };

        return (
            <div className={styles.qaResult}>
                <div className={styles.qaStats}>
                    <span className={styles.qaStat}>
                        <Table2 size={14} />
                        {qa.rowCount.toLocaleString()} row{qa.rowCount !== 1 ? "s" : ""}
                    </span>
                    <span className={styles.qaStat}>
                        <Database size={14} />
                        {qa.columns.length} col{qa.columns.length !== 1 ? "s" : ""}
                    </span>
                    {qa.repaired && (
                        <span className={styles.qaStatRepaired}>
                            <CheckCircle2 size={14} />
                            Auto-repaired
                        </span>
                    )}
                </div>
                {qa.data.length > 0 && (
                    <div className={styles.qaTableWrapper}>
                        <table className={styles.qaTable}>
                            <thead>
                                <tr>
                                    {qa.columns.map((col, i) => (
                                        <th key={i}>{humanizeCol(col)}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {qa.data.slice(0, 20).map((row, ri) => (
                                    <tr key={ri}>
                                        {qa.columns.map((col, ci) => (
                                            <td key={ci}>{formatCell(row[col])}</td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {qa.data.length > 20 && (
                            <div className={styles.qaTableMore}>
                                Showing 20 of {qa.rowCount.toLocaleString()} rows
                            </div>
                        )}
                    </div>
                )}
                <details className={styles.qaSqlDetails}>
                    <summary className={styles.qaSqlSummary}>
                        <Database size={14} />
                        <span>View SQL</span>
                    </summary>
                    <pre className={styles.qaSqlCode}>{qa.sql}</pre>
                </details>
            </div>
        );
    };

    // ─── Report Result Renderer ───
    const renderReportResult = (report: ReportResult) => {
        const humanizeCol = (col: string) =>
            col.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());

        const formatCell = (val: any): string => {
            if (val == null) return "—";
            if (typeof val === "number") return val.toLocaleString();
            const s = String(val);
            if (/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(s)) {
                try { return new Date(s).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); }
                catch { return s; }
            }
            return s;
        };

        const isKpiSection = (section: ReportSection) =>
            section.data.length === 1 && section.columns.length <= 4;

        return (
            <div className={styles.reportResult}>
                <div className={styles.reportHeader}>
                    <FileText size={20} />
                    <div>
                        <h3 className={styles.reportTitle}>{report.title}</h3>
                        <span className={styles.reportDate}>
                            {new Date(report.generatedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                    </div>
                </div>

                {report.insights && report.insights.length > 0 && (
                    <div className={styles.reportInsights}>
                        <h4><TrendingUp size={16} /> Key Insights</h4>
                        <ul>
                            {report.insights.map((insight, i) => (
                                <li key={i}>{insight}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {report.sections && report.sections.length > 0 && (
                    <div className={styles.reportSections}>
                        {report.sections.map((section) => {
                            const isExpanded = expandedSections.has(section.id);
                            const isKpi = isKpiSection(section);
                            return (
                                <div key={section.id} className={styles.reportSection}>
                                    <button
                                        className={styles.reportSectionHeader}
                                        onClick={() => {
                                            setExpandedSections(prev => {
                                                const next = new Set(prev);
                                                if (next.has(section.id)) next.delete(section.id);
                                                else next.add(section.id);
                                                return next;
                                            });
                                        }}
                                    >
                                        <div className={styles.reportSectionTitle}>
                                            <ChevronRight
                                                size={16}
                                                className={isExpanded ? styles.reportChevronOpen : ''}
                                            />
                                            <span>{section.title}</span>
                                            <span className={styles.reportSectionBadge}>
                                                {section.error ? 'Error' : `${section.rowCount.toLocaleString()} rows`}
                                            </span>
                                        </div>
                                        <span className={styles.reportSectionDesc}>{section.description}</span>
                                    </button>
                                    {isExpanded && (
                                        <div className={styles.reportSectionBody}>
                                            {section.narrative && (
                                                <div className={styles.reportSectionNarrative}>
                                                    {section.narrative}
                                                </div>
                                            )}
                                            {section.error ? (
                                                <div className={styles.qaError}>
                                                    <AlertCircle size={14} />
                                                    <span>{section.error}</span>
                                                </div>
                                            ) : isKpi && section.data.length > 0 ? (
                                                <div className={styles.reportKpiGrid}>
                                                    {section.columns.map((col, i) => (
                                                        <div key={i} className={styles.reportKpiCard}>
                                                            <span className={styles.reportKpiLabel}>{humanizeCol(col)}</span>
                                                            <span className={styles.reportKpiValue}>{formatCell(section.data[0][col])}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : section.data.length > 0 ? (
                                                <div className={styles.qaTableWrapper}>
                                                    <table className={styles.qaTable}>
                                                        <thead>
                                                            <tr>
                                                                {section.columns.map((col, i) => (
                                                                    <th key={i}>{humanizeCol(col)}</th>
                                                                ))}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {section.data.slice(0, 25).map((row, ri) => (
                                                                <tr key={ri}>
                                                                    {section.columns.map((col, ci) => (
                                                                        <td key={ci}>{formatCell(row[col])}</td>
                                                                    ))}
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                    {section.data.length > 25 && (
                                                        <div className={styles.qaTableMore}>
                                                            Showing 25 of {section.rowCount.toLocaleString()} rows
                                                        </div>
                                                    )}
                                                </div>
                                            ) : (
                                                <span className={styles.outputEmpty}>No data returned</span>
                                            )}
                                            <details className={styles.qaSqlDetails}>
                                                <summary className={styles.qaSqlSummary}>
                                                    <Database size={14} />
                                                    <span>View SQL</span>
                                                </summary>
                                                <pre className={styles.qaSqlCode}>{section.sql}</pre>
                                            </details>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}

                {report.recommendation && (
                    <div className={styles.reportRecommendation}>
                        <h4>Next Steps</h4>
                        <p>{report.recommendation}</p>
                    </div>
                )}
            </div>
        );
    };

    const isAnyLoading = isPipelineRunning || isStreaming || qaLoading || reportLoading;
    const activeSuggestions = SUGGESTION_CHIPS[chatMode];
    const modeColor = MODE_CONFIG[chatMode].color;

    return (
        <div className={styles.container}>
            {/* Header */}
            <div className={styles.header}>
                <div className={styles.headerTitle}>
                    <Sparkles className={styles.icon} size={20} />
                    <span>AI Assistant</span>
                </div>
                <div className={styles.headerActions}>
                    <button
                        className={styles.historyButton}
                        onClick={() => setShowHistory(!showHistory)}
                        title="Query History"
                    >
                        <History size={18} />
                    </button>
                    {onCollapse && (
                        <button
                            className={styles.historyButton}
                            onClick={onCollapse}
                            title="Collapse Copilot"
                        >
                            <ChevronLeft size={18} />
                        </button>
                    )}
                </div>
            </div>

            {/* ─── Mode Selector ─── */}
            <div className={styles.modeSelector}>
                {(Object.keys(MODE_CONFIG) as ChatMode[]).map((mode) => {
                    const cfg = MODE_CONFIG[mode];
                    const Icon = cfg.icon;
                    const isActive = chatMode === mode;
                    return (
                        <button
                            key={mode}
                            className={`${styles.modeButton} ${isActive ? styles.modeButtonActive : ''}`}
                            style={isActive ? { borderColor: cfg.color, background: `${cfg.color}18` } : {}}
                            onClick={() => setChatMode(mode)}
                            disabled={isAnyLoading}
                            title={cfg.description}
                        >
                            <Icon size={16} style={isActive ? { color: cfg.color } : {}} />
                            <span style={isActive ? { color: cfg.color } : {}}>{cfg.label}</span>
                        </button>
                    );
                })}
            </div>

            {/* History Panel */}
            <AnimatePresence>
                {showHistory && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className={styles.historyPanel}
                    >
                        <div className={styles.historyHeader}>
                            <span>Recent Queries</span>
                            <button onClick={() => setShowHistory(false)}>
                                <X size={16} />
                            </button>
                        </div>
                        <div className={styles.historyList}>
                            {recentQueries.slice(0, 10).map((item, i) => (
                                <button
                                    key={i}
                                    className={styles.historyItem}
                                    onClick={() => handleHistoryClick(item.query)}
                                >
                                    {item.query}
                                </button>
                            ))}
                            {recentQueries.length === 0 && (
                                <p className={styles.emptyHistory}>No recent queries</p>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Messages */}
            <div className={styles.messages}>
                {messages.map((msg) => (
                    <motion.div
                        key={msg.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`${styles.message} ${styles[msg.type]}`}
                    >
                        {msg.content}
                        {msg.qaResult && renderQAResult(msg.qaResult)}
                        {msg.reportResult && renderReportResult(msg.reportResult)}
                    </motion.div>
                ))}

                {/* Follow-up suggestions after AI response */}
                <AnimatePresence>
                    {followUpSuggestions.length > 0 && !isAnyLoading && (
                        <motion.div
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0 }}
                            className={styles.followUpArea}
                        >
                            <span className={styles.followUpLabel}>You might also ask:</span>
                            <div className={styles.followUpChips}>
                                {followUpSuggestions.map((s, i) => (
                                    <button
                                        key={i}
                                        className={styles.followUpChip}
                                        onClick={() => { setInput(s); inputRef.current?.focus(); }}
                                    >
                                        {s}
                                    </button>
                                ))}
                            </div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Agent Timeline — dashboard mode only */}
                {chatMode === 'dashboard' && (isStreaming || steps.length > 0) && (
                    <div className={styles.timelineContainer}>
                        <AgentTimeline
                            steps={steps}
                            isStreaming={isStreaming}
                            onStepSelect={(step) => {
                                const message = (step.message || "").toLowerCase();
                                if (step.step === "sql") {
                                    setActiveOutputTab('sql');
                                    setShowPipelineOutput(true);
                                    setCurrentView("build");
                                    setStep(3);
                                    return;
                                }
                                if (step.step === "execute" || step.step === "qa") {
                                    setActiveOutputTab('execute');
                                    setShowPipelineOutput(true);
                                    setCurrentView("build");
                                    setStep(4);
                                    return;
                                }
                                if (step.step === "viz" || step.step === "narrative") {
                                    setActiveOutputTab('dashboard');
                                    setShowPipelineOutput(true);
                                    setCurrentView("build");
                                    setStep(5);
                                    return;
                                }
                                if (step.step === "plan") {
                                    if (message.includes("schema")) {
                                        setActiveOutputTab('schema');
                                        setShowPipelineOutput(true);
                                        setCurrentView("schema");
                                        return;
                                    }
                                    setActiveOutputTab('plan');
                                    setShowPipelineOutput(true);
                                    setCurrentView("build");
                                    setStep(2);
                                    return;
                                }
                                setCurrentView("build");
                            }}
                        />
                    </div>
                )}

                {chatMode === 'dashboard' && (steps.length > 0 || isStreaming) && (
                    <div className={styles.outputPanel}>
                        <div className={styles.outputHeader}>
                            <span>Pipeline Output</span>
                            <div className={styles.outputActions}>
                                {activeOutputTab === 'plan' && (
                                    <>
                                        <button
                                            type="button"
                                            className={styles.outputAction}
                                            onClick={() => setIsEditingPlan((prev) => !prev)}
                                        >
                                            {isEditingPlan ? 'Preview' : 'Edit'}
                                        </button>
                                        {awaitingSqlContinue ? (
                                            <button
                                                type="button"
                                                className={styles.outputActionPrimary}
                                                onClick={() => continueToSql()}
                                            >
                                                Continue to SQL
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                className={styles.outputActionPrimary}
                                                onClick={() => rerunFromPlan()}
                                            >
                                                Rerun from plan
                                            </button>
                                        )}
                                    </>
                                )}
                                {activeOutputTab === 'sql' && (
                                    <>
                                        {awaitingExecutionApprove ? (
                                            <button
                                                type="button"
                                                className={styles.outputActionPrimary}
                                                onClick={() => approveAndExecute()}
                                            >
                                                Run Queries
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                className={styles.outputActionPrimary}
                                                onClick={() => rerunFromSql()}
                                            >
                                                Rerun SQL
                                            </button>
                                        )}
                                    </>
                                )}
                                <button
                                    type="button"
                                    className={styles.outputToggle}
                                    onClick={() => setShowPipelineOutput((prev) => !prev)}
                                >
                                    {showPipelineOutput ? 'Hide' : 'Show'}
                                </button>
                            </div>
                        </div>
                        {showPipelineOutput && (
                            <>
                                <div className={styles.outputTabs}>
                                    {(['schema', 'plan', 'sql', 'execute', 'dashboard'] as const).map((tab) => (
                                        <button
                                            key={tab}
                                            type="button"
                                            className={`${styles.outputTab} ${activeOutputTab === tab ? styles.outputTabActive : ''}`}
                                            onClick={() => setActiveOutputTab(tab)}
                                        >
                                            {tab}
                                        </button>
                                    ))}
                                </div>
                                <div className={styles.livePanelHeader}>
                                    <span className={styles.livePanelTitle}>Live Stream</span>
                                    <button
                                        type="button"
                                        className={styles.liveToggle}
                                        onClick={() => setShowLivePanel((prev) => !prev)}
                                    >
                                        {showLivePanel ? 'Hide' : 'Show'}
                                    </button>
                                </div>
                                {showLivePanel && (
                                    <div className={styles.livePanel}>
                                        {([
                                            { key: "schema", label: "Schema", empty: "Waiting for schema…" },
                                            { key: "plan", label: "Plan", empty: "Waiting for planner…" },
                                            { key: "sql", label: "SQL", empty: "Waiting for SQL…" },
                                            { key: "execute", label: "Executor", empty: "Waiting for execution…" },
                                            { key: "dashboard", label: "Dashboard", empty: "Waiting for widgets…" },
                                        ] as Array<{ key: PipelineStage; label: string; empty: string }>).map((section) => {
                                            const items = pipelineStageLogs[section.key] || [];
                                            const latest = items.length > 0 ? items[items.length - 1] : "";
                                            const relatedStep = (() => {
                                                if (section.key === "schema") {
                                                    return [...steps].reverse().find((s) => s.step === "schema" || s.step === "kpi");
                                                }
                                                if (section.key === "dashboard") {
                                                    return [...steps].reverse().find((s) => s.step === "viz" || s.step === "narrative");
                                                }
                                                return [...steps].reverse().find((s) => s.step === section.key);
                                            })();
                                            const relatedStatus = String(relatedStep?.status || "");
                                            const statusText = relatedStatus
                                                ? `${relatedStatus.toUpperCase()}${relatedStep?.message ? `: ${relatedStep.message}` : ""}`
                                                : section.empty;
                                            return (
                                                <div key={section.key} className={styles.liveColumn}>
                                                    <div className={styles.liveTitleRow}>
                                                        <div className={styles.liveTitle}>{section.label}</div>
                                                        <span className={styles.liveCount}>
                                                            {relatedStatus || items.length}
                                                        </span>
                                                    </div>
                                                    {latest ? <div className={styles.liveLatest}>{latest}</div> : <div className={styles.liveEmpty}>{statusText}</div>}
                                                    <div className={styles.liveLines}>
                                                        {items.slice(-6).map((line, idx) => (
                                                            <div key={`${section.key}-log-${idx}`} className={styles.liveLine}>{line}</div>
                                                        ))}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                                {renderPipelineOutput()}
                            </>
                        )}
                    </div>
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Suggestions */}
            <AnimatePresence>
                {showSuggestions && !messages.some((m) => m.type === "user") && (
                    <motion.div
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className={styles.suggestions}
                    >
                        <div className={styles.suggestionsHeader}>
                            <Lightbulb size={16} />
                            <span>Try asking ({MODE_CONFIG[chatMode].label})</span>
                        </div>
                        <div className={styles.chips}>
                            {activeSuggestions.slice(0, 4).map((suggestion, i) => (
                                <button
                                    key={i}
                                    className={styles.chip}
                                    onClick={() => handleSuggestionClick(suggestion)}
                                >
                                    {suggestion}
                                </button>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Input */}
            <div className={styles.inputArea}>
                <div className={styles.inputWrapper}>
                    <input
                        ref={inputRef}
                        type="text"
                        className={styles.input}
                        placeholder={chatMode === 'dashboard' ? 'Describe the dashboard you want...' : chatMode === 'chat' ? 'Ask a question about your data...' : 'What report should I generate?'}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={handleKeyDown}
                        disabled={isAnyLoading}
                    />
                    <button
                        className={styles.sendButton}
                        onClick={handleSend}
                        disabled={!input.trim() || isAnyLoading}
                        style={{ background: modeColor }}
                    >
                        {isAnyLoading ? (
                            <div className={styles.spinner} />
                        ) : (
                            <Send size={18} />
                        )}
                    </button>
                </div>

                <div className={styles.connectorBar}>
                    <div className={styles.connectorHeader}>
                        <span className={styles.connectorLabel}>Connector</span>
                        <button
                            type="button"
                            className={styles.connectorToggle}
                            onClick={() => setShowConnectorPicker((prev) => !prev)}
                        >
                            {showConnectorPicker ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                    </div>
                    {showConnectorPicker && (
                        <>
                            <div className={styles.connectorList}>
                                {connectors.length > 0 ? (
                                    connectors.map((ds) => {
                                        const isActive = ds.id === selectedDataSourceId;
                                        return (
                                            <button
                                                key={ds.id}
                                                type="button"
                                                className={`${styles.connectorButton} ${isActive ? styles.connectorButtonActive : ""}`}
                                                onClick={() => handleSelectConnector(ds)}
                                            >
                                                <span className={styles.connectorName}>{ds.name || ds.type}</span>
                                                <span className={styles.connectorType}>{ds.type?.toUpperCase() || "CONNECTOR"}</span>
                                            </button>
                                        );
                                    })
                                ) : (
                                    <span className={styles.connectorEmpty}>No connectors found</span>
                                )}
                            </div>
                            {connectors.length > 0 && (
                                <span className={styles.connectorHint}>
                                    SQL syntax follows {selectedConnector?.type || "selected"} connector.
                                </span>
                            )}
                        </>
                    )}
                </div>

                {chatMode === 'dashboard' && isStreaming && (
                    <div className={styles.connectionStatus}>
                        <span className={styles.statusDot} />
                        <span>Running</span>
                    </div>
                )}
            </div>
        </div>
    );
}

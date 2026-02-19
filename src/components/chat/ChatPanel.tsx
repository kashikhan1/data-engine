"use client";

import React, { useState, useRef, useEffect, useMemo } from "react";
import { Send, Sparkles, Lightbulb, History, X, ChevronLeft, ChevronDown, ChevronUp, LayoutDashboard, MessageSquare, FileBarChart, Database, Table2, AlertCircle, CheckCircle2, Loader2, FileText, TrendingUp, ChevronRight } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useRunStore, useDashboardStore, useConfigStore, useWorkflowStore, useUIStore } from "@/state/stores";
import { runQueryExecutor, assembleFinalDashboard, runNarrativeGenerator, repairFailedQuery } from "@/lib/agents/nodes";
import { runSchemaDiscovery } from "@/lib/agents/schema-discovery";
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
    humanReadableSummary?: string;
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
}

interface ReportResult {
    title: string;
    summary: string;
    keyMetrics?: Array<{ name: string; value: string; context: string }>;
    insights: string[];
    trends?: Array<{ description: string; significance: string }>;
    anomalies?: string[];
    recommendation?: string;
    recommendations?: string[];
    risks?: string[];
    sections: ReportSection[];
    generatedAt: string;
    question: string;
}

const SUGGESTION_CHIPS: Record<ChatMode, string[]> = {
    dashboard: [
        "Show revenue by country for last month",
        "Weekly active users trend",
        "Top 10 products by sales",
        "Customer retention cohort analysis",
        "Compare Q3 vs Q4 revenue",
    ],
    chat: [
        "How many orders were placed today?",
        "What are the top 5 customers by revenue?",
        "Show all products with low stock",
        "Average order value per category",
        "List recent transactions",
    ],
    report: [
        "Monthly sales performance report",
        "Customer acquisition analysis",
        "Inventory health overview",
        "Revenue breakdown by region and product",
        "User engagement summary for this quarter",
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

    const inputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const { isStreaming, steps, error: runError, startRun, handleEvent, endRun } = useRunStore();
    const { recentQueries, addToRecentQueries, activeFilters, filtersActivated, setDashboard, dashboard } = useDashboardStore();
    const {
        schemaData,
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
        reset: resetWorkflow,
        setProcessing,
        isProcessing,
        currentStep,
        staleStep,
        setError,
        setStaleStep,
        addSqlError,
        sqlErrorLog
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
    const [pipelineLogs, setPipelineLogs] = useState<string[]>([]);
    const [pipelineStageLogs, setPipelineStageLogs] = useState<{
        sql: string[];
        execute: string[];
        dashboard: string[];
    }>({ sql: [], execute: [], dashboard: [] });
    const [showLivePanel, setShowLivePanel] = useState(true);
    const autoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const autoRefreshInFlightRef = useRef(false);
    const connectors = (dataSources || []).filter((ds) => {
        const type = ds.type?.toLowerCase() || "";
        return type.includes("mcp") || type.includes("postgres") || type.includes("mssql");
    });
    const selectedConnector = connectors.find((ds) => ds.id === selectedDataSourceId) || null;
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
        const startedAt = new Date().toISOString();
        startRun(runId);
        setAwaitingSqlContinue(false);
        setPipelineLogs([]);
        setPipelineStageLogs({ sql: [], execute: [], dashboard: [] });
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
                setPipelineLogs((prev) => [...prev, `${String(step).toUpperCase()} [${String(status).toUpperCase()}] ${message}`]);
                const stage =
                    step === "sql" ? "sql"
                        : step === "execute" ? "execute"
                            : (step === "viz" || step === "narrative") ? "dashboard"
                                : null;
                if (stage) {
                    setPipelineStageLogs((prev) => ({
                        ...prev,
                        [stage]: [...prev[stage as "sql" | "execute" | "dashboard"], `${String(status).toUpperCase()}: ${message}`]
                    }));
                }
            }
        };

        try {
            // Step 1: Schema discovery
            sendStep("schema", "running", "Schema discovery");
            let resolvedSchema = schemaData;
            if (!resolvedSchema) {
                const tryDiscover = async (attempts: number) => {
                    let lastError: any = null;
                    for (let i = 0; i < attempts; i++) {
                        try {
                            const storedTablesRaw = localStorage.getItem('schema_selected_tables');
                            const allowedTables = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
                            if (allowedTables.length > 0 && resolvedConnectionString) {
                                const data = await runSchemaDiscovery(resolvedConnectionString, {
                                    enableSemanticSearch: false,
                                    enableTableKpis: true,
                                    enableTableMatrix: true,
                                    enableTableFilters: true,
                                    projectContext
                                }, allowedTables);
                                if (data?.tables && data.tables.length > 0) return data;
                                lastError = new Error("Schema discovery returned no tables.");
                            }
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
                        if (data.chunk) {
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
                                widgets: []
                            });
                        }
                    } catch {
                        // ignore malformed chunks
                    }
                }
            }
            const { extractDashboardTitle, parseNaturalLanguagePlan } = await import('@/utils/plan-parser');
            const cleanedPlanText = planText.split("EVENT_STREAM:")[0]?.trim() || planText.trim();
            const allowedTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
            (disabledWidgetTypes || []).forEach((t) => allowedTypes.delete(t));
            const buildFilteredPlanText = (title: string, widgets: any[]) => {
                const lines: string[] = [];
                lines.push(`DASHBOARD TITLE: ${title || "AI Analytics Dashboard"}`);
                lines.push("PURPOSE: Auto-generated plan based on enabled widget types.");
                lines.push("");
                lines.push("FILTERS TO INCLUDE:");
                lines.push("1) None");
                lines.push("");
                widgets.forEach((w: any, idx: number) => {
                    const widgetTitle = String(w?.title || `Widget ${idx + 1}`).trim();
                    const widgetType = String(w?.type || "chart").trim();
                    const goal = String(w?.goal || "Visualization").trim();
                    lines.push(`WIDGET ${idx + 1}: ${widgetType} - ${widgetTitle}`);
                    lines.push(`Shows: ${goal}`);
                    lines.push("Why: Enabled widget type per settings.");
                    lines.push("Uses: Not specified.");
                    lines.push("Filters applied: None.");
                    lines.push("Notes: Filtered to enabled widget types.");
                    lines.push("");
                });
                return lines.join("\n").trim();
            };
            const parsedWidgets = parseNaturalLanguagePlan(cleanedPlanText).filter((w: any) => allowedTypes.has(w?.type));
            const title = extractDashboardTitle(cleanedPlanText) || "AI Analytics Dashboard";
            const normalizedPlanText = (disabledWidgetTypes || []).length > 0
                ? buildFilteredPlanText(title, parsedWidgets)
                : cleanedPlanText;
            const finalizedPlan = {
                title,
                rawPlan: plannerAgents
                    ? `${normalizedPlanText}\n\nEVENT_STREAM:\n{"type":"planner_agents","content":"${plannerAgents}"}`
                    : normalizedPlanText,
                widgets: parsedWidgets,
                plannerAgents
            };
            setAiPlan(finalizedPlan);
            setUserPlan(finalizedPlan);
            sendStep("plan", "done", "Plan ready");
            setAwaitingSqlContinue(false);
            setActiveOutputTab('plan');
            setShowPipelineOutput(true);
            setCurrentView("build");

            // Step 3: SQL generation
            setStep(3);
            sendStep("sql", "running", "Generating SQL");
            const sqlResponse = await fetch('/api/sql/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    plan: finalizedPlan,
                    schema: resolvedSchema,
                    filters: Object.fromEntries(activeFilters),
                    applyFilters: filtersActivated,
                    errorLog: sqlErrorLog,
                    connectorInstructions: resolvedConnectorInstructions,
                    connectorType: resolvedConnectorType,
                    connectionString: resolvedConnectionString
                })
            });
            if (!sqlResponse.ok) {
                throw new Error("SQL generator connection failed.");
            }
            const sqlBody = sqlResponse.body;
            if (!sqlBody) {
                throw new Error("SQL generator stream not available.");
            }
            const sqlReader = sqlBody!.getReader();
            const sqlDecoder = new TextDecoder();
            let sqlBuffer = '';
            let finalQueries: Record<string, string> | null = null;
            while (true) {
                const { done, value } = await sqlReader.read();
                if (done) break;
                sqlBuffer += sqlDecoder.decode(value, { stream: true });
                const lines = sqlBuffer.split('\n');
                sqlBuffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    try {
                        const payload = JSON.parse(trimmed.slice(5).trim());
                        if (payload.status === 'error') {
                            throw new Error(payload.message || 'SQL generation failed.');
                        }
                        if (payload.status === 'completed' && payload.queries) {
                            finalQueries = payload.queries;
                        }
                    } catch {
                        // ignore malformed chunks
                    }
                }
            }
            if (!finalQueries) {
                throw new Error("SQL generation returned no queries.");
            }
            const finalQueryMap = finalQueries || {};
            const queryList = Object.entries(finalQueryMap).map(([id, sql]) => ({
                id,
                sql: sql as string,
                title: finalizedPlan.widgets?.find((w: any) => w.id === id)?.title || id
            }));
            setAiQueries(queryList);
            setUserQueries(queryList);
            sendStep("sql", "done", "SQL ready");

            // Step 4: Execute
            setStep(4);
            sendStep("execute", "running", "Executing queries");
            const execQueryMap: Record<string, string> = {};
            queryList.forEach((q) => {
                execQueryMap[q.id] = q.sql;
            });
            const initialExecContext = buildExecutionContext(((finalizedPlan as any).filters) || [], finalizedPlan.widgets || []);
            const execResults = await runQueryExecutor(execQueryMap, resolvedConnectionString, {
                connectorInstructions: resolvedConnectorInstructions,
                connectorType: resolvedConnectorType,
                tablePagination: initialExecContext.tablePagination,
                runtimeParams: initialExecContext.runtimeParams
            });
            const resultsList = Object.entries(execResults).map(([id, result]: [string, any]) => ({
                id,
                ...result,
                title: queryList.find((q) => q.id === id)?.title || id
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
            sendStep("execute", "done", "Execution complete");

            // Step 5: Assemble dashboard
            setStep(5);
            sendStep("viz", "running", "Assembling dashboard");
            let insights: string[] = [];
            try {
                insights = await runNarrativeGenerator(resultsList as any[]);
                sendStep("narrative", "done", "Insights ready");
            } catch {
                insights = ["Data retrieval successful. Full analysis ready for inspection."];
            }
            const finalDashboard = await assembleFinalDashboard(finalizedPlan, queryList as any[], resultsList as any[], insights, resolvedSchema?.filterCandidates);
            setDashboardConfig(finalDashboard);
            handleEvent({
                type: "partial_dashboard",
                dashboard: finalDashboard,
                ts: new Date().toISOString()
            } as any);

            handleEvent({
                type: "final",
                envelope: {
                    runId,
                    status: "completed",
                    dashboard: finalDashboard,
                    startedAt,
                    completedAt: new Date().toISOString(),
                    error: ""
                },
                ts: new Date().toISOString()
            } as any);
            endRun(true);
            sendStep("viz", "done", "Dashboard ready");
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
                    schema: resolvedSchema,
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
                                humanReadableSummary: payload.humanReadableSummary || ''
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
                const displayContent = result.humanReadableSummary 
                    ? result.humanReadableSummary 
                    : `✅ Query returned ${result!.rowCount} rows`;
                setMessages(prev => [...prev, {
                    id: `qa-${Date.now()}`,
                    type: "ai",
                    content: displayContent,
                    timestamp: new Date().toISOString(),
                    qaResult: result
                }]);
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
                    schema: resolvedSchema,
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
                setMessages(prev => [...prev, {
                    id: `report-${Date.now()}`,
                    type: "ai",
                    content: `📊 Report: ${report!.title}`,
                    timestamp: new Date().toISOString(),
                    reportResult: report
                }]);
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

    const ensureSchema = async () => {
        const tryDiscover = async (attempts: number) => {
            let lastError: any = null;
            for (let i = 0; i < attempts; i++) {
                try {
                    const storedTablesRaw = localStorage.getItem('schema_selected_tables');
                    const allowedTables = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
                    if (allowedTables.length > 0 && resolvedConnectionString) {
                        const data = await runSchemaDiscovery(resolvedConnectionString, {
                            enableSemanticSearch: false,
                            enableTableKpis: true,
                            enableTableMatrix: true,
                            enableTableFilters: true,
                            projectContext
                        }, allowedTables);
                        if (data?.tables && data.tables.length > 0) return data;
                        lastError = new Error("Schema discovery returned no tables.");
                    }
                } catch (err: any) {
                    lastError = err;
                }
            }
            throw lastError || new Error("Schema discovery failed.");
        };
        if (schemaData) return schemaData;
        try {
            const data = await tryDiscover(3);
            setSchemaData(data);
            return data;
        } catch (err: any) {
            // continue to manual fallback
        }
        const manual = loadManualSchema();
        if (manual) {
            setSchemaData(manual);
            return manual;
        }
        throw new Error("No schema selected or found.");
    };

    const generateSql = async (planToUse: any, schemaToUse: any) => {
        const response = await fetch('/api/sql/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                plan: planToUse,
                schema: schemaToUse,
                connectorInstructions: resolvedConnectorInstructions,
                connectorType: resolvedConnectorType,
                connectionString: resolvedConnectionString,
                filters: Object.fromEntries(activeFilters),
                applyFilters: filtersActivated,
                errorLog: sqlErrorLog
            })
        });
        if (!response.ok || !response.body) {
            throw new Error("SQL generator connection failed.");
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let finalQueries: Record<string, string> | null = null;
        const streamMap: Record<string, string> = {};
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;
                const payload = JSON.parse(trimmed.slice(5).trim());
                if (payload.status === 'error') {
                    throw new Error(payload.message || 'SQL generation failed.');
                }
                if (payload.status === 'query' && payload.id && payload.sql) {
                    streamMap[payload.id] = payload.sql;
                    const streamedList = Object.entries(streamMap).map(([id, sql]) => ({
                        id,
                        sql,
                        title: planToUse.widgets?.find((w: any) => w.id === id)?.title || id
                    }));
                    setAiQueries(streamedList);
                    setUserQueries(streamedList);
                }
                if (payload.status === 'completed' && payload.queries) {
                    finalQueries = payload.queries;
                }
            }
        }
        if (!finalQueries) {
            throw new Error("SQL generation returned no queries.");
        }
        return Object.entries(finalQueries).map(([id, sql]) => ({
            id,
            sql: sql as string,
            title: planToUse.widgets?.find((w: any) => w.id === id)?.title || id
        }));
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
        const finalDashboard = await assembleFinalDashboard(planToUse, queryList as any[], resultsList as any[], insights, schemaToUse?.filterCandidates);
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
        sendStep?: (step: any, status: any, message?: string) => void
    ) => {
        setStep(3);
        sendStep?.("sql", "running", "Generating SQL");
        setActiveOutputTab('sql');
        setShowPipelineOutput(true);
        setPipelineLogs([]);
        setPipelineStageLogs({ sql: [], execute: [], dashboard: [] });

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
                connectionString: resolvedConnectionString
            })
        });
        if (!response.ok || !response.body) {
            throw new Error("SQL generator connection failed.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const queryMap: Record<string, string> = {};
        const resultsMap: Record<string, any> = {};
        const inflight = new Map<string, Promise<any>>();
        let executeStarted = false;
        let dashboardStarted = false;

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
            const partial = await assembleFinalDashboard(planToUse, queryList, resultsList, [], schemaToUse?.filterCandidates);
            setDashboardConfig(partial);
            handleEvent({
                type: "partial_dashboard",
                dashboard: partial,
                ts: new Date().toISOString()
            } as any);
        };

        const normalizeSqlForValidation = (sql: string) => {
            let text = String(sql || '');
            if (!text) return '';
            text = text.replace(/^\uFEFF/, '');
            text = text.replace(/```/g, '');
            text = text.replace(/^\s*sql\s*:/i, '');
            text = text.trimStart();
            while (text.startsWith('--') || text.startsWith('#') || text.startsWith('/*')) {
                if (text.startsWith('--') || text.startsWith('#')) {
                    text = text.replace(/^(--|#)[^\n]*\n?/, '').trimStart();
                    continue;
                }
                if (text.startsWith('/*')) {
                    text = text.replace(/^\/\*[\s\S]*?\*\//, '').trimStart();
                    continue;
                }
                break;
            }
            return text.trim();
        };

        const validateSql = (sql: string) => {
            const trimmed = normalizeSqlForValidation(sql);
            if (!trimmed.toLowerCase().startsWith('select')) {
                return { ok: false, error: 'Validation failed: SQL must start with SELECT.' };
            }
            const isMssql = (() => {
                const lower = String(postgresUrl || "").toLowerCase();
                return lower.startsWith("mssql://") || lower.startsWith("sqlserver://") || lower.includes("server=") || lower.includes("data source=");
            })();
            const blocked = ['drop', 'delete', 'truncate', 'update', 'insert', 'alter'];
            if (blocked.some((kw) => trimmed.toLowerCase().includes(kw))) {
                return { ok: false, error: 'Validation failed: unsafe SQL detected.' };
            }
            if (isMssql && /\blimit\s+\d+/i.test(trimmed)) {
                return { ok: false, error: 'Validation failed: MSSQL does not support LIMIT. Use TOP or OFFSET/FETCH.' };
            }
            if (!isMssql && /\btop\s+\d+/i.test(trimmed)) {
                return { ok: false, error: 'Validation failed: PostgreSQL does not support TOP. Use LIMIT.' };
            }
            return { ok: true };
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
                const payload = JSON.parse(trimmed.slice(5).trim());
                if (payload.status === 'error') {
                    throw new Error(payload.message || 'Widget pipeline failed.');
                }
                const widgetId = payload.widgetId as string | undefined;
                if (payload.status === 'sql_builder_running' && widgetId) {
                    setPipelineLogs((prev) => [...prev, `SQL Builder → ${widgetId} started`]);
                    setPipelineStageLogs((prev) => ({ ...prev, sql: [...prev.sql, `Builder: ${widgetId}`] }));
                }
                if (payload.status === 'sql_builder_done' && widgetId && payload.sql) {
                    queryMap[widgetId] = payload.sql;
                    upsertQueries();
                    setPipelineLogs((prev) => [...prev, `SQL Builder → ${widgetId} done`]);
                    setPipelineStageLogs((prev) => ({ ...prev, sql: [...prev.sql, `Built: ${widgetId}`] }));
                }
                if (payload.status === 'sql_validator_running' && widgetId) {
                    setPipelineLogs((prev) => [...prev, `SQL Validator → ${widgetId} running`]);
                    setPipelineStageLogs((prev) => ({ ...prev, sql: [...prev.sql, `Validate: ${widgetId}`] }));
                }
                if (payload.status === 'sql_validator_fixed' && widgetId && payload.sql) {
                    queryMap[widgetId] = payload.sql;
                    upsertQueries();
                    setPipelineLogs((prev) => [...prev, `SQL Validator → ${widgetId} fixed`]);
                    setPipelineStageLogs((prev) => ({ ...prev, sql: [...prev.sql, `Fixed: ${widgetId}`] }));
                }
                if (payload.status === 'execution_running' && !executeStarted) {
                    executeStarted = true;
                    setStep(4);
                    sendStep?.("execute", "running", "Executing queries");
                }
                if (payload.status === 'execution_running' && widgetId) {
                    setPipelineLogs((prev) => [...prev, `Executor → ${widgetId} running`]);
                    setPipelineStageLogs((prev) => ({ ...prev, execute: [...prev.execute, `Running: ${widgetId}`] }));
                }
                if (payload.status === 'manual_required' && widgetId) {
                    setPipelineLogs((prev) => [...prev, `Manual fix needed → ${widgetId}`]);
                    setPipelineStageLogs((prev) => ({ ...prev, execute: [...prev.execute, `Manual: ${widgetId}`] }));
                }
                if (payload.status === 'execution_done' && widgetId && payload.result) {
                    resultsMap[widgetId] = payload.result;
                    const queryList = upsertQueries();
                    const resultsList = upsertResults(queryList);
                    const task = updateDashboardPartial(queryList, resultsList);
                    inflight.set(widgetId, task);
                    setPipelineLogs((prev) => [...prev, `Executor → ${widgetId} done`]);
                    setPipelineStageLogs((prev) => ({ ...prev, execute: [...prev.execute, `Done: ${widgetId}`] }));
                }
                if (payload.status === 'formatter_done' && widgetId && payload.result) {
                    resultsMap[widgetId] = payload.result;
                    const queryList = upsertQueries();
                    const resultsList = upsertResults(queryList);
                    const task = updateDashboardPartial(queryList, resultsList);
                    inflight.set(widgetId, task);
                    setPipelineLogs((prev) => [...prev, `Formatter → ${widgetId} ready`]);
                    setPipelineStageLogs((prev) => ({ ...prev, dashboard: [...prev.dashboard, `Widget ready: ${widgetId}`] }));
                }
            }
        }

        await Promise.all(Array.from(inflight.values()));
        sendStep?.("execute", "done", "Execution complete");
        setPipelineLogs((prev) => [...prev, "Dashboard → assembling final output"]);
        setPipelineStageLogs((prev) => ({ ...prev, dashboard: [...prev.dashboard, "Assembling dashboard"] }));

        const queryList = upsertQueries();
        const resultsList = upsertResults(queryList);
        let insights: string[] = [];
        try {
            insights = await runNarrativeGenerator(resultsList as any[]);
            sendStep?.("narrative", "done", "Insights ready");
        } catch {
            insights = ["Data retrieval successful. Full analysis ready for inspection."];
        }

        const finalDashboard = await assembleFinalDashboard(planToUse, queryList, resultsList, insights, schemaToUse?.filterCandidates);
        setDashboardConfig(finalDashboard);
        handleEvent({
            type: "partial_dashboard",
            dashboard: finalDashboard,
            ts: new Date().toISOString()
        } as any);
        sendStep?.("viz", "done", "Dashboard ready");
        setPipelineLogs((prev) => [...prev, "Dashboard → ready"]);
        setPipelineStageLogs((prev) => ({ ...prev, dashboard: [...prev.dashboard, "Dashboard ready"] }));
    };

    const rerunFromPlan = async () => {
        const schemaToUse = await ensureSchema();
        if (!schemaToUse) throw new Error("Schema context missing. Please run Schema Discovery first.");
        if (!planDraft.trim()) throw new Error("Plan is empty.");
        const { extractDashboardTitle, parseNaturalLanguagePlan } = await import('@/utils/plan-parser');
        const cleaned = planDraft.split("EVENT_STREAM:")[0]?.trim() || planDraft.trim();
        const nextPlan = {
            title: extractDashboardTitle(cleaned) || plan?.title || "AI Analytics Dashboard",
            rawPlan: cleaned,
            widgets: parseNaturalLanguagePlan(cleaned)
        };
        setAiPlan(nextPlan);
        setUserPlan(nextPlan);
        const runId = `local_continue_${Date.now()}`;
        startRun(runId);
        setAwaitingSqlContinue(false);
        setPipelineLogs([]);
        setPipelineStageLogs({ sql: [], execute: [], dashboard: [] });
        setDashboardConfig(null);
        setDashboard(null);
        setIsPipelineRunning(true);
        setProcessing(true);
        setError(null);
        const sendStep = (step: any, status: any, message?: string) => {
            const ts = new Date().toISOString();
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
                setPipelineLogs((prev) => [...prev, `${String(step).toUpperCase()} [${String(status).toUpperCase()}] ${message}`]);
                const stage =
                    step === "sql" ? "sql"
                        : step === "execute" ? "execute"
                            : (step === "viz" || step === "narrative") ? "dashboard"
                                : null;
                if (stage) {
                    setPipelineStageLogs((prev) => ({
                        ...prev,
                        [stage]: [...prev[stage as "sql" | "execute" | "dashboard"], `${String(status).toUpperCase()}: ${message}`]
                    }));
                }
            }
        };
        try {
            await streamSqlAndExecuteParallel(nextPlan, schemaToUse, sendStep);
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
        await rerunFromPlan();
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

        if (activeOutputTab === 'schema') {
            return (
                <div className={styles.outputBody}>
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
                </div>
            );
        }

        if (activeOutputTab === 'sql') {
            return (
                <div className={styles.outputBody}>
                    {pipelineLogs.length > 0 && (
                        <div className={styles.outputLog}>
                            {pipelineLogs.slice(-8).map((line, idx) => (
                                <div key={`log-${idx}`} className={styles.outputLogLine}>{line}</div>
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
                </div>
            );
        }

        if (activeOutputTab === 'execute') {
            return (
                <div className={styles.outputBody}>
                    {pipelineLogs.length > 0 && (
                        <div className={styles.outputLog}>
                            {pipelineLogs.slice(-8).map((line, idx) => (
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
                {pipelineLogs.length > 0 && (
                    <div className={styles.outputLog}>
                        {pipelineLogs.slice(-8).map((line, idx) => (
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
        return (
            <div className={styles.qaResult}>
                <div className={styles.qaStats}>
                    <span className={styles.qaStat}>
                        <Table2 size={14} />
                        {qa.rowCount} rows
                    </span>
                    <span className={styles.qaStat}>
                        <Database size={14} />
                        {qa.columns.length} columns
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
                                        <th key={i}>{col}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {qa.data.slice(0, 20).map((row, ri) => (
                                    <tr key={ri}>
                                        {qa.columns.map((col, ci) => (
                                            <td key={ci}>{row[col] != null ? String(row[col]) : '—'}</td>
                                        ))}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {qa.data.length > 20 && (
                            <div className={styles.qaTableMore}>
                                Showing 20 of {qa.rowCount} rows
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
        return (
            <div className={styles.reportResult}>
                <div className={styles.reportHeader}>
                    <FileText size={20} />
                    <div>
                        <h3 className={styles.reportTitle}>{report.title}</h3>
                        <span className={styles.reportDate}>
                            {new Date(report.generatedAt).toLocaleString()}
                        </span>
                    </div>
                </div>

                {report.summary && (
                    <div className={styles.reportSummary}>
                        <h4>Executive Summary</h4>
                        <p>{report.summary}</p>
                    </div>
                )}

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
                                                {section.error ? '❌ Error' : `${section.rowCount} rows`}
                                            </span>
                                        </div>
                                        <span className={styles.reportSectionDesc}>{section.description}</span>
                                    </button>
                                    {isExpanded && (
                                        <div className={styles.reportSectionBody}>
                                            {section.error ? (
                                                <div className={styles.qaError}>
                                                    <AlertCircle size={14} />
                                                    <span>{section.error}</span>
                                                </div>
                                            ) : section.data.length > 0 ? (
                                                <div className={styles.qaTableWrapper}>
                                                    <table className={styles.qaTable}>
                                                        <thead>
                                                            <tr>
                                                                {section.columns.map((col, i) => (
                                                                    <th key={i}>{col}</th>
                                                                ))}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {section.data.slice(0, 15).map((row, ri) => (
                                                                <tr key={ri}>
                                                                    {section.columns.map((col, ci) => (
                                                                        <td key={ci}>{row[col] != null ? String(row[col]) : '—'}</td>
                                                                    ))}
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                    {section.data.length > 15 && (
                                                        <div className={styles.qaTableMore}>
                                                            Showing 15 of {section.rowCount} rows
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
                        <h4>💡 Recommendation</h4>
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

                {/* Agent Timeline (during streaming) */}
                {(isStreaming || steps.length > 0) && (
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

                {(steps.length > 0 || isStreaming) && (
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
                                    <button
                                        type="button"
                                        className={styles.outputActionPrimary}
                                        onClick={() => rerunFromSql()}
                                    >
                                        Rerun SQL
                                    </button>
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
                                        <div className={styles.liveColumn}>
                                            <div className={styles.liveTitle}>SQL</div>
                                            {(pipelineStageLogs.sql.length === 0) ? (
                                                <div className={styles.liveEmpty}>Waiting for SQL…</div>
                                            ) : (
                                                pipelineStageLogs.sql.slice(-5).map((line, idx) => (
                                                    <div key={`sql-log-${idx}`} className={styles.liveLine}>{line}</div>
                                                ))
                                            )}
                                        </div>
                                        <div className={styles.liveColumn}>
                                            <div className={styles.liveTitle}>Executor</div>
                                            {(pipelineStageLogs.execute.length === 0) ? (
                                                <div className={styles.liveEmpty}>Waiting for execution…</div>
                                            ) : (
                                                pipelineStageLogs.execute.slice(-5).map((line, idx) => (
                                                    <div key={`exec-log-${idx}`} className={styles.liveLine}>{line}</div>
                                                ))
                                            )}
                                        </div>
                                        <div className={styles.liveColumn}>
                                            <div className={styles.liveTitle}>Dashboard</div>
                                            {(pipelineStageLogs.dashboard.length === 0) ? (
                                                <div className={styles.liveEmpty}>Waiting for widgets…</div>
                                            ) : (
                                                pipelineStageLogs.dashboard.slice(-5).map((line, idx) => (
                                                    <div key={`dash-log-${idx}`} className={styles.liveLine}>{line}</div>
                                                ))
                                            )}
                                        </div>
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
                            {activeSuggestions.map((suggestion, i) => (
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

                {isStreaming && (
                    <div className={styles.connectionStatus}>
                        <span className={styles.statusDot} />
                        <span>Running</span>
                    </div>
                )}
            </div>
        </div>
    );
}

'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useConfigStore, useDashboardStore, useWorkflowStore } from '@/state/stores';
import { executeQuery } from '@/app/actions/mcp';
import { repairFailedQuery } from '@/lib/agents/nodes';
import {
    Button,
    Card,
    Typography,
    Space,
    Spin,
    Alert,
    Tag,
    Collapse,
    message,
    Input,
    Divider
} from 'antd';
import {
    ReloadOutlined,
    ArrowRightOutlined,
    CodeOutlined,
    SaveOutlined,
    RollbackOutlined,
    PlayCircleOutlined,
    CheckCircleOutlined,
    ExclamationCircleOutlined
} from '@ant-design/icons';
import { WidgetRenderer } from "@/components/widgets/WidgetRenderer";
import type { WidgetSpec } from "@/types/dashboard";

const { Title, Text, Paragraph } = Typography;
const { Panel } = Collapse;

export const QueryGeneratorView: React.FC = () => {
    const { postgresUrl, dataSources, selectedDataSourceId, disabledWidgetTypes } = useConfigStore();
    const {
        userPlan,
        aiPlan,
        schemaData,
        setSchemaData,
        aiQueries,
        setAiQueries,
        userQueries,
        setUserQueries,
        setExecutionResults,
        isProcessing,
        setProcessing,
        setError,
        setStep,
        staleStep,
        setStaleStep,
        schemaTimestamp,
        sqlErrorLog
    } = useWorkflowStore();
    const { activeFilters, filtersActivated } = useDashboardStore();

    const [validating, setValidating] = useState<Record<string, boolean>>({});
    const [validationStatus, setValidationStatus] = useState<Record<string, { status: 'success' | 'error' | 'none', message?: string }>>({});
    const isGeneratingRef = useRef(false);
    const lastAutoKeyRef = useRef<string | null>(null);
    const autoStreamRef = useRef(false);
    const autoAdvanceRef = useRef(false);
    const [streamStatus, setStreamStatus] = useState<string>('idle');
    const [streamLog, setStreamLog] = useState<string[]>([]);
    const [streamError, setStreamError] = useState<string | null>(null);
    const [isStreamingExecution, setIsStreamingExecution] = useState(false);
    const [streamExecutionError, setStreamExecutionError] = useState<string | null>(null);
    const [showAllFilters, setShowAllFilters] = useState(false);
    const [streamQueries, setStreamQueries] = useState<Record<string, {
        widgetId: string;
        widgetTitle: string;
        status: 'pending' | 'executing' | 'complete' | 'error';
        message?: string;
        result?: any;
        error?: string;
        sql?: string;
    }>>({});
    const [streamWidgets, setStreamWidgets] = useState<Record<string, {
        widgetId: string;
        widgetTitle: string;
        status: 'pending' | 'designing' | 'complete' | 'error';
        message?: string;
        result?: any;
        error?: string;
    }>>({});
    const executionResultsRef = useRef<Record<string, any>>({});
    const [messageApi, contextHolder] = message.useMessage();
    const messageQueueRef = useRef<Array<() => void>>([]);
    const [messageTick, setMessageTick] = useState(0);
    const enqueueMessage = useCallback((fn: () => void) => {
        messageQueueRef.current.push(fn);
        setMessageTick((tick) => tick + 1);
    }, []);

    useEffect(() => {
        if (messageQueueRef.current.length === 0) return;
        const queue = messageQueueRef.current.splice(0);
        queue.forEach((fn) => fn());
    }, [messageTick]);

    useEffect(() => {
        if (schemaData) return;
        try {
            const raw = localStorage.getItem('selected_schema');
            if (!raw) return;
            const payload = JSON.parse(raw);
            const manualSchema = payload?.schemaData || payload;
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

            setSchemaData({
                tables,
                schemaInfo,
                sampleData,
                tableCounts,
                relationships,
                connectionString: postgresUrl,
                filterCandidates: null,
                rawAnalysis: "Loaded schema from local selection.",
                filterSummary: ""
            });
        } catch {
            // ignore localStorage parse errors
        }
    }, [schemaData, setSchemaData]);

    const filterPlanByVisibility = useCallback((plan: any) => {
        if (!plan) return plan;
        const allowedTypes = new Set(["kpi", "line", "area", "bar", "pie", "donut", "table", "cohort", "funnel", "map", "scatter", "markdown"]);
        (disabledWidgetTypes || []).forEach((t) => allowedTypes.delete(t));
        if (!Array.isArray(plan.widgets)) return plan;
        return {
            ...plan,
            widgets: plan.widgets.filter((w: any) => allowedTypes.has(w?.type)),
        };
    }, [disabledWidgetTypes]);

    const handleGenerateSql = async (source: 'manual' | 'auto' | React.MouseEvent<HTMLElement> = 'manual') => {
        if (typeof source !== 'string') {
            source = 'manual';
        }
        const plan = filterPlanByVisibility(userPlan || aiPlan);
        if (!plan || !schemaData) return;
        if (Array.isArray(plan.widgets) && plan.widgets.length === 0) {
            setError('All widget types are disabled. Enable at least one widget type in settings.');
            return;
        }
        if (isGeneratingRef.current) return;
        isGeneratingRef.current = true;
        setProcessing(true);
        setStreamStatus('starting');
        setStreamError(null);
        setStreamLog([]);
        setError(null);

        try {
            const selectedConnector = dataSources.find(ds => ds.id === selectedDataSourceId) || dataSources.find(ds => ds.connectionString) || null;
            const schemaWithConnector = {
                ...schemaData,
                connectorInstructions: selectedConnector?.instructions || schemaData?.connectorInstructions,
                connectorType: selectedConnector?.type || schemaData?.connectorType,
                connectionString: selectedConnector?.connectionString || schemaData?.connectionString || postgresUrl
            };
            const response = await fetch('/api/sql/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    plan,
                    schema: schemaWithConnector,
                    connectorInstructions: selectedConnector?.instructions || "",
                    connectorType: selectedConnector?.type || "",
                    connectionString: selectedConnector?.connectionString || postgresUrl,
                    filters: Object.fromEntries(activeFilters),
                    applyFilters: filtersActivated,
                    errorLog: sqlErrorLog
                })
            });

            if (!response.ok || !response.body) {
                throw new Error('SQL generator connection failed. Please check if the LLM server is running.');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalQueries: Record<string, string> | null = null;

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
                        if (payload.status === 'error') {
                            throw new Error(payload.message || 'SQL generation failed.');
                        }
                        if (payload.status === 'started') {
                            setStreamStatus('running');
                            setStreamLog((prev) => [...prev, 'SQL generation started...']);
                        }
                        if (payload.status === 'completed' && payload.queries) {
                            finalQueries = payload.queries;
                            setStreamStatus('completed');
                            setStreamLog((prev) => [...prev, 'SQL generation completed.']);
                        }
                    } catch (e: any) {
                        // ignore malformed SSE chunk
                    }
                }
            }

            if (!finalQueries) {
                throw new Error('SQL generation returned no queries.');
            }

            const queryList = Object.entries(finalQueries).map(([id, sql]) => ({
                id,
                sql: sql as string,
                title: plan.widgets?.find((w: any) => w.id === id)?.title || id
            }));
            setAiQueries(queryList);
            if (staleStep === 3) setStaleStep(null);
            if (source === 'auto') {
                lastAutoKeyRef.current = `${(plan.rawPlan || '').slice(0, 500)}::${schemaTimestamp || ''}`;
            }
        } catch (err: any) {
            setError(err.message);
            setStreamStatus('error');
            setStreamError(err.message);
            setStreamLog((prev) => [...prev, `Error: ${err.message}`]);
        } finally {
            isGeneratingRef.current = false;
            setProcessing(false);
        }
    };

    const toWidgetSpec = (result: any): WidgetSpec => {
        const columns = Array.isArray(result?.columns) ? result.columns : [];
        const tableColumns = columns.map((col: string) => ({
            field: col,
            header: col.charAt(0).toUpperCase() + col.slice(1).replace(/_/g, " "),
        }));
        const fallbackId = typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `widget_${Math.random().toString(36).slice(2)}`;

        return {
            id: String(result?.widgetId || result?.id || fallbackId),
            title: result?.widgetTitle || result?.title || "Widget",
            type: (result?.type || "table") as WidgetSpec["type"],
            data: Array.isArray(result?.data) ? result.data : [],
            vegaSpec: result?.vegaSpec,
            tableConfig: tableColumns.length > 0 ? { columns: tableColumns } : undefined,
            ui: result?.error ? { error: result.error } : undefined
        };
    };

    const updateExecutionResult = (entry: any) => {
        executionResultsRef.current[entry.id] = entry;
        setExecutionResults(Object.values(executionResultsRef.current));
    };

    const handleStreamExecution = async () => {
        const plan = filterPlanByVisibility(userPlan || aiPlan);
        const queries = userQueries || aiQueries;
        if (!plan || !queries || queries.length === 0) return;
        if (isStreamingExecution) return;

        const sqlMap: Record<string, string> = {};
        queries.forEach((q: any) => {
            if (q?.id && q?.sql) sqlMap[q.id] = q.sql;
        });

        setIsStreamingExecution(true);
        setStreamExecutionError(null);
        setStreamQueries({});
        setStreamWidgets({});
        executionResultsRef.current = {};

        try {
            const selectedConnector = dataSources.find(ds => ds.id === selectedDataSourceId) || dataSources.find(ds => ds.connectionString) || null;
            const schemaWithConnector = {
                ...schemaData,
                connectorInstructions: selectedConnector?.instructions || schemaData?.connectorInstructions,
                connectorType: selectedConnector?.type || schemaData?.connectorType,
                connectionString: selectedConnector?.connectionString || schemaData?.connectionString || postgresUrl
            };
            const response = await fetch('/api/stream-sql-engineer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    queryPlan: plan,
                    queryValidation: sqlMap,
                    securityClearance: { approved: true },
                    schema: schemaWithConnector,
                    context: {
                        postgresUrl,
                        connectionString: selectedConnector?.connectionString || postgresUrl,
                        connectorInstructions: selectedConnector?.instructions || "",
                        connectorType: selectedConnector?.type || ""
                    }
                })
            });

            if (!response.ok || !response.body) {
                throw new Error('Streaming execution failed to start.');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

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
                        const event = JSON.parse(trimmed.slice(5).trim());
                        if (event.type === 'query_progress') {
                            const widgetId = event.widgetId as string;
                            if (!widgetId) continue;
                            setStreamQueries(prev => ({
                                ...prev,
                                [widgetId]: {
                                    ...(prev[widgetId] || { widgetId, widgetTitle: event.widgetTitle || widgetId, status: 'pending' }),
                                    status: 'executing',
                                    message: event.message,
                                    sql: event.sql
                                }
                            }));
                        }
                        if (event.type === 'query_complete') {
                            const widgetId = event.widgetId as string;
                            if (!widgetId) continue;
                            setStreamQueries(prev => ({
                                ...prev,
                                [widgetId]: {
                                    ...(prev[widgetId] || { widgetId, widgetTitle: event.widgetTitle || widgetId, status: 'pending' }),
                                    status: 'complete',
                                    message: event.message,
                                    result: event.result,
                                    sql: event.sql || prev[widgetId]?.sql
                                }
                            }));
                            const result = event.result || {};
                            updateExecutionResult({
                                id: result.widgetId || widgetId,
                                title: result.widgetTitle || event.widgetTitle || widgetId,
                                data: Array.isArray(result.data) ? result.data : [],
                                status: result.error ? 'error' : 'success',
                                error: result.error,
                                sql: result.sql || event.sql
                            });
                        }
                        if (event.type === 'query_error') {
                            const widgetId = event.widgetId as string;
                            if (!widgetId) continue;
                            setStreamQueries(prev => ({
                                ...prev,
                                [widgetId]: {
                                    ...(prev[widgetId] || { widgetId, widgetTitle: event.widgetTitle || widgetId, status: 'pending' }),
                                    status: 'error',
                                    message: event.message,
                                    error: event.error
                                }
                            }));
                            updateExecutionResult({
                                id: widgetId,
                                title: event.widgetTitle || widgetId,
                                data: [],
                                status: 'error',
                                error: event.error || event.message,
                                sql: event.sql
                            });
                        }
                        if (event.type === 'viz_progress' || event.type === 'widget_progress') {
                            const widgetId = event.widgetId as string;
                            if (!widgetId) continue;
                            setStreamWidgets(prev => ({
                                ...prev,
                                [widgetId]: {
                                    ...(prev[widgetId] || { widgetId, widgetTitle: event.widgetTitle || widgetId, status: 'pending' }),
                                    status: 'designing',
                                    message: event.message
                                }
                            }));
                        }
                        if (event.type === 'viz_complete' || event.type === 'widget_complete') {
                            const widgetId = event.widgetId as string;
                            if (!widgetId) continue;
                            setStreamWidgets(prev => ({
                                ...prev,
                                [widgetId]: {
                                    ...(prev[widgetId] || { widgetId, widgetTitle: event.widgetTitle || widgetId, status: 'pending' }),
                                    status: 'complete',
                                    message: event.message,
                                    result: event.result
                                }
                            }));
                        }
                        if (event.type === 'viz_error' || event.type === 'widget_error') {
                            const widgetId = event.widgetId as string;
                            if (!widgetId) continue;
                            setStreamWidgets(prev => ({
                                ...prev,
                                [widgetId]: {
                                    ...(prev[widgetId] || { widgetId, widgetTitle: event.widgetTitle || widgetId, status: 'pending' }),
                                    status: 'error',
                                    message: event.message,
                                    error: event.error
                                }
                            }));
                        }
                        if (event.type === 'complete') {
                            setIsStreamingExecution(false);
                            if (autoAdvanceRef.current) {
                                autoAdvanceRef.current = false;
                                setStep(5);
                            }
                        }
                        if (event.type === 'error') {
                            throw new Error(event.message || 'Streaming execution failed.');
                        }
                    } catch {
                        // ignore malformed chunks
                    }
                }
            }
        } catch (err: any) {
            setStreamExecutionError(err.message || 'Streaming execution failed.');
            setIsStreamingExecution(false);
        }
    };

    // Auto-generate if no queries OR if step is stale
    // Auto-generate SQL when arriving on step 3 with stale or missing queries.
    useEffect(() => {
        if ((!aiQueries || staleStep === 3) && !isProcessing && (userPlan || aiPlan)) {
            const plan = filterPlanByVisibility(userPlan || aiPlan);
            const autoKey = `${(plan?.rawPlan || '').slice(0, 500)}::${schemaTimestamp || ''}`;
            if (lastAutoKeyRef.current === autoKey) return;
            lastAutoKeyRef.current = autoKey;
            autoStreamRef.current = true;
            autoAdvanceRef.current = true;
            handleGenerateSql('auto');
        }
    }, [aiQueries, staleStep, aiPlan, userPlan, isProcessing, schemaTimestamp]);

    useEffect(() => {
        if (!autoStreamRef.current) return;
        const queries = userQueries || aiQueries;
        if (!queries || isStreamingExecution) return;
        autoStreamRef.current = false;
        handleStreamExecution();
    }, [userQueries, aiQueries, isStreamingExecution]);

    const handleUpdateSql = (id: string, newSql: string) => {
        if (!userQueries) return;
        const updated = userQueries.map((q: any) =>
            q.id === id ? { ...q, sql: newSql } : q
        );
        setUserQueries(updated);
        // Reset validation status for this query
        setValidationStatus(prev => ({ ...prev, [id]: { status: 'none' } }));
    };

    const validateQuery = async (id: string, sql: string) => {
        setValidating(prev => ({ ...prev, [id]: true }));
        try {
            const result: any = await executeQuery(`EXPLAIN (FORMAT JSON) ${sql}`, postgresUrl || undefined);
            if (result && result.error) {
                // Auto-repair on validation error if we have context
                const plan = filterPlanByVisibility(userPlan || aiPlan);
                const widgetInfo = plan?.widgets?.find((w: any) => w.id === id);
                if (plan && widgetInfo && schemaData) {
                    try {
                        const repairResult = await repairFailedQuery({
                            widgetId: id,
                            widgetTitle: widgetInfo.title || id,
                            widgetType: widgetInfo.type || 'unknown',
                            widgetGoal: widgetInfo.goal,
                            originalSql: sql,
                            errorMessage: result.error,
                            schema: schemaData,
                            errorLog: sqlErrorLog
                        });
                        const currentQueries = userQueries || aiQueries || [];
                        const updatedQueries = currentQueries.map((q: any) =>
                            q.id === id ? { ...q, sql: repairResult.sql } : q
                        );
                        setUserQueries(updatedQueries);
                        setValidationStatus(prev => ({ ...prev, [id]: { status: 'success', message: 'Auto-repaired via validation' } }));
                        return;
                    } catch (repairErr: any) {
                        setValidationStatus(prev => ({ ...prev, [id]: { status: 'error', message: repairErr.message || result.error } }));
                        return;
                    }
                }
                setValidationStatus(prev => ({ ...prev, [id]: { status: 'error', message: result.error } }));
                enqueueMessage(() => messageApi.error(`Validation failed for ${widgetInfo?.title || id}: ${result.error}`));
            } else {
                setValidationStatus(prev => ({ ...prev, [id]: { status: 'success', message: 'EXPLAIN ok' } }));
                enqueueMessage(() => messageApi.success(`Validation passed for ${id}`));
            }
        } catch (err: any) {
            setValidationStatus(prev => ({ ...prev, [id]: { status: 'error', message: err.message } }));
            enqueueMessage(() => messageApi.error(`Validation error for ${id}: ${err.message}`));
        } finally {
            setValidating(prev => ({ ...prev, [id]: false }));
        }
    };

    const handleValidateAll = async () => {
        const queriesToValidate = userQueries || aiQueries;
        if (!queriesToValidate) return;

        enqueueMessage(() => messageApi.info('Validating all queries...'));
        for (const q of queriesToValidate) {
            await validateQuery(q.id, q.sql);
        }
    };

    const handleReset = (id?: string) => {
        if (!aiQueries) return;
        if (id) {
            const original = aiQueries.find(q => q.id === id);
            if (original && userQueries) {
                const updated = userQueries.map(q => q.id === id ? original : q);
                setUserQueries(updated);
            }
        } else {
            setUserQueries(aiQueries);
        }
    };

    if (!schemaData) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, padding: 48 }}>
                <ExclamationCircleOutlined style={{ fontSize: 48, color: '#faad14' }} />
                <Title level={4}>Schema context missing</Title>
                <Text type="secondary" style={{ textAlign: 'center', maxWidth: 400 }}>
                    We lost the database schema context. This usually happens after a page refresh.
                    Please return to Step 1 to rediscover your data.
                </Text>
                <Button type="primary" onClick={() => setStep(1)}>Go to Step 1</Button>
            </div>
        );
    }

    if (isProcessing && !aiQueries) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16 }}>
                <Spin size="large" />
                <Text type="secondary">Engineering precision SQL queries...</Text>
            </div>
        );
    }

    const currentQueries = userQueries || aiQueries;
    const plan = filterPlanByVisibility(userPlan || aiPlan);
    const defaultFilters = (() => {
        if (Array.isArray(plan?.filters) && plan.filters.length > 0) return plan.filters;
        const candidates = schemaData?.filterCandidates;
        if (!candidates) return [];
        const items: any[] = [];
        const primaryDate = candidates.primaryDate;
        if (primaryDate?.table && primaryDate?.column) {
            items.push({
                dimension: `${primaryDate.table}.${primaryDate.column}`,
                type: 'date-range',
                value: 'this_month'
            });
        }
        (candidates.categoricalColumns || []).slice(0, 4).forEach((col: any) => {
            if (!col?.table || !col?.column) return;
            items.push({
                dimension: `${col.table}.${col.column}`,
                type: 'multi-select',
                value: col.distinct ? col.distinct.slice(0, 5) : []
            });
        });
        return items;
    })();
    const formatFilterValue = (value: any) => {
        if (value === null || value === undefined) return '—';
        if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
    };
    const formatFilterValueShort = (value: any) => {
        if (value === null || value === undefined) return '—';
        if (Array.isArray(value)) {
            if (value.length === 0) return '—';
            const preview = value.slice(0, 3).join(', ');
            return value.length > 3 ? `${preview} +${value.length - 3}` : preview;
        }
        if (typeof value === 'object') {
            const json = JSON.stringify(value);
            return json.length > 60 ? `${json.slice(0, 57)}…` : json;
        }
        const text = String(value);
        return text.length > 60 ? `${text.slice(0, 57)}…` : text;
    };

    return (
        <div style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
            {contextHolder}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, padding: '16px 20px', borderRadius: 16, border: '1px solid #242a36', background: '#0f1218' }}>
                <div>
                    <Title level={2} style={{ margin: 0 }}>
                        <CodeOutlined style={{ marginRight: 12 }} />
                        SQL Engineering
                    </Title>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <Space size={8} align="center">
                            <Text type="secondary">Generate SQL, review, then continue</Text>
                            <Tag color="blue">Step 3 of 5</Tag>
                        </Space>
                        {streamStatus === 'running' && <Tag color="blue">Generating (streaming)...</Tag>}
                        {streamStatus === 'starting' && <Tag color="geekblue">Connecting...</Tag>}
                        {streamStatus === 'completed' && <Tag color="green">Generation complete</Tag>}
                        {streamStatus === 'error' && <Tag color="red">Generation error</Tag>}
                    </div>
                </div>
                <Space>
                    <Button icon={<CheckCircleOutlined />} onClick={handleValidateAll}>Validate All</Button>
                    <Button icon={<ReloadOutlined />} onClick={() => handleGenerateSql('manual')} loading={isProcessing}>Generate SQL</Button>
                    <Button
                        type="primary"
                        icon={<PlayCircleOutlined />}
                        onClick={handleStreamExecution}
                        disabled={!currentQueries}
                    >
                        Stream Execute Queries
                    </Button>
                    <Button icon={<ArrowRightOutlined />} onClick={() => setStep(4)} disabled={!currentQueries}>
                        Continue
                    </Button>
                </Space>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Card size="small" title="Filters Applied to SQL" style={{ background: '#0b1220', borderColor: '#1f2a44' }}>
                    {defaultFilters.length > 0 || activeFilters.size > 0 ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {defaultFilters.length > 0 && (
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <Text strong>Defaults</Text>
                                        <Tag color="blue">{defaultFilters.length}</Tag>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                                        {defaultFilters
                                            .slice(0, showAllFilters ? defaultFilters.length : 3)
                                            .map((filter: any, idx: number) => (
                                                <div key={`${filter.dimension}-${idx}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 10px', borderRadius: 10, background: 'rgba(255,255,255,0.03)' }}>
                                                    <Text style={{ fontSize: 12 }}>{filter.dimension}</Text>
                                                    <Space size={6}>
                                                        <Tag color="blue">{filter.type}</Tag>
                                                        <Tag color="geekblue">{formatFilterValueShort(filter.value)}</Tag>
                                                    </Space>
                                                </div>
                                            ))}
                                    </div>
                                </div>
                            )}
                            {activeFilters.size > 0 && (
                                <div>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <Text strong>Overrides</Text>
                                        <Tag color="purple">{activeFilters.size}</Tag>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                                        {Array.from(activeFilters.entries())
                                            .slice(0, showAllFilters ? activeFilters.size : 3)
                                            .map(([dimension, value]) => (
                                                <div key={dimension} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '6px 10px', borderRadius: 10, background: 'rgba(255,255,255,0.03)' }}>
                                                    <Text style={{ fontSize: 12 }}>{dimension}</Text>
                                                    <Space size={6}>
                                                        <Tag color="purple">override</Tag>
                                                        <Tag color="geekblue">{formatFilterValueShort(value)}</Tag>
                                                    </Space>
                                                </div>
                                            ))}
                                    </div>
                                </div>
                            )}
                            {(defaultFilters.length > 3 || activeFilters.size > 3) && (
                                <Button size="small" type="text" onClick={() => setShowAllFilters((prev) => !prev)}>
                                    {showAllFilters ? 'Show less' : 'Show all filters'}
                                </Button>
                            )}
                        </div>
                    ) : (
                        <Text type="secondary">No filters enabled in schema discovery.</Text>
                    )}
                </Card>

                {streamLog.length > 0 && (
                    <Card size="small" type="inner" title="SQL Generation Stream" style={{ background: '#0b1220', borderColor: '#1f2a44' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                            {streamLog.map((line, idx) => (
                                <Text key={`stream-${idx}`} type={line.startsWith('Error') ? 'danger' : 'secondary'}>
                                    {line}
                                </Text>
                            ))}
                            {streamError && <Text type="danger">{streamError}</Text>}
                        </div>
                    </Card>
                )}

                <Card size="small" title="Streaming Execution" style={{ background: '#0b1220', borderColor: '#1f2a44' }}>
                    <Space style={{ marginBottom: 12 }}>
                        {isStreamingExecution && <Tag color="blue">Streaming</Tag>}
                        {!isStreamingExecution && Object.keys(streamQueries).length === 0 && <Tag>Idle</Tag>}
                    </Space>
                    {streamExecutionError && (
                        <Alert
                            type="error"
                            message="Streaming execution error"
                            description={streamExecutionError}
                            showIcon
                            style={{ marginBottom: 12 }}
                        />
                    )}

                    {Object.keys(streamQueries).length === 0 ? (
                        <Text type="secondary">Start streaming to see queries execute and results arrive.</Text>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {Object.values(streamQueries).map((query) => (
                                <div
                                    key={query.widgetId}
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        padding: '8px 12px',
                                        background: '#0f172a',
                                        border: '1px solid #1e293b',
                                        borderRadius: 8
                                    }}
                                >
                                    <div>
                                        <Text strong>{query.widgetTitle}</Text>
                                        <div>
                                            <Text type="secondary">{query.message}</Text>
                                        </div>
                                    </div>
                                    <Tag color={
                                        query.status === 'complete' ? 'success' :
                                        query.status === 'error' ? 'error' :
                                        'processing'
                                    }>
                                        {query.status}
                                    </Tag>
                                </div>
                            ))}
                        </div>
                    )}

                    {Object.keys(streamQueries).length > 0 && (
                        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {Object.values(streamQueries).map((query) => (
                                <div key={query.widgetId} style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, padding: 12 }}>
                                    {query.sql && (
                                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#cbd5f5', fontSize: 12 }}>
                                            {query.sql}
                                        </pre>
                                    )}
                                    {query.status === 'complete' && query.result?.data && (
                                        <div style={{ marginTop: 8 }}>
                                            <Text type="secondary">Rows: {query.result.data.length}</Text>
                                        </div>
                                    )}
                                    {query.status === 'error' && (
                                        <div style={{ marginTop: 8 }}>
                                            <Text type="danger">{query.error || 'Execution failed.'}</Text>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    {Object.values(streamWidgets).some(w => w.status === 'complete' && w.result) && (
                        <>
                            <Divider>Widget Previews</Divider>
                            <div style={{ 
                                display: 'grid', 
                                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', 
                                gap: 16 
                            }}>
                                {Object.values(streamWidgets)
                                    .filter(w => w.status === 'complete' && w.result)
                                    .map((widget) => {
                                        const spec = toWidgetSpec(widget.result);
                                        return (
                                            <Card key={spec.id} size="small" title={spec.title}>
                                                <WidgetRenderer widget={spec} data={spec.data} />
                                            </Card>
                                        );
                                    })}
                            </div>
                        </>
                    )}
                </Card>

                <Collapse
                    bordered={false}
                    style={{ background: '#0b1220', borderColor: '#1f2a44' }}
                    items={[
                        {
                            key: "recent-sql-errors",
                            label: (
                                <Space>
                                    <Text strong>Recent SQL Errors</Text>
                                    <Tag color={sqlErrorLog.length > 0 ? 'red' : 'default'}>{sqlErrorLog.length}</Tag>
                                </Space>
                            ),
                            children: sqlErrorLog.length === 0 ? (
                                <Text type="secondary">No SQL errors captured yet.</Text>
                            ) : (
                                <Collapse
                                    bordered={false}
                                    style={{ background: 'transparent' }}
                                    defaultActiveKey={[]}
                                    items={sqlErrorLog.map((entry, idx) => ({
                                        key: `${entry.id}-${idx}`,
                                        label: (
                                            <Space>
                                                <Tag color="red">Error</Tag>
                                                <Text>{entry.title || entry.id}</Text>
                                                <Text type="secondary" style={{ fontSize: 12 }}>
                                                    {entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'Unknown time'}
                                                </Text>
                                            </Space>
                                        ),
                                        children: (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                <Alert
                                                    title="Error message"
                                                    description={entry.error ? entry.error.split('\n')[0] : 'Unknown error'}
                                                    type="error"
                                                    showIcon
                                                />
                                                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#e2e8f0' }}>
                                                    {entry.error}
                                                </pre>
                                            </div>
                                        )
                                    }))}
                                />
                            )
                        }
                    ]}
                />

                {currentQueries && currentQueries.length > 0 ? (
                    currentQueries.map((q: any) => {
                        const status = validationStatus[q.id];
                        const original = aiQueries?.find(aq => aq.id === q.id);
                        const isEdited = original && original.sql !== q.sql;

                        return (
                            <Card
                                key={q.id}
                                size="small"
                                title={
                                    <Space>
                                        <Text strong>{q.title}</Text>
                                        <Tag color="geekblue">PostgreSQL</Tag>
                                        {isEdited && <Tag color="orange">Edited</Tag>}
                                        {status?.status === 'success' && <Tag icon={<CheckCircleOutlined />} color="success">Valid</Tag>}
                                        {status?.status === 'error' && <Tag icon={<ExclamationCircleOutlined />} color="error">Invalid</Tag>}
                                    </Space>
                                }
                                extra={
                                    <Space>
                                        <Button
                                            size="small"
                                            type="text"
                                            icon={<ReloadOutlined />}
                                            loading={validating[q.id]}
                                            onClick={() => validateQuery(q.id, q.sql)}
                                        >
                                            Validate
                                        </Button>
                                        {isEdited && (
                                            <Button
                                                size="small"
                                                type="text"
                                                icon={<RollbackOutlined />}
                                                onClick={() => handleReset(q.id)}
                                            >
                                                Reset
                                            </Button>
                                        )}
                                    </Space>
                                }
                            >
                                <Input.TextArea
                                    value={q.sql}
                                    onChange={(e: any) => handleUpdateSql(q.id, e.target.value)}
                                    autoSize={{ minRows: 3, maxRows: 15 }}
                                    style={{
                                        fontFamily: 'var(--font-mono)',
                                        fontSize: 13,
                                        backgroundColor: '#0a0c10',
                                        color: '#e6edf3',
                                        border: status?.status === 'error' ? '1px solid #ff4d4f' : '1px solid rgba(255,255,255,0.1)'
                                    }}
                                />
                                {status?.status === 'error' && (
                                    <Alert
                                        title="Syntax Error"
                                        description={status.message}
                                        type="error"
                                        showIcon
                                        style={{ marginTop: 8 }}
                                    />
                                )}
                            </Card>
                        );
                    })
                ) : (
                    <div style={{ padding: '48px', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px dashed rgba(255,255,255,0.1)' }}>
                        <CodeOutlined style={{ fontSize: 32, opacity: 0.3, marginBottom: 16 }} />
                        <Title level={5} type="secondary">No queries generated</Title>
                        <Paragraph type="secondary">
                            The planner didn't identify any widgets for this dashboard, or the SQL generator failed to produce code.
                        </Paragraph>
                        <Button icon={<ReloadOutlined />} onClick={handleGenerateSql} loading={isProcessing}>
                            Retry SQL Engineering
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
};

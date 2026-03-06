'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useConfigStore, useDashboardStore, useWorkflowStore } from '@/state/stores';
import { executeQuery } from '@/app/actions/mcp';
import { repairFailedQuery } from '@/modules/sql/agent';
import {
    App,
    Button,
    Card,
    Typography,
    Space,
    Alert,
    Tag,
    Collapse,
    Input,
    Tooltip
} from 'antd';
import {
    ReloadOutlined,
    ArrowRightOutlined,
    CodeOutlined,
    RollbackOutlined,
    CheckCircleOutlined,
    ExclamationCircleOutlined,
    InfoCircleOutlined
} from '@ant-design/icons';
import { ProgressTracker } from "@/components/ui";

const { Title, Text, Paragraph } = Typography;

type WidgetStreamDetail = {
    status?: 'generating' | 'done' | 'error';
    sql?: string;
    path?: 'full' | 'focused' | 'fallback';
    widgetType?: string;
    widgetGoal?: string;
    primaryTable?: string;
    uses?: string;
    notes?: string;
    index?: number;
    total?: number;
};

export const QueryGeneratorView: React.FC = () => {
    const { postgresUrl, dataSources, selectedDataSourceId, disabledWidgetTypes } = useConfigStore();
    const {
        query,
        userPlan,
        aiPlan,
        schemaData,
        setSchemaData,
        aiQueries,
        setAiQueries,
        userQueries,
        setUserQueries,
        isProcessing,
        setProcessing,
        setError,
        setStep,
        staleStep,
        setStaleStep,
        sqlErrorLog
    } = useWorkflowStore();
    const { activeFilters, filtersActivated } = useDashboardStore();

    const [validating, setValidating] = useState<Record<string, boolean>>({});
    const [validationStatus, setValidationStatus] = useState<Record<string, { status: 'success' | 'error' | 'none', message?: string }>>({});
    const isGeneratingRef = useRef(false);
    const [streamStatus, setStreamStatus] = useState<string>('idle');
    const [streamLog, setStreamLog] = useState<string[]>([]);
    const [streamError, setStreamError] = useState<string | null>(null);
    const [widgetStreamDetails, setWidgetStreamDetails] = useState<Record<string, WidgetStreamDetail>>({});
    const { message: messageApi } = App.useApp();
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

    const handleGenerateSql = async (source: 'manual' | React.MouseEvent<HTMLElement> = 'manual') => {
        if (typeof source !== 'string') source = 'manual';
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
        setWidgetStreamDetails({});
        setError(null);

        try {
            const selectedConnector = dataSources.find(ds => ds.id === selectedDataSourceId) || dataSources.find(ds => ds.connectionString) || null;
            const schemaWithConnector = {
                ...schemaData,
                connectorInstructions: selectedConnector?.instructions || schemaData?.connectorInstructions,
                connectorType: selectedConnector?.type || schemaData?.connectorType,
                connectionString: selectedConnector?.connectionString || schemaData?.connectionString || postgresUrl,
                disabledWidgetTypes: disabledWidgetTypes || []
            };

            const widgetCount = plan.widgets?.length || 0;
            setStreamLog(prev => [...prev, `Initializing SQL engineer for ${widgetCount} widgets...`]);
            setStreamLog(prev => [...prev, `Schema: ${Object.keys(schemaData.schemaInfo || {}).length} tables | Connector: ${selectedConnector?.type || schemaData?.connectorType || 'postgres'}`]);

            // Log enabled filter columns
            const filterableColumns = (schemaData as any)?.filterableColumns as Record<string, string[]> | undefined;
            if (filterableColumns && Object.keys(filterableColumns).length > 0) {
                const filterSummary = Object.entries(filterableColumns)
                    .map(([t, cols]) => `${t}(${(cols as string[]).join(', ')})`)
                    .join(' | ');
                setStreamLog(prev => [...prev, `Enabled filter columns: ${filterSummary}`]);
            }

            const response = await fetch('/api/sql/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query,
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
                throw new Error('SQL engineer connection failed. Please check if the LLM server is running.');
            }

            setStreamLog(prev => [...prev, `Connected — generating SQL queries in parallel...`]);

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let finalQueries: Record<string, string> | null = null;
            let serverError: string | null = null;

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
                            serverError = payload.message || 'SQL generation failed.';
                        }
                        if (payload.status === 'started') {
                            setStreamStatus('running');
                        }
                        if (payload.status === 'log') {
                            setStreamLog((prev) => [...prev, `  ${payload.message || ''}`]);
                        }
                        if (payload.status === 'widget_ready') {
                            const { id, sql, index, total, path, widgetType, widgetGoal, primaryTable, uses, notes } = payload;
                            const pathColor = path === 'fallback' ? '⚠' : path === 'focused' ? '↻' : '✓';
                            setStreamLog((prev) => [...prev, `  ${pathColor} [${index}/${total}] ${id}: SQL ready (${path || 'full'})`]);
                            setWidgetStreamDetails((prev) => ({
                                ...prev,
                                [id]: { status: 'done', sql, path, widgetType, widgetGoal, primaryTable, uses, notes, index, total }
                            }));
                        }
                        if (payload.status === 'completed' && payload.queries) {
                            finalQueries = payload.queries;
                            setStreamStatus('completed');
                            const queryCount = Object.keys(payload.queries).length;
                            setStreamLog((prev) => [...prev, `✓ SQL generation complete: ${queryCount} queries ready`]);
                        }
                    } catch {
                        // ignore malformed SSE JSON
                    }
                }

                if (serverError || finalQueries) break;
            }

            if (serverError) throw new Error(serverError);
            if (!finalQueries) throw new Error('SQL generation returned no queries.');

            const queryList = Object.entries(finalQueries).map(([id, sql]) => ({
                id,
                sql: sql as string,
                title: plan.widgets?.find((w: any) => w.id === id)?.title || id
            }));
            setAiQueries(queryList);
            setStreamLog((prev) => [...prev, `✓ All ${queryList.length} queries ready for execution`]);
            if (staleStep === 3) setStaleStep(null);
            void source;
        } catch (err: any) {
            setError(err.message);
            setStreamStatus('error');
            setStreamError(err.message);
            setStreamLog((prev) => [...prev, `✕ Error: ${err.message}`]);
        } finally {
            isGeneratingRef.current = false;
            setProcessing(false);
        }
    };

    const handleUpdateSql = (id: string, newSql: string) => {
        if (!userQueries) return;
        const updated = userQueries.map((q: any) =>
            q.id === id ? { ...q, sql: newSql } : q
        );
        setUserQueries(updated);
        setValidationStatus(prev => ({ ...prev, [id]: { status: 'none' } }));
    };

    const validateQuery = async (id: string, sql: string) => {
        setValidating(prev => ({ ...prev, [id]: true }));
        try {
            const result: any = await executeQuery(`EXPLAIN (FORMAT JSON) ${sql}`, postgresUrl || undefined);
            if (result && result.error) {
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
                        setUserQueries(currentQueries.map((q: any) => q.id === id ? { ...q, sql: repairResult.sql } : q));
                        setValidationStatus(prev => ({ ...prev, [id]: { status: 'success', message: 'Auto-repaired via validation' } }));
                        return;
                    } catch (repairErr: any) {
                        setValidationStatus(prev => ({ ...prev, [id]: { status: 'error', message: repairErr.message || result.error } }));
                        return;
                    }
                }
                setValidationStatus(prev => ({ ...prev, [id]: { status: 'error', message: result.error } }));
                enqueueMessage(() => messageApi.error(`Validation failed for ${id}: ${result.error}`));
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
                setUserQueries(userQueries.map(q => q.id === id ? original : q));
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
        const plan = filterPlanByVisibility(userPlan || aiPlan);
        const totalWidgets = plan?.widgets?.length || 0;
        const stages = [
            { id: 'analyze', label: 'Analyzing dashboard plan', status: 'completed' as const, message: `${totalWidgets} widgets to generate` },
            { id: 'generate', label: 'Generating SQL queries', status: 'in_progress' as const, message: 'Crafting optimized SQL for each widget...' },
            { id: 'validate', label: 'Validating SQL', status: 'pending' as const, message: 'Checking query correctness' },
            { id: 'optimize', label: 'Optimizing queries', status: 'pending' as const, message: 'Improving query performance' }
        ];
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 40 }}>
                <div style={{ maxWidth: 500, width: '100%' }}>
                    <div style={{ textAlign: 'center', marginBottom: 32 }}>
                        <div style={{ fontSize: 48, marginBottom: 16, background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>⚡</div>
                        <Title level={3} style={{ color: '#fff', margin: 0 }}>Engineering SQL Queries</Title>
                        <Text type="secondary">Generating precision SQL for {totalWidgets} widgets</Text>
                    </div>
                    <ProgressTracker stages={stages} title="SQL Generation Progress" showOverallProgress={true} />
                </div>
            </div>
        );
    }

    const currentQueries = userQueries || aiQueries;
    const plan = filterPlanByVisibility(userPlan || aiPlan);
    const selectedConnector = dataSources.find(ds => ds.id === selectedDataSourceId) || dataSources.find(ds => ds.connectionString) || null;
    const connectorType = selectedConnector?.type || (schemaData as any)?.connectorType || 'postgres';
    const connectorLabel = String(connectorType).toUpperCase();

    // Enabled filter columns — always fresh from schemaData.filterableColumns (never from cached plan.filters)
    const enabledFilterColumns = (schemaData as any)?.filterableColumns as Record<string, string[]> | undefined;
    const defaultFilters = (() => {
        if (enabledFilterColumns && typeof enabledFilterColumns === 'object') {
            const schemaInfo = (schemaData?.schemaInfo || {}) as Record<string, any>;
            const items: any[] = [];
            Object.entries(enabledFilterColumns).forEach(([tableName, cols]) => {
                if (!Array.isArray(cols)) return;
                const tableInfo = schemaInfo[tableName];
                const columns: any[] = Array.isArray(tableInfo?.columns) ? tableInfo.columns : [];
                cols.forEach((colName) => {
                    const col = columns.find((c: any) => (c?.name || c?.column_name) === colName);
                    const colType = String(col?.type || col?.data_type || '').toLowerCase();
                    const isDate = /date|time|timestamp/.test(colType);
                    items.push({
                        dimension: `${tableName}.${colName}`,
                        type: isDate ? 'date-range' : 'select',
                        value: isDate ? 'this_month' : null,
                    });
                });
            });
            if (items.length > 0) return items;
        }
        // Fallback: schema discovery filter candidates
        const candidates = schemaData?.filterCandidates;
        if (!candidates) return [];
        const items: any[] = [];
        const primaryDate = candidates.primaryDate;
        if (primaryDate?.table && primaryDate?.column) {
            items.push({ dimension: `${primaryDate.table}.${primaryDate.column}`, type: 'date-range', value: 'this_month' });
        }
        (candidates.categoricalColumns || []).slice(0, 4).forEach((col: any) => {
            if (!col?.table || !col?.column) return;
            items.push({ dimension: `${col.table}.${col.column}`, type: 'multi-select', value: col.distinct ? col.distinct.slice(0, 5) : [] });
        });
        return items;
    })();

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

    const pathColor = (path?: string) => {
        if (path === 'fallback') return 'orange';
        if (path === 'focused') return 'purple';
        return 'green';
    };

    // For a given widget, find which enabled filter columns belong to its tables
    const getWidgetFilterColumns = (widget: any): string[] => {
        if (!enabledFilterColumns) return [];
        const tables = new Set<string>([
            ...(Array.isArray(widget?.requiredTables) ? widget.requiredTables.map((t: any) => String(t)) : []),
            widget?.primaryTable ? String(widget.primaryTable) : '',
        ].filter(Boolean));
        const result: string[] = [];
        tables.forEach((t) => {
            const cols = enabledFilterColumns[t];
            if (Array.isArray(cols)) cols.forEach((c) => result.push(`${t}.${c}`));
        });
        return result;
    };

    return (
        <div style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
            {/* Header */}
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
                    <Button icon={<ArrowRightOutlined />} onClick={() => setStep(4)} disabled={!currentQueries}>Continue</Button>
                </Space>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 20 }}>
                {/* Left: Queries */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Pipeline Logs */}
                    {streamLog.length > 0 && (
                        <Card
                            size="small"
                            title={
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <span>Pipeline Logs</span>
                                    <Tag color="blue">{streamLog.length}</Tag>
                                </div>
                            }
                            style={{ background: '#0d1117', borderColor: '#30363d' }}
                            styles={{ body: { padding: 0 }, header: { borderBottom: '1px solid #30363d' } }}
                        >
                            <div style={{ maxHeight: 180, overflowY: 'auto', padding: '10px 14px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', fontSize: 12, lineHeight: 1.6 }}>
                                {streamLog.map((line, idx) => {
                                    const isError = /error|failed/i.test(line);
                                    const isSuccess = /✓|success|complete|done/i.test(line);
                                    const isWarn = /⚠|fallback/i.test(line);
                                    const icon = isError ? '✕' : isSuccess ? '✓' : isWarn ? '⚠' : '›';
                                    const color = isError ? '#f85149' : isSuccess ? '#3fb950' : isWarn ? '#e3b341' : '#8b949e';
                                    return (
                                        <div key={`log-${idx}`} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, color, marginBottom: 3 }}>
                                            <span style={{ flexShrink: 0, opacity: 0.7 }}>{icon}</span>
                                            <span style={{ color: isError ? '#f85149' : isSuccess ? '#3fb950' : isWarn ? '#e3b341' : '#c9d1d9' }}>{line}</span>
                                        </div>
                                    );
                                })}
                                {streamError && (
                                    <div style={{ display: 'flex', gap: 8, color: '#f85149', marginTop: 8, padding: '6px 10px', background: 'rgba(248,81,73,0.1)', borderRadius: 4, border: '1px solid rgba(248,81,73,0.3)' }}>
                                        <span>✕</span><span>{streamError}</span>
                                    </div>
                                )}
                            </div>
                        </Card>
                    )}

                    {/* SQL Error Log */}
                    {sqlErrorLog.length > 0 && (
                        <Collapse
                            bordered={false}
                            style={{ background: '#0b1220', borderColor: '#1f2a44' }}
                            items={[{
                                key: "recent-sql-errors",
                                label: (<Space><Text strong>Recent SQL Errors</Text><Tag color="red">{sqlErrorLog.length}</Tag></Space>),
                                children: (
                                    <Collapse bordered={false} style={{ background: 'transparent' }} items={sqlErrorLog.map((entry, idx) => ({
                                        key: `${entry.id}-${idx}`,
                                        label: (
                                            <Space>
                                                <Tag color="red">Error</Tag>
                                                <Text>{entry.title || entry.id}</Text>
                                                <Text type="secondary" style={{ fontSize: 12 }}>{entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'Unknown time'}</Text>
                                            </Space>
                                        ),
                                        children: (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                <Alert type="error" description={entry.error ? entry.error.split('\n')[0] : 'Unknown error'} showIcon style={{ background: 'rgba(245,34,45,0.1)', border: '1px solid rgba(245,34,45,0.3)' }} />
                                                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', color: '#e2e8f0', fontSize: 12 }}>{entry.error}</pre>
                                            </div>
                                        )
                                    }))} />
                                )
                            }]}
                        />
                    )}

                    {/* Widget SQL Cards */}
                    {currentQueries && currentQueries.length > 0 ? (
                        currentQueries.map((q: any) => {
                            const status = validationStatus[q.id];
                            const original = aiQueries?.find(aq => aq.id === q.id);
                            const isEdited = original && original.sql !== q.sql;
                            const planWidget = plan?.widgets?.find((w: any) => w?.id === q.id);
                            const streamDetail = widgetStreamDetails[q.id];
                            const widgetFilterCols = getWidgetFilterColumns(planWidget || {});
                            const isTableWidget = (planWidget?.type || streamDetail?.widgetType) === 'table';

                            return (
                                <Card
                                    key={q.id}
                                    size="small"
                                    title={
                                        <Space>
                                            <Text strong>{q.title}</Text>
                                            <Tag color="geekblue">{connectorLabel}</Tag>
                                            {(planWidget?.type || streamDetail?.widgetType) && <Tag color="cyan">{planWidget?.type || streamDetail?.widgetType}</Tag>}
                                            {streamDetail?.path && <Tag color={pathColor(streamDetail.path)}>{streamDetail.path}</Tag>}
                                            {isEdited && <Tag color="orange">Edited</Tag>}
                                            {status?.status === 'success' && <Tag icon={<CheckCircleOutlined />} color="success">Valid</Tag>}
                                            {status?.status === 'error' && <Tag icon={<ExclamationCircleOutlined />} color="error">Invalid</Tag>}
                                        </Space>
                                    }
                                    extra={
                                        <Space>
                                            <Button size="small" type="text" icon={<ReloadOutlined />} loading={validating[q.id]} onClick={() => validateQuery(q.id, q.sql)}>Validate</Button>
                                            {isEdited && <Button size="small" type="text" icon={<RollbackOutlined />} onClick={() => handleReset(q.id)}>Reset</Button>}
                                        </Space>
                                    }
                                >
                                    {/* SQL Engineer Input Panel */}
                                    <Collapse
                                        bordered={false}
                                        size="small"
                                        style={{ background: 'transparent', marginBottom: 10 }}
                                        items={[{
                                            key: 'input',
                                            label: (
                                                <Space size={6}>
                                                    <InfoCircleOutlined style={{ color: '#6366f1' }} />
                                                    <Text type="secondary" style={{ fontSize: 12 }}>SQL Engineer Input</Text>
                                                </Space>
                                            ),
                                            children: (
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
                                                    {/* Widget spec */}
                                                    <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 8px', padding: '8px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                                                        <Text type="secondary">Widget ID</Text>
                                                        <Text style={{ fontFamily: 'monospace' }}>{q.id}</Text>

                                                        <Text type="secondary">Type</Text>
                                                        <Text>{planWidget?.type || streamDetail?.widgetType || '—'}</Text>

                                                        <Text type="secondary">Goal</Text>
                                                        <Text>{planWidget?.goal || streamDetail?.widgetGoal || '—'}</Text>

                                                        <Text type="secondary">Primary table</Text>
                                                        <Tag color="blue" style={{ width: 'fit-content' }}>{planWidget?.primaryTable || streamDetail?.primaryTable || '—'}</Tag>

                                                        {(planWidget?.requiredTables?.length > 1) && (
                                                            <>
                                                                <Text type="secondary">All tables</Text>
                                                                <Space size={4} wrap>
                                                                    {planWidget.requiredTables.map((t: string) => <Tag key={t} color="geekblue" style={{ fontSize: 11 }}>{t}</Tag>)}
                                                                </Space>
                                                            </>
                                                        )}

                                                        <Text type="secondary">Planner refs</Text>
                                                        <Text style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{planWidget?.uses || streamDetail?.uses || '—'}</Text>

                                                        <Text type="secondary">SQL hints</Text>
                                                        <Text style={{ fontFamily: 'monospace', wordBreak: 'break-all', color: '#8b949e' }}>{planWidget?.notes || streamDetail?.notes || '—'}</Text>

                                                        <Text type="secondary">Generation</Text>
                                                        <Tag color={pathColor(streamDetail?.path)} style={{ width: 'fit-content' }}>{streamDetail?.path || 'pending'}</Tag>

                                                        <Text type="secondary">Connector</Text>
                                                        <Text>{connectorLabel}</Text>
                                                    </div>

                                                    {/* Filters for this widget */}
                                                    <div style={{ padding: '8px 10px', background: 'rgba(99,102,241,0.06)', borderRadius: 6, border: '1px solid rgba(99,102,241,0.15)' }}>
                                                        <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                                                            ALLOWED FILTER COLUMNS (injected into SQL engineer prompt)
                                                        </Text>
                                                        {widgetFilterCols.length > 0 ? (
                                                            <Space size={4} wrap>
                                                                {widgetFilterCols.map((col) => <Tag key={col} color="purple" style={{ fontSize: 11 }}>{col}</Tag>)}
                                                            </Space>
                                                        ) : (
                                                            <Text type="secondary" style={{ fontSize: 11 }}>No filter columns for this widget's tables</Text>
                                                        )}
                                                    </div>

                                                    {/* Pagination for table widgets */}
                                                    {isTableWidget && (
                                                        <div style={{ padding: '8px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                                                            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>
                                                                PAGINATION (default values injected via SQL template)
                                                            </Text>
                                                            <Space size={4} wrap>
                                                                <Tag color="geekblue">{'{{size:25}}'} → page size</Tag>
                                                                <Tag color="geekblue">{'{{offset:0}}'} → row offset</Tag>
                                                                <Tag color="geekblue">{'{{sort_col:id}}'} → sort column</Tag>
                                                                <Tag color="geekblue">{'{{sort_dir:ASC}}'} → sort direction</Tag>
                                                                <Tag>COUNT(*) OVER() → total_count</Tag>
                                                            </Space>
                                                        </div>
                                                    )}

                                                    {/* Runtime filters active */}
                                                    {activeFilters.size > 0 && (
                                                        <div style={{ padding: '8px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6 }}>
                                                            <Text type="secondary" style={{ fontSize: 11, display: 'block', marginBottom: 4 }}>RUNTIME FILTERS (active overrides)</Text>
                                                            <Space size={4} wrap>
                                                                {Array.from(activeFilters.entries()).map(([dim, val]) => (
                                                                    <Tag key={dim} color="orange" style={{ fontSize: 11 }}>{dim} = {formatFilterValueShort(val)}</Tag>
                                                                ))}
                                                            </Space>
                                                        </div>
                                                    )}
                                                </div>
                                            )
                                        }]}
                                    />

                                    {/* SQL Editor */}
                                    <Input.TextArea
                                        value={q.sql}
                                        onChange={(e: any) => handleUpdateSql(q.id, e.target.value)}
                                        autoSize={{ minRows: 3, maxRows: 18 }}
                                        style={{
                                            fontFamily: 'var(--font-mono)',
                                            fontSize: 13,
                                            backgroundColor: '#0a0c10',
                                            color: '#e6edf3',
                                            border: status?.status === 'error' ? '1px solid #ff4d4f' : '1px solid rgba(255,255,255,0.1)'
                                        }}
                                    />
                                    {status?.status === 'error' && (
                                        <Alert description={status.message} type="error" showIcon style={{ marginTop: 10, background: 'rgba(245,34,45,0.1)', border: '1px solid rgba(245,34,45,0.3)' }} />
                                    )}
                                </Card>
                            );
                        })
                    ) : (
                        <div style={{ padding: '48px', textAlign: 'center', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px dashed rgba(255,255,255,0.1)' }}>
                            <CodeOutlined style={{ fontSize: 32, opacity: 0.3, marginBottom: 16 }} />
                            <Title level={5} type="secondary">No queries generated</Title>
                            <Paragraph type="secondary">Click "Generate SQL" to build queries for this dashboard plan.</Paragraph>
                            <Button icon={<ReloadOutlined />} onClick={handleGenerateSql} loading={isProcessing}>Generate SQL</Button>
                        </div>
                    )}
                </div>

                {/* Right Sidebar: Filters + Schema Info */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Enabled Filter Columns */}
                    <Card
                        size="small"
                        title={
                            <Space>
                                <Text strong>Enabled Filter Columns</Text>
                                <Tooltip title="These columns are injected as ALLOWED FILTER COLUMNS into the SQL engineer prompt. Only these can appear in WHERE/HAVING/JOIN.">
                                    <InfoCircleOutlined style={{ color: '#6366f1', cursor: 'pointer' }} />
                                </Tooltip>
                                <Tag color="blue">{defaultFilters.length}</Tag>
                            </Space>
                        }
                        style={{ background: '#0b1220', borderColor: '#1f2a44' }}
                    >
                        {defaultFilters.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {defaultFilters.map((filter: any, idx: number) => (
                                    <div key={`${filter.dimension}-${idx}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 8px', borderRadius: 8, background: 'rgba(255,255,255,0.03)' }}>
                                        <Text style={{ fontSize: 12, fontFamily: 'monospace' }}>{filter.dimension}</Text>
                                        <Space size={4}>
                                            <Tag color={filter.type === 'date-range' ? 'geekblue' : 'purple'} style={{ fontSize: 11 }}>{filter.type}</Tag>
                                            {filter.value != null && <Tag color="default" style={{ fontSize: 11 }}>{formatFilterValueShort(filter.value)}</Tag>}
                                        </Space>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <Text type="secondary" style={{ fontSize: 12 }}>No filter columns enabled. Enable columns in Schema Discovery.</Text>
                        )}
                    </Card>

                    {/* Active Runtime Filters */}
                    {activeFilters.size > 0 && (
                        <Card size="small" title={<Space><Text strong>Runtime Overrides</Text><Tag color="purple">{activeFilters.size}</Tag></Space>} style={{ background: '#0b1220', borderColor: '#1f2a44' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {Array.from(activeFilters.entries()).map(([dimension, value]) => (
                                    <div key={dimension} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 8px', borderRadius: 8, background: 'rgba(255,255,255,0.03)' }}>
                                        <Text style={{ fontSize: 12, fontFamily: 'monospace' }}>{dimension}</Text>
                                        <Tag color="orange" style={{ fontSize: 11 }}>{formatFilterValueShort(value)}</Tag>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}

                    {/* Schema Summary */}
                    <Card size="small" title="Schema Context" style={{ background: '#0b1220', borderColor: '#1f2a44' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <Text type="secondary">Connector</Text>
                                <Tag color="geekblue">{connectorLabel}</Tag>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <Text type="secondary">Tables</Text>
                                <Tag>{Object.keys(schemaData?.schemaInfo || {}).length}</Tag>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <Text type="secondary">Widgets</Text>
                                <Tag>{plan?.widgets?.length || 0}</Tag>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                <Text type="secondary">Filters enabled</Text>
                                <Tag color="purple">{defaultFilters.length}</Tag>
                            </div>
                            {(schemaData as any)?.relationships?.length > 0 && (
                                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <Text type="secondary">Relationships</Text>
                                    <Tag>{(schemaData as any).relationships.length}</Tag>
                                </div>
                            )}
                        </div>
                    </Card>

                    {/* Widget Overview */}
                    {plan?.widgets && plan.widgets.length > 0 && (
                        <Card size="small" title="Widget Input Summary" style={{ background: '#0b1220', borderColor: '#1f2a44' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {plan.widgets.map((w: any) => {
                                    const detail = widgetStreamDetails[w.id];
                                    const wFilters = getWidgetFilterColumns(w);
                                    return (
                                        <div key={w.id} style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                                                <Text style={{ fontSize: 12 }} strong>{w.title}</Text>
                                                <Space size={4}>
                                                    <Tag color="cyan" style={{ fontSize: 11 }}>{w.type}</Tag>
                                                    {detail?.path && <Tag color={pathColor(detail.path)} style={{ fontSize: 11 }}>{detail.path}</Tag>}
                                                </Space>
                                            </div>
                                            <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                                                table: <span style={{ color: '#8b949e', fontFamily: 'monospace' }}>{w.primaryTable || '—'}</span>
                                            </Text>
                                            {wFilters.length > 0 && (
                                                <div style={{ marginTop: 4 }}>
                                                    <Text type="secondary" style={{ fontSize: 11 }}>filters: </Text>
                                                    <Text style={{ fontSize: 11, fontFamily: 'monospace', color: '#a78bfa' }}>{wFilters.join(', ')}</Text>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </Card>
                    )}

                    <Alert
                        description="SQL hints from the planner (notes field) encode the exact aggregation patterns. The SQL engineer follows them to produce correct queries."
                        type="info"
                        showIcon
                    />
                </div>
            </div>
        </div>
    );
};

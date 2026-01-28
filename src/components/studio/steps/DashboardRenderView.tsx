'use client';

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useWorkflowStore, useDashboardStore, useEditorStore, useRunStore, useConfigStore } from '@/state/stores';
import { DashboardCanvas } from '@/components/canvas/DashboardCanvas';
import { FilterBar } from '@/components/canvas/FilterBar';
import { assembleFinalDashboard, runNarrativeGenerator, runQueryExecutor, repairFailedQuery } from '@/lib/agents/nodes';
import {
    Button,
    Typography,
    Space,
    Divider,
    Layout,
    Menu,
    Dropdown,
    message,
    Modal,
    Result,
    Tag,
    Spin
} from 'antd';
import {
    EditOutlined,
    SaveOutlined,
    ReloadOutlined,
    DatabaseOutlined,
    LayoutOutlined,
    ExportOutlined,
    QuestionCircleOutlined,
    UndoOutlined,
    MoreOutlined
} from '@ant-design/icons';



const { Header, Content, Sider } = Layout;
const { Title, Text } = Typography;

export const DashboardRenderView: React.FC = () => {
    const { postgresUrl } = useConfigStore();
    const {
        setStep,
        reset: resetWorkflow,
        setStaleStep,
        staleStep,
        schemaData,
        isProcessing,
        setProcessing,
        setExecutionResults,
        setAiQueries,
        setUserQueries,
        addSqlError,
        sqlErrorLog
    } = useWorkflowStore();

    const {
        dashboard,
        setDashboard,
        isLoading: isDashboardLoading,
        activeFilters,
        filtersActivated,
        markFiltersActivated
    } = useDashboardStore();

    const {
        selectedWidgetId,
        selectWidget,
        localLayout,
        localWidgets,
        isDirty,
        markClean
    } = useEditorStore();

    const { partialResults } = useRunStore();
    const [isEditMode, setIsEditMode] = useState(false);
    const [assembleError, setAssembleError] = useState<string | null>(null);
    const assemblingRef = useRef(false);
    const lastAppliedFiltersRef = useRef<string>('');
    const [filtersDirty, setFiltersDirty] = useState(false);
    const {
        userPlan,
        aiPlan,
        userQueries,
        aiQueries,
        executionResults
    } = useWorkflowStore();

    const [modal, contextHolder] = Modal.useModal();
    const [messageApi, messageContextHolder] = message.useMessage();
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

    // Compute layout and widgets for the canvas
    const widgets = useMemo(() => {
        if (!dashboard?.widgets) return [];
        return dashboard.widgets.map((w: any) => ({
            ...w,
            ...(localWidgets.get(w.id) || {}),
        }));
    }, [dashboard?.widgets, localWidgets]);

    const layout = useMemo(() => {
        return localLayout || dashboard?.layout || [];
    }, [localLayout, dashboard?.layout]);

    const filterKey = useMemo(() => JSON.stringify(Object.fromEntries(activeFilters)), [activeFilters]);

    const widgetStats = useMemo(() => {
        const total = widgets.length;
        const kpis = widgets.filter((w: any) => w.type === 'kpi').length;
        const charts = widgets.filter((w: any) => ['line', 'bar', 'area', 'pie', 'donut', 'scatter', 'map', 'funnel', 'cohort'].includes(w.type)).length;
        const tables = widgets.filter((w: any) => w.type === 'table').length;
        return { total, kpis, charts, tables };
    }, [widgets]);

    const getWidgetData = (widgetId: string) => {
        // Prefer fresh executor results so KPIs/charts stay live
        const widgetMeta = dashboard?.widgets?.find((w: any) => w.id === widgetId);
        const latestResult = executionResults?.find((r: any) =>
            r.id === widgetId ||
            r.id === widgetMeta?.queryId ||
            (widgetMeta?.title && r.title && r.title.toLowerCase() === widgetMeta.title.toLowerCase())
        );
        if (latestResult?.data) return latestResult.data;

        // Fallback: match via query mapping
        const mappedQuery = dashboard?.queries?.find((q: any) => q.widgetIds?.includes?.(widgetId));
        if (mappedQuery) {
            const mappedResult = executionResults?.find((r: any) => r.id === mappedQuery.id);
            if (mappedResult?.data) return mappedResult.data;
        }

        // 1. Check live partial results (streaming)
        const streamResults = partialResults.get(`q_${widgetId}`) || partialResults.get(widgetId);
        if (streamResults) return streamResults;

        // 2. Check query-mapped results
        const query = dashboard?.queries?.find((q: any) => q.widgetIds.includes(widgetId));
        if (query?.id && partialResults.has(query.id)) {
            return partialResults.get(query.id);
        }

        // 3. Fallback to data already in the widget object
        const widget = dashboard?.widgets?.find((w: any) => w.id === widgetId);
        return widget?.data;
    };

    const handleSaveDashboard = () => {
        if (dashboard) {
            const updatedDash = {
                ...dashboard,
                widgets: widgets,
                layout: layout,
                updatedAt: new Date().toISOString()
            };
            setDashboard(updatedDash as any);
            markClean();
            enqueueMessage(() => messageApi.success('Dashboard configuration saved to localStorage.'));
        }
    };

    // Auto-assemble when arriving on step 5 with stale or missing dashboard.
    useEffect(() => {
        if ((dashboard && staleStep !== 5) || assemblingRef.current) return;
        const plan = userPlan || aiPlan;
        const queries = userQueries || aiQueries;
        if (!plan || !queries || !executionResults) return;

        assemblingRef.current = true;
        setAssembleError(null);

        const assemble = async () => {
            try {
                let insights: string[] = [];
                try {
                    insights = await runNarrativeGenerator(executionResults as any[]);
                } catch (err) {
                    console.warn("[DASHBOARD] Narrative generation failed:", err);
                }
                const finalDash = await assembleFinalDashboard(plan, queries as any[], executionResults as any[], insights, schemaData?.filterCandidates);
                setDashboard(finalDash as any);
                setStaleStep(null);
            } catch (err: any) {
                console.error("[DASHBOARD] Auto-assembly error:", err);
                setAssembleError(err.message || "Failed to assemble dashboard.");
            } finally {
                assemblingRef.current = false;
            }
        };

        assemble();
    }, [dashboard, staleStep, userPlan, aiPlan, userQueries, aiQueries, executionResults, setDashboard, setStaleStep, schemaData]);

    const handleRefreshSchema = () => {
        modal.confirm({
            title: 'Refresh Schema?',
            content: 'Refreshing the schema will mark your current plan and dashboard as stale. You will need to rerun the planning and SQL generation steps.',
            okText: 'Refresh',
            cancelText: 'Cancel',
            onOk: () => {
                setStaleStep(1);
                setStep(1);
            }
        });
    };

    const handleRegeneratePlan = () => {
        modal.confirm({
            title: 'Regenerate Plan?',
            content: 'This will discard your current dashboard and start a new planning process based on the existing schema.',
            okText: 'Regenerate',
            onOk: () => {
                setStaleStep(2);
                setStep(2);
            }
        });
    };

    const regenerateWithFilters = useCallback(async () => {
        const plan = userPlan || aiPlan;
        if (!plan || !schemaData) return;

        try {
            markFiltersActivated();
            setProcessing(true);
            enqueueMessage(() => messageApi.loading({ content: 'Applying filters and recalculating metrics...', key: 'filter-refresh', duration: 0 }));

            const response = await fetch('/api/sql/stream', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    plan,
                    schema: schemaData,
                    filters: Object.fromEntries(activeFilters),
                    applyFilters: true,
                    errorLog: sqlErrorLog
                })
            });

            if (!response.ok || !response.body) {
                throw new Error('SQL regeneration failed. Please check the LLM server.');
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
                            throw new Error(payload.message || 'SQL regeneration failed.');
                        }
                        if (payload.status === 'completed' && payload.queries) {
                            finalQueries = payload.queries;
                        }
                    } catch {
                        // ignore malformed SSE
                    }
                }
            }

            if (!finalQueries) {
                throw new Error('SQL regeneration returned no queries.');
            }

            const queryList = Object.entries(finalQueries).map(([id, sql]) => ({
                id,
                sql: sql as string,
                title: plan.widgets?.find((w: any) => w.id === id)?.title || id
            }));

            const queryMap: Record<string, string> = {};
            queryList.forEach((q: any) => {
                queryMap[q.id] = q.sql;
            });

            const data = await runQueryExecutor(queryMap, postgresUrl || undefined);
            let resultsList = Object.entries(data).map(([id, result]: [string, any]) => ({
                id,
                ...result,
                title: queryList.find((q: any) => q.id === id)?.title || id
            }));

            for (const res of resultsList) {
                if (res.status === 'error') {
                    addSqlError({
                        id: res.id,
                        title: res.title,
                        error: res.error || 'Execution failed'
                    });
                }
            }

            // Auto-repair failed queries during filter refresh
            for (const res of resultsList) {
                if (res.status !== 'error') continue;
                const query = queryList.find((q: any) => q.id === res.id);
                const widgetInfo = plan.widgets?.find((w: any) => w.id === res.id);
                if (!query || !widgetInfo) continue;
                try {
                    const repairResult = await repairFailedQuery({
                        widgetId: res.id,
                        widgetTitle: widgetInfo.title || res.id,
                        widgetType: widgetInfo.type || 'unknown',
                        widgetGoal: widgetInfo.goal,
                        originalSql: query.sql,
                        errorMessage: res.error || 'Execution failed',
                        schema: schemaData,
                        errorLog: sqlErrorLog,
                        connectionString: postgresUrl || undefined
                    });
                    query.sql = repairResult.sql;
                    const rerun = await runQueryExecutor({ [res.id]: repairResult.sql }, postgresUrl || undefined);
                    const fixed = rerun[res.id];
                    resultsList = resultsList.map((r: any) =>
                        r.id === res.id ? { ...fixed, id: res.id, title: res.title } : r
                    );
                } catch (err) {
                    // keep original error result
                }
            }
            const hasData = resultsList.some((r: any) => r.status === 'success' && Array.isArray(r.data) && r.data.length > 0);
                if (!hasData) {
                enqueueMessage(() => messageApi.warning({ content: 'Filters returned no data. Keeping previous results.', key: 'filter-refresh', duration: 4 }));
                return;
            }

            setAiQueries(queryList);
            setUserQueries(queryList);
            setExecutionResults(resultsList);

            let insights: string[] = [];
            try {
                insights = await runNarrativeGenerator(resultsList as any[]);
            } catch (err) {
                console.warn("[DASHBOARD] Narrative generation failed:", err);
            }

            const finalDash = await assembleFinalDashboard(plan, queryList as any[], resultsList as any[], insights, schemaData?.filterCandidates);
            setDashboard(finalDash as any);
            setStaleStep(null);
            lastAppliedFiltersRef.current = filterKey;
            setFiltersDirty(false);
            enqueueMessage(() => messageApi.success({ content: 'Filters applied.', key: 'filter-refresh' }));
        } catch (err: any) {
            console.error("[DASHBOARD] Filter regeneration failed:", err);
            enqueueMessage(() => messageApi.error({ content: `Filter update failed: ${err.message}`, key: 'filter-refresh', duration: 4 }));
        } finally {
            setProcessing(false);
        }
    }, [
        userPlan,
        aiPlan,
        schemaData,
        activeFilters,
        sqlErrorLog,
        setProcessing,
        addSqlError,
        setExecutionResults,
        setAiQueries,
        setUserQueries,
        setDashboard,
        setStaleStep,
        filterKey,
        enqueueMessage,
        messageApi
    ]);

    useEffect(() => {
        if (!dashboard) return;
        if (!lastAppliedFiltersRef.current) {
            lastAppliedFiltersRef.current = filterKey;
            setFiltersDirty(false);
            return;
        }
        const dirty = filterKey !== lastAppliedFiltersRef.current;
        setFiltersDirty(dirty);
    }, [filterKey, dashboard]);

    if (!dashboard) {
        return (
            <div style={{ padding: '64px' }}>
                <Result
                    status={assembleError ? "error" : "404"}
                    title={assembleError ? "Dashboard Assembly Failed" : "No Dashboard Found"}
                    subTitle={assembleError || "Please complete the workflow to generate a dashboard."}
                    extra={<Button type="primary" onClick={() => setStep(1)}>Start Discovery</Button>}
                />
            </div>
        );
    }

    if (isDashboardLoading) {
        return (
            <div style={{ padding: '64px', display: 'flex', justifyContent: 'center' }}>
                <Result
                    icon={<Spin size="large" />}
                    title="Assembling dashboard..."
                    subTitle="Crunching results and rendering widgets."
                />
            </div>
        );
    }

    return (
        <Layout className="h-full bg-transparent overflow-hidden">
            {contextHolder}
            {messageContextHolder}
            <Header style={{ background: 'transparent', padding: '0 24px', height: 'auto', marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', borderRadius: 16, border: '1px solid #242a36', background: '#0f1218' }}>
                    <div>
                        <Title level={4} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
                            <LayoutOutlined />
                            {dashboard?.name || 'Executive Dashboard'}
                        </Title>
                        <Space separator={<Text type="secondary">|</Text>}>
                            <Text type="secondary">
                                Last updated: {dashboard?.updatedAt ? new Date(dashboard.updatedAt).toLocaleTimeString() : '—'}
                            </Text>
                            <Tag color="blue">Live Data</Tag>
                            <Tag color="blue">Step 5 of 5</Tag>
                        </Space>
                    </div>
                    <Space>
                        <Button
                            icon={isEditMode ? <UndoOutlined /> : <EditOutlined />}
                            onClick={() => setIsEditMode(!isEditMode)}
                        >
                            {isEditMode ? 'Exit Edit Mode' : 'Edit Layout'}
                        </Button>
                        <Button
                            type="primary"
                            icon={<SaveOutlined />}
                            disabled={!isDirty && !isEditMode}
                            onClick={handleSaveDashboard}
                        >
                            Save Dashboard
                        </Button>
                        <Dropdown menu={{
                            items: [
                                { key: 'regen', label: 'Regenerate Plan', icon: <ReloadOutlined />, onClick: handleRegeneratePlan },
                                { key: 'refresh', label: 'Refresh Schema', icon: <DatabaseOutlined />, onClick: handleRefreshSchema },
                                { type: 'divider' },
                                { key: 'export', label: 'Export PDF', icon: <ExportOutlined /> }
                            ]
                        }}>
                            <Button icon={<MoreOutlined />} />
                        </Dropdown>
                    </Space>
                </div>
            </Header>

            <Layout className="bg-transparent overflow-hidden">
                <Sider width={280} style={{ background: '#11141d' }} className="border-r border-white/5 p-4" collapsible reverseArrow>
                    <div style={{ marginBottom: 24 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <Title level={5} style={{ margin: 0 }}>Active Filters</Title>
                            <Button
                                size="small"
                                type={filtersDirty ? "primary" : "default"}
                                disabled={!filtersDirty}
                                onClick={regenerateWithFilters}
                            >
                                Apply
                            </Button>
                        </div>
                        {!filtersActivated && (
                            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                                Filters are staged. Click Apply to refresh results.
                            </Text>
                        )}
                        <FilterBar filters={dashboard.filters || []} />
                    </div>
                    <Divider />
                    <Title level={5}>Quick Stats</Title>
                    <Space orientation="vertical" style={{ width: '100%' }}>
                        <div className="flex justify-between">
                            <Text type="secondary">Widgets</Text>
                            <Text strong>{widgets.length}</Text>
                        </div>
                        <div className="flex justify-between">
                            <Text type="secondary">Data Sources</Text>
                            <Tag color="cyan">Postgres</Tag>
                        </div>
                    </Space>
                </Sider>

                <Content className="overflow-auto p-4 relative">
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16, marginBottom: 20 }}>
                        <div style={{ padding: 16, borderRadius: 14, background: 'rgba(17, 24, 39, 0.7)', border: '1px solid rgba(148,163,184,0.12)' }}>
                            <Text type="secondary">Total Widgets</Text>
                            <Title level={3} style={{ margin: 0 }}>{widgetStats.total}</Title>
                        </div>
                        <div style={{ padding: 16, borderRadius: 14, background: 'rgba(17, 24, 39, 0.7)', border: '1px solid rgba(148,163,184,0.12)' }}>
                            <Text type="secondary">KPI Cards</Text>
                            <Title level={3} style={{ margin: 0 }}>{widgetStats.kpis}</Title>
                        </div>
                        <div style={{ padding: 16, borderRadius: 14, background: 'rgba(17, 24, 39, 0.7)', border: '1px solid rgba(148,163,184,0.12)' }}>
                            <Text type="secondary">Charts</Text>
                            <Title level={3} style={{ margin: 0 }}>{widgetStats.charts}</Title>
                        </div>
                        <div style={{ padding: 16, borderRadius: 14, background: 'rgba(17, 24, 39, 0.7)', border: '1px solid rgba(148,163,184,0.12)' }}>
                            <Text type="secondary">Active Filters</Text>
                            <Title level={3} style={{ margin: 0 }}>{activeFilters.size}</Title>
                        </div>
                    </div>

                    {dashboard.insights && dashboard.insights.length > 0 && (
                        <div style={{ marginBottom: 20, padding: 16, borderRadius: 14, background: 'rgba(15, 23, 42, 0.6)', border: '1px solid rgba(148,163,184,0.12)' }}>
                            <Title level={5} style={{ marginTop: 0 }}>Highlights</Title>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {dashboard.insights.slice(0, 4).map((insight: string, idx: number) => (
                                    <Text key={`insight-${idx}`} type="secondary">• {insight}</Text>
                                ))}
                            </div>
                        </div>
                    )}
                    <DashboardCanvas
                        widgets={widgets}
                        layout={layout as any}
                        isEditing={isEditMode}
                        onWidgetClick={(id) => isEditMode && selectWidget(id)}
                        getWidgetData={getWidgetData}
                    />
                </Content>
            </Layout>
        </Layout>
    );
};

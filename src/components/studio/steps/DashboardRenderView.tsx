'use client';

import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useWorkflowStore, useDashboardStore, useEditorStore, useRunStore, useConfigStore } from '@/state/stores';
import { DashboardCanvas } from '@/components/canvas/DashboardCanvas';
import { FilterBar } from '@/components/canvas/FilterBar';
import { assembleFinalDashboard, runNarrativeGenerator, runQueryExecutor, repairFailedQuery } from '@/modules/sql/agent';
import { buildExecutionContext as buildSharedExecutionContext } from '@/lib/execution-context';
import {
    App,
    Button,
    Typography,
    Space,
    Divider,
    Layout,
    Menu,
    Dropdown,
    Result,
    Tag,
    Spin
} from 'antd';
import { ProgressTracker } from "@/components/ui";
import {
    EditOutlined,
    SaveOutlined,
    ReloadOutlined,
    DatabaseOutlined,
    LayoutOutlined,
    ExportOutlined,
    QuestionCircleOutlined,
    UndoOutlined,
    MoreOutlined,
    DashboardOutlined,
    ThunderboltOutlined
} from '@ant-design/icons';



const { Header, Content, Sider } = Layout;
const { Title, Text } = Typography;

export const DashboardRenderView: React.FC = () => {
    const { postgresUrl, dataSources, selectedDataSourceId } = useConfigStore();
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
    const autoApplyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [filtersDirty, setFiltersDirty] = useState(false);
    const {
        userPlan,
        aiPlan,
        userQueries,
        aiQueries,
        executionResults
    } = useWorkflowStore();
    const plan = userPlan || aiPlan;
    const queries = userQueries || aiQueries;
    const selectedConnector = useMemo(() => {
        const connectors = (dataSources || []).filter((ds) => {
            const type = String(ds?.type || "").toLowerCase();
            return type.includes("postgres") || type.includes("mssql") || type.includes("sql") || type.includes("mcp");
        });
        return connectors.find((ds) => ds.id === selectedDataSourceId) || connectors.find((ds) => Boolean(ds.connectionString)) || null;
    }, [dataSources, selectedDataSourceId]);
    const resolvedConnectionString = selectedConnector?.connectionString || postgresUrl || schemaData?.connectionString || undefined;
    const resolvedConnectorType = selectedConnector?.type || schemaData?.connectorType || "";
    const resolvedConnectorInstructions = selectedConnector?.instructions || schemaData?.connectorInstructions || "";

    const { modal, message: messageApi } = App.useApp();
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

    const cardShellStyle = {
        borderRadius: 16,
        border: '1px solid rgba(148, 163, 184, 0.12)',
        background: 'linear-gradient(135deg, rgba(15, 23, 42, 0.85), rgba(2, 6, 23, 0.9))',
        boxShadow: '0 18px 38px rgba(2, 8, 23, 0.45)'
    } as const;

    const dateFilters = useMemo(() => {
        return (dashboard?.filters || []).filter((f: any) => f.type === "date-range");
    }, [dashboard]);

    const statCardStyle = {
        padding: 16,
        borderRadius: 14,
        background: 'rgba(15, 23, 42, 0.7)',
        border: '1px solid rgba(148,163,184,0.12)'
    } as const;

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

    // Important: activeFilters is a Map that may mutate without reference changes.
    // Build the key from entries on every render so pagination/search updates always trigger auto-apply.
    const filterKey = JSON.stringify(Object.fromEntries(Array.from(activeFilters.entries())));

    const widgetStats = useMemo(() => {
        const total = widgets.length;
        const kpis = widgets.filter((w: any) => w.type === 'kpi').length;
        const charts = widgets.filter((w: any) => ['line', 'bar', 'area', 'pie', 'donut', 'scatter', 'map', 'funnel', 'cohort'].includes(w.type)).length;
        const tables = widgets.filter((w: any) => w.type === 'table').length;
        return { total, kpis, charts, tables };
    }, [widgets]);

    const findWidgetResult = (widgetId: string) => {
        // Prefer fresh executor results so KPIs/charts stay live
        const widgetMeta = dashboard?.widgets?.find((w: any) => w.id === widgetId);
        const latestResult = executionResults?.find((r: any) =>
            r.id === widgetId ||
            r.id === widgetMeta?.queryId ||
            (widgetMeta?.title && r.title && r.title.toLowerCase() === widgetMeta.title.toLowerCase())
        );
        if (latestResult) return latestResult;

        // Fallback: match via query mapping
        const mappedQuery = dashboard?.queries?.find((q: any) => q.widgetIds?.includes?.(widgetId));
        if (mappedQuery) {
            const mappedResult = executionResults?.find((r: any) => r.id === mappedQuery.id);
            if (mappedResult) return mappedResult;
        }

        // 1. Check live partial results (streaming)
        const streamResults = partialResults.get(`q_${widgetId}`) || partialResults.get(widgetId);
        if (streamResults) {
            return { data: streamResults };
        }

        // 2. Check query-mapped results
        const query = dashboard?.queries?.find((q: any) => q.widgetIds.includes(widgetId));
        if (query?.id && partialResults.has(query.id)) {
            return { data: partialResults.get(query.id) };
        }

        // 3. Fallback to data already in the widget object
        const widget = dashboard?.widgets?.find((w: any) => w.id === widgetId);
        return { data: widget?.data };
    };

    const getWidgetData = (widgetId: string) => {
        const result = findWidgetResult(widgetId);
        return result?.data;
    };

    const getWidgetMeta = (widgetId: string) => {
        const result = findWidgetResult(widgetId);
        if (typeof result?.totalRows === "number" && Number.isFinite(result.totalRows)) {
            return { totalRows: result.totalRows };
        }
        return undefined;
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
    const needsAssemble = !dashboard || staleStep === 5;

    useEffect(() => {
        if (!needsAssemble || assemblingRef.current) return;
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
    }, [needsAssemble, plan, queries, executionResults, setDashboard, setStaleStep, schemaData]);

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
        if (!resolvedConnectionString) {
            enqueueMessage(() => messageApi.error({ content: 'No SQL connection found. Connect a data source first.', key: 'filter-refresh', duration: 4 }));
            return;
        }

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
                    errorLog: sqlErrorLog,
                    connectorInstructions: resolvedConnectorInstructions,
                    connectorType: resolvedConnectorType,
                    connectionString: resolvedConnectionString
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

            const executionContext = buildSharedExecutionContext({
                planFilters: plan?.filters || [],
                activeFilters,
                candidateWidgets: (dashboard?.widgets && dashboard.widgets.length > 0) ? dashboard.widgets : (plan.widgets || []),
                includeTotal: true,
                allowGlobalFallback: true
            });

            const data = await runQueryExecutor(queryMap, resolvedConnectionString, {
                connectorInstructions: resolvedConnectorInstructions,
                connectorType: resolvedConnectorType,
                tablePagination: executionContext.tablePagination,
                runtimeParams: executionContext.runtimeParams
            });
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
                        connectionString: resolvedConnectionString
                    });
                    query.sql = repairResult.sql;
                    const rerun = await runQueryExecutor({ [res.id]: repairResult.sql }, resolvedConnectionString, {
                        connectorInstructions: resolvedConnectorInstructions,
                        connectorType: resolvedConnectorType,
                        tablePagination: executionContext.tablePagination,
                        runtimeParams: executionContext.runtimeParams
                    });
                    const fixed = rerun[res.id];
                    resultsList = resultsList.map((r: any) =>
                        r.id === res.id ? { ...fixed, id: res.id, title: res.title } : r
                    );
                } catch (err) {
                    // keep original error result
                }
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
        messageApi,
        resolvedConnectionString,
        resolvedConnectorInstructions,
        resolvedConnectorType,
        markFiltersActivated
    ]);

    const reexecuteCurrentQueries = useCallback(async () => {
        const plan = userPlan || aiPlan;
        const queriesList = userQueries || aiQueries;
        if (!plan || !queriesList || !schemaData) return;
        if (!resolvedConnectionString) {
            enqueueMessage(() => messageApi.error({ content: 'No SQL connection found. Connect a data source first.', key: 'filter-refresh', duration: 4 }));
            return;
        }

        try {
            markFiltersActivated();
            setProcessing(true);
            enqueueMessage(() => messageApi.loading({ content: 'Applying pagination...', key: 'filter-refresh', duration: 0 }));

            const queryMap: Record<string, string> = {};
            queriesList.forEach((q: any) => {
                queryMap[q.id] = q.sql;
            });

            const executionContext = buildSharedExecutionContext({
                planFilters: plan?.filters || [],
                activeFilters,
                candidateWidgets: (dashboard?.widgets && dashboard.widgets.length > 0) ? dashboard.widgets : (plan.widgets || []),
                includeTotal: true,
                allowGlobalFallback: true
            });

            const data = await runQueryExecutor(queryMap, resolvedConnectionString, {
                connectorInstructions: resolvedConnectorInstructions,
                connectorType: resolvedConnectorType,
                tablePagination: executionContext.tablePagination,
                runtimeParams: executionContext.runtimeParams
            });

            const resultsList = Object.entries(data).map(([id, result]: [string, any]) => ({
                id,
                ...result,
                title: queriesList.find((q: any) => q.id === id)?.title || id
            }));

            setExecutionResults(resultsList);
            let insights: string[] = [];
            try {
                insights = await runNarrativeGenerator(resultsList as any[]);
            } catch {
                insights = [];
            }
            const finalDash = await assembleFinalDashboard(plan, queriesList as any[], resultsList as any[], insights, schemaData?.filterCandidates);
            setDashboard(finalDash as any);
            setStaleStep(null);
            lastAppliedFiltersRef.current = filterKey;
            setFiltersDirty(false);
            enqueueMessage(() => messageApi.success({ content: 'Pagination applied.', key: 'filter-refresh' }));
        } catch (err: any) {
            enqueueMessage(() => messageApi.error({ content: `Pagination update failed: ${err.message}`, key: 'filter-refresh', duration: 4 }));
        } finally {
            setProcessing(false);
        }
    }, [
        userPlan,
        aiPlan,
        userQueries,
        aiQueries,
        schemaData,
        activeFilters,
        dashboard?.widgets,
        resolvedConnectionString,
        resolvedConnectorInstructions,
        resolvedConnectorType,
        setProcessing,
        enqueueMessage,
        messageApi,
        setExecutionResults,
        setDashboard,
        setStaleStep,
        filterKey,
        markFiltersActivated
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

    useEffect(() => {
        if (!dashboard || !filtersDirty) return;
        const searchDimensions = new Set(
            (dashboard.filters || [])
                .filter((f: any) => f?.type === "search")
                .map((f: any) => f?.dimension)
                .filter(Boolean)
        );
        searchDimensions.add("__search");
        searchDimensions.add("__searchColumn");

        let currentFilters: Record<string, any> = {};
        let lastApplied: Record<string, any> = {};
        try {
            currentFilters = JSON.parse(filterKey || "{}");
            lastApplied = JSON.parse(lastAppliedFiltersRef.current || "{}");
        } catch {
            return;
        }

        const changedKeys = new Set<string>([
            ...Object.keys(currentFilters || {}),
            ...Object.keys(lastApplied || {})
        ].filter((key) => JSON.stringify(currentFilters?.[key]) !== JSON.stringify(lastApplied?.[key])));

        if (changedKeys.size === 0) return;

        const isPaginationOnly = Array.from(changedKeys).every(
            (key) => key.startsWith("__page:") || key.startsWith("__pageSize:") || key.startsWith("__offset:")
        );
        const hasSearchChange = Array.from(changedKeys).some((key) =>
            searchDimensions.has(key) || key.startsWith("__searchColumn:")
        );

        if (!isPaginationOnly && !hasSearchChange) return;

        if (autoApplyTimeoutRef.current) {
            clearTimeout(autoApplyTimeoutRef.current);
        }
        autoApplyTimeoutRef.current = setTimeout(() => {
            if (isPaginationOnly && !hasSearchChange) {
                reexecuteCurrentQueries();
                return;
            }
            regenerateWithFilters();
        }, hasSearchChange ? 450 : 150);

        return () => {
            if (autoApplyTimeoutRef.current) {
                clearTimeout(autoApplyTimeoutRef.current);
            }
        };
    }, [dashboard, filterKey, filtersDirty, regenerateWithFilters, reexecuteCurrentQueries]);

    const canAssemble = Boolean(plan && queries && executionResults);
    if (!dashboard || staleStep === 5) {
        if (canAssemble) {
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
        const stages = [
            { id: 'prepare', label: 'Preparing dashboard data', status: 'in_progress' as const },
            { id: 'assemble', label: 'Assembling dashboard', status: 'pending' as const },
            { id: 'render', label: 'Rendering widgets', status: 'pending' as const },
            { id: 'finalize', label: 'Finalizing layout', status: 'pending' as const },
        ];

        return (
            <div style={{ padding: '64px 24px', display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 400 }}>
                <div style={{ maxWidth: 600, width: '100%' }}>
                    <div style={{ marginBottom: 32, textAlign: 'center' }}>
                        <Title level={3} style={{ margin: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                            <span style={{ fontSize: 28 }}>📊</span>
                            Assembling Dashboard
                        </Title>
                        <Text type="secondary">
                            Crunching results and rendering widgets
                        </Text>
                    </div>
                    
                    <ProgressTracker 
                        stages={stages}
                        title="Dashboard Assembly"
                        showOverallProgress={true}
                    />
                </div>
            </div>
        );
    }

    return (
        <Layout className="h-full bg-transparent overflow-hidden">
            <Header style={{ background: 'transparent', padding: '0 24px', height: 'auto', marginBottom: 16 }}>
                <div style={{ ...cardShellStyle, padding: '18px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16 }}>
                    <div>
                        <Title level={4} style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
                            <LayoutOutlined />
                            {dashboard?.name || 'Executive Dashboard'}
                        </Title>
                        <Space size={10} wrap>
                            <Text type="secondary" style={{ fontSize: 12 }}>
                                Last updated: {dashboard?.updatedAt ? new Date(dashboard.updatedAt).toLocaleTimeString() : '—'}
                            </Text>
                            <Tag color="blue">Live Data</Tag>
                            <Tag color="geekblue">Step 5 of 5</Tag>
                            <Tag color="cyan">Widgets {widgetStats.total}</Tag>
                        </Space>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        {dateFilters.length > 0 && (
                            <FilterBar filters={dateFilters} variant="compact" />
                        )}
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
                </div>
            </Header>

            <Layout className="bg-transparent overflow-hidden">
                <Sider
                    width={300}
                    style={{
                        background: 'linear-gradient(180deg, rgba(10,14,20,0.95), rgba(7,10,15,0.98))',
                        borderRight: '1px solid rgba(148,163,184,0.12)',
                        order: 2
                    }}
                    className="p-4"
                    collapsible
                    reverseArrow
                >
                    <div style={{ ...cardShellStyle, padding: 16, marginBottom: 16 }}>
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
                        <div style={{ marginTop: 12, maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
                            <FilterBar filters={dashboard.filters || []} />
                        </div>
                    </div>
                </Sider>

                <Content className="overflow-auto p-4 relative" style={{ order: 1 }}>
                    <DashboardCanvas
                        widgets={widgets}
                        layout={layout as any}
                        isEditing={isEditMode}
                        onWidgetClick={(id) => isEditMode && selectWidget(id)}
                        getWidgetData={getWidgetData}
                        getWidgetMeta={getWidgetMeta}
                    />
                </Content>
            </Layout>
        </Layout>
    );
};

'use client';

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useWorkflowStore, useDashboardStore, useConfigStore } from '@/state/stores';
import { runQueryExecutor, assembleFinalDashboard, runNarrativeGenerator, repairFailedQuery } from '@/modules/sql/agent';
import { runSchemaDiscovery } from '@/modules/schema/agent';
import { buildExecutionContext as buildSharedExecutionContext } from '@/lib/execution-context';
import { getPaginationForId, toRecordFromFilterMap } from '@/lib/pagination';
import {
    App,
    Button,
    Card,
    Typography,
    Space,
    Spin,
    Alert,
    Tag,
    Table,
    Progress,
    Tooltip
} from 'antd';
import { ProgressTracker } from "@/components/ui";
import {
    ReloadOutlined,
    ArrowRightOutlined,
    PlayCircleOutlined,
    ClockCircleOutlined,
    TableOutlined,
    ToolOutlined,
    DatabaseOutlined,
    ThunderboltOutlined,
    CheckCircleOutlined
} from '@ant-design/icons';
import styles from './QueryExecutorView.module.css';

const { Title, Text } = Typography;

export const QueryExecutorView: React.FC = () => {
    const { postgresUrl, mssqlUrl, projectContext, dataSources, selectedDataSourceId } = useConfigStore();
    const {
        userPlan,
        aiPlan,
        userQueries,
        aiQueries,
        schemaData,
        setSchemaData,
        setUserQueries,
        executionResults,
        setExecutionResults,
        isProcessing,
        setProcessing,
        error,
        setError,
        setStep,
        staleStep,
        setStaleStep,
        addSqlError,
        sqlErrorLog
    } = useWorkflowStore();

    const { message: messageApi } = App.useApp();
    const messageQueueRef = useRef<Array<() => void>>([]);
    const [messageTick, setMessageTick] = useState(0);
    const enqueueMessage = useCallback((fn: () => void) => {
        messageQueueRef.current.push(fn);
        setMessageTick((tick) => tick + 1);
    }, []);
    const [repairingIds, setRepairingIds] = useState<Set<string>>(new Set());
    const { setDashboard, activeFilters } = useDashboardStore();
    const selectedConnector = useMemo(() => {
        if (selectedDataSourceId) {
            return dataSources.find(ds => ds.id === selectedDataSourceId) || null;
        }
        // Fallback to first SQL/MCP source if nothing selected
        return dataSources.find(ds => {
            const type = String(ds.type || "").toLowerCase();
            return type.includes("postgres") || type.includes("mssql") || type.includes("sql") || type.includes("mcp");
        }) || null;
    }, [dataSources, selectedDataSourceId]);

    const resolvedConnectionString = selectedConnector?.connectionString ||
        schemaData?.connectionString ||
        (selectedConnector?.type === 'MSSQL' ? mssqlUrl : postgresUrl) ||
        undefined;
    const resolvedConnectorType = selectedConnector?.type || schemaData?.connectorType || "";
    const resolvedConnectorInstructions = selectedConnector?.instructions || schemaData?.connectorInstructions || "";
    const normalizeError = (err: any) => {
        if (!err) return 'Execution failed';
        if (typeof err === 'string') return err;
        try {
            return JSON.stringify(err);
        } catch {
            return String(err);
        }
    };
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
                connectionString: resolvedConnectionString,
                filterCandidates: null,
                rawAnalysis: "Loaded schema from local selection.",
                filterSummary: ""
            });
        } catch {
            // ignore localStorage parse errors
        }
    }, [schemaData, setSchemaData, resolvedConnectionString]);

    const handleExecute = async () => {
        const queriesToRun = userQueries || aiQueries;
        if (!queriesToRun) return;
        const plan = userPlan || aiPlan;
        if (!resolvedConnectionString) {
            setError("No SQL connection found. Connect a data source first.");
            return;
        }

        setProcessing(true);
        setError(null);

        // Convert array back to record for the agent
        const queryMap: Record<string, string> = {};
        queriesToRun.forEach((q: any) => {
            queryMap[q.id] = q.sql;
        });
        const executionContext = buildSharedExecutionContext({
            planFilters: plan?.filters || [],
            activeFilters,
            candidateWidgets: plan?.widgets || [],
            includeTotal: true,
            allowGlobalFallback: true
        });
        const tablePagination = executionContext.tablePagination;
        const runtimeParams = executionContext.runtimeParams;

        try {
            const data = await runQueryExecutor(queryMap, resolvedConnectionString, {
                connectorInstructions: resolvedConnectorInstructions,
                connectorType: resolvedConnectorType,
                tablePagination,
                runtimeParams
            });
            // Convert Record to array for display
            const resultsList = Object.entries(data).map(([id, result]: [string, any]) => ({
                id,
                ...result,
                title: queriesToRun.find((q: any) => q.id === id)?.title || id
            }));
            setExecutionResults(resultsList);

            // Log any errors
            resultsList.forEach((res: any) => {
                if (res.status === 'error') {
                    addSqlError({
                        id: res.id,
                        title: res.title,
                        error: normalizeError(res.error)
                    });
                }
            });

            // Auto-repair any errors immediately after execution
            const plan = userPlan || aiPlan;
            if (plan && schemaData) {
                let workingResults = resultsList;
                let workingQueries = queriesToRun;

                for (const res of resultsList) {
                    if (res.status === 'error') {
                        const widgetInfo = plan.widgets?.find((w: any) => w.id === res.id);
                        const originalSql = workingQueries?.find((q: any) => q.id === res.id)?.sql;
                        if (!widgetInfo || !originalSql) continue;
                        try {
                            enqueueMessage(() => messageApi.loading({ content: `Auto-repairing ${widgetInfo.title || res.id}...`, key: `repair-${res.id}`, duration: 0 }));
                            const repairResult = await repairFailedQuery({
                                widgetId: res.id,
                                widgetTitle: widgetInfo.title || res.id,
                                widgetType: widgetInfo.type || 'unknown',
                                widgetGoal: widgetInfo.goal,
                                originalSql: originalSql,
                                errorMessage: res.error || 'Execution failed',
                                schema: schemaData,
                                errorLog: sqlErrorLog,
                                connectionString: resolvedConnectionString
                            });
                            // Update queries with repaired SQL using latest edits
                            workingQueries = (workingQueries || []).map((q: any) =>
                                q.id === res.id ? { ...q, sql: repairResult.sql } : q
                            );
                            setUserQueries(workingQueries);

                            // Re-execute repaired query
                            const rerun = await runQueryExecutor({ [res.id]: repairResult.sql }, resolvedConnectionString, {
                                connectorInstructions: resolvedConnectorInstructions,
                                connectorType: resolvedConnectorType,
                                tablePagination: tablePagination[res.id]
                                    ? { [res.id]: tablePagination[res.id] }
                                    : undefined,
                                runtimeParams
                            });
                            const fixed = rerun[res.id];

                            // Merge result onto the latest result set to avoid overwriting prior repairs
                            workingResults = (workingResults || []).map((r: any) =>
                                r.id === res.id
                                    ? { ...fixed, id: res.id, title: widgetInfo.title, repairedSql: repairResult.sql, repairExplanation: repairResult.explanation }
                                    : r
                            );
                            setExecutionResults(workingResults);
                            enqueueMessage(() => messageApi.success({ content: `Auto-repair succeeded for ${widgetInfo.title || res.id}`, key: `repair-${res.id}` }));
                        } catch (repairErr: any) {
                            addSqlError({
                                id: res.id,
                                title: widgetInfo?.title || res.id,
                                error: repairErr.message || 'Auto-repair failed'
                            });
                            enqueueMessage(() => messageApi.error({ content: `Auto-repair failed for ${widgetInfo?.title || res.id}: ${repairErr.message}`, key: `repair-${res.id}` }));
                        }
                    }
                }
            }
            // Clear stale flag for this step and downstream if successful
            if (staleStep === 4) setStaleStep(null);
        } catch (err: any) {
            setError(err.message);
        } finally {
            setProcessing(false);
        }
    };

    const handleSmartRetry = async (queryId: string, errorMessage: string, originalSql: string) => {
        let currentSchema = schemaData;
        const queryToRun = userQueries?.find((q: any) => q.id === queryId) || aiQueries?.find((q: any) => q.id === queryId);
        const plan = userPlan || aiPlan;
        const widgetInfo = plan?.widgets?.find((w: any) => w.id === queryId);

        console.log(`[SQL_REPAIR] Starting repair for ${queryId}. Query exists: ${!!queryToRun}, Schema exists: ${!!currentSchema}`);

        if (!queryToRun) {
            console.error(`[SQL_REPAIR] Query definition not found for ID: ${queryId}`);
            enqueueMessage(() => messageApi.error('Query definition missing. Please regenerate queries.'));
            return;
        }

        if (!currentSchema) {
            try {
                enqueueMessage(() => messageApi.loading({ content: 'Context missing. Refreshing schema...', key: 'schema_sync' }));
                console.log("[SQL_REPAIR] Schema missing from state, re-fetching...");
                const storedTablesRaw = localStorage.getItem('schema_selected_tables');
                const allowedTables = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
                if (!resolvedConnectionString) {
                    throw new Error("No SQL connection string available.");
                }
                currentSchema = await runSchemaDiscovery(resolvedConnectionString, { projectContext }, allowedTables);
                setSchemaData(currentSchema);
                enqueueMessage(() => messageApi.success({ content: 'Schema context restored.', key: 'schema_sync' }));
            } catch (err: any) {
                console.error("[SQL_REPAIR] Failed to restore schema context:", err);
                enqueueMessage(() => messageApi.error({ content: 'Could not retrieve database schema. Please go back to Step 1.', key: 'schema_sync' }));
                return;
            }
        }

        // Mark this query as being repaired
        setRepairingIds(prev => new Set(prev).add(queryId));

        // Update status to show repairing
        const updatedResults = executionResults?.map((r: any) =>
            r.id === queryId ? { ...r, status: 'repairing', error: undefined } : r
        );
        setExecutionResults(updatedResults);

        try {
            enqueueMessage(() => messageApi.loading({ content: 'AI is analyzing and fixing the query...', key: queryId, duration: 0 }));

            // Call the LLM to repair the query
            const repairResult = await repairFailedQuery({
                widgetId: queryId,
                widgetTitle: queryToRun.title || widgetInfo?.title || queryId,
                widgetType: widgetInfo?.type || 'unknown',
                widgetGoal: widgetInfo?.goal,
                originalSql: originalSql,
                errorMessage: errorMessage,
                schema: currentSchema,
                errorLog: sqlErrorLog,
                connectionString: resolvedConnectionString
            });

            enqueueMessage(() => messageApi.success({ content: `Fixed: ${repairResult.explanation}`, key: queryId, duration: 3 }));

            // Update the query in userQueries with the fixed SQL
            const currentQueries = userQueries || aiQueries || [];
            const updatedQueries = currentQueries.map((q: any) =>
                q.id === queryId ? { ...q, sql: repairResult.sql } : q
            );
            setUserQueries(updatedQueries);

            // Now execute the repaired query
            const data = await runQueryExecutor({ [queryId]: repairResult.sql }, resolvedConnectionString, {
                connectorInstructions: resolvedConnectorInstructions,
                connectorType: resolvedConnectorType,
                tablePagination: (() => {
                    return {
                        [queryId]: {
                            ...getPaginationForId(toRecordFromFilterMap(activeFilters), queryId, {
                                includeTotal: true,
                                allowGlobalFallback: true
                            }),
                            includeTotal: true
                        }
                    };
                })(),
                runtimeParams: buildSharedExecutionContext({
                    planFilters: (userPlan || aiPlan)?.filters || [],
                    activeFilters,
                    candidateWidgets: [],
                    includeTotal: true,
                    allowGlobalFallback: true
                }).runtimeParams
            });
            const newItem = data[queryId];

            const finalResults = executionResults?.map((r: any) =>
                r.id === queryId ? {
                    id: queryId,
                    ...newItem,
                    title: queryToRun.title,
                    repairedSql: repairResult.sql,
                    repairExplanation: repairResult.explanation
                } : r
            );
            setExecutionResults(finalResults);

            if (newItem.status === 'success') {
                enqueueMessage(() => messageApi.success('Query repaired and executed successfully!'));
            } else {
                enqueueMessage(() => messageApi.warning('Query was repaired but still has issues. Consider manual editing.'));
            }
        } catch (err: any) {
            enqueueMessage(() => messageApi.destroy(queryId));
            enqueueMessage(() => messageApi.error(`Repair failed: ${err.message}`));

            // Update error state for this query
            const failedResults = executionResults?.map((r: any) =>
                r.id === queryId ? { ...r, status: 'error', error: `Repair failed: ${err.message}` } : r
            );
            setExecutionResults(failedResults);
        } finally {
            setRepairingIds(prev => {
                const next = new Set(prev);
                next.delete(queryId);
                return next;
            });
        }
    };

    const handleFinish = async () => {
        const plan = userPlan || aiPlan;
        const queries = userQueries || aiQueries;
        if (!plan || !queries || !executionResults) return;

        setProcessing(true);
        enqueueMessage(() => messageApi.loading({ content: 'Analyzing results and generating executive summary...', key: 'assemble', duration: 0 }));

        try {
            console.log("[DASHBOARD] Assembly started with:", {
                hasPlan: !!plan,
                widgetCount: plan?.widgets?.length,
                hasQueries: !!queries,
                resultCount: executionResults?.length
            });

            // Step A: Narrative Generation (Analytical Layer)
            let insights: string[] = [];
            try {
                insights = await runNarrativeGenerator(executionResults as any[]);
            } catch (insErr) {
                console.warn("[DASHBOARD] Narrative generation failed:", insErr);
                insights = ["Data retrieval successful. Full analysis ready for inspection."];
            }

            // Step B: Final Assembly (Visual Layer)
            const finalDash = await assembleFinalDashboard(plan, queries as any[], executionResults as any[], insights, schemaData?.filterCandidates);

            if (!finalDash || !finalDash.widgets || finalDash.widgets.length === 0) {
                throw new Error("Generated dashboard has no widgets. Plan parsing might have failed.");
            }

            console.log("[DASHBOARD] Assembly complete, switching to Step 5");
            setDashboard(finalDash as any);
            setStep(5);
            enqueueMessage(() => messageApi.success({ content: 'Dashboard ready!', key: 'assemble' }));
        } catch (err: any) {
            console.error("[DASHBOARD] Assembly error:", err);
            setError(err.message);
            enqueueMessage(() => messageApi.error({ content: `Failed to assemble dashboard: ${err.message}`, key: 'assemble', duration: 5 }));
        } finally {
            messageApi.destroy('assemble');
            setProcessing(false);
        }
    };

    useEffect(() => {
        return () => {
            messageApi.destroy('assemble');
        };
    }, []);

    // Auto-execute when arriving on step 4 with stale or missing results.
    useEffect(() => {
        if ((!executionResults || staleStep === 4) && !isProcessing && (userQueries || aiQueries)) {
            handleExecute();
        }
    }, [executionResults, staleStep, userQueries, aiQueries, isProcessing]);

    if (isProcessing && !executionResults) {
        const stages = [
            { 
                id: 'connect', 
                label: 'Connecting to database', 
                status: 'completed' as const,
                message: 'Secure connection established'
            },
            { 
                id: 'execute', 
                label: 'Executing queries', 
                status: 'in_progress' as const,
                message: 'Running SQL queries...'
            },
            { 
                id: 'retrieve', 
                label: 'Retrieving results', 
                status: 'pending' as const,
                message: 'Fetching data from database'
            },
            { 
                id: 'process', 
                label: 'Processing results', 
                status: 'pending' as const,
                message: 'Formatting and preparing data'
            }
        ];
        
        return (
            <div style={{ 
                display: 'flex', 
                flexDirection: 'column', 
                alignItems: 'center', 
                justifyContent: 'center', 
                height: '100%', 
                padding: 40,
                background: 'radial-gradient(ellipse at top, rgba(99, 102, 241, 0.1) 0%, transparent 50%)'
            }}>
                <div style={{ 
                    maxWidth: 500, 
                    width: '100%' 
                }}>
                    <div style={{ 
                        textAlign: 'center', 
                        marginBottom: 32 
                    }}>
                        <div style={{ 
                            fontSize: 48, 
                            marginBottom: 16,
                        }}>
                            <DatabaseOutlined style={{ 
                                color: '#6366f1',
                                animation: 'pulse 1.5s ease-in-out infinite'
                            }} />
                        </div>
                        <Title level={3} style={{ color: '#fff', margin: 0 }}>
                            Executing SQL Queries
                        </Title>
                        <Text type="secondary">
                            Connecting to database and running queries
                        </Text>
                    </div>
                    
                    <ProgressTracker 
                        stages={stages}
                        title="Query Execution"
                        showOverallProgress={true}
                    />
                </div>
            </div>
        );
    }

    const successCount = executionResults?.filter((r: any) => r.status === 'success').length || 0;
    const totalCount = executionResults?.length || 0;
    const failedCount = executionResults?.filter((r: any) => r.status === 'error').length || 0;
    const repairingCount = executionResults?.filter((r: any) => r.status === 'repairing').length || 0;
    const totalRows = executionResults?.reduce((acc: number, r: any) => acc + (Array.isArray(r.data) ? r.data.length : 0), 0) || 0;
    const progressPercent = totalCount > 0 ? Math.round((successCount / totalCount) * 100) : 0;

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <div className={styles.headerMain}>
                    <Title level={2} className={styles.pageTitle}>
                        <PlayCircleOutlined className={styles.titleIcon} />
                        Data Execution
                    </Title>
                    <div className={styles.metaRow}>
                        <Tag color="blue">Step 4 of 5</Tag>
                        <Text type="secondary">Run queries and review results</Text>
                    </div>
                    <Progress
                        className={styles.progress}
                        percent={progressPercent}
                        size="small"
                        status={failedCount > 0 ? 'exception' : 'active'}
                        format={() => `${successCount}/${totalCount || 0} successful`}
                    />
                </div>
                <Space className={styles.actions}>
                    <Button icon={<ReloadOutlined />} onClick={handleExecute} loading={isProcessing}>
                        Run Queries
                    </Button>
                    <Button
                        type="primary"
                        icon={<ArrowRightOutlined />}
                        onClick={handleFinish}
                        disabled={!executionResults || isProcessing}
                    >
                        Continue
                    </Button>
                </Space>
            </div>

            <div className={styles.kpiGrid}>
                <Card size="small" className={styles.kpiCard}>
                    <Text type="secondary" className={styles.kpiLabel}>Successful</Text>
                    <div className={styles.kpiValue}>{successCount}</div>
                </Card>
                <Card size="small" className={styles.kpiCard}>
                    <Text type="secondary" className={styles.kpiLabel}>Failed</Text>
                    <div className={styles.kpiValue}>{failedCount}</div>
                </Card>
                <Card size="small" className={styles.kpiCard}>
                    <Text type="secondary" className={styles.kpiLabel}>Repairing</Text>
                    <div className={styles.kpiValue}>{repairingCount}</div>
                </Card>
                <Card size="small" className={styles.kpiCard}>
                    <Text type="secondary" className={styles.kpiLabel}>Rows Retrieved</Text>
                    <div className={styles.kpiValue}>{totalRows}</div>
                </Card>
            </div>

            {error && (
                <Alert
                    title={<span style={{ color: '#fff' }}>Execution Alert</span>}
                    description={<span style={{ color: 'rgba(255, 255, 255, 0.7)' }}>{error}</span>}
                    type="error"
                    showIcon
                    className={styles.errorBanner}
                />
            )}

            {!executionResults?.length && !isProcessing && (
                <Card className={styles.emptyState}>
                    <Text type="secondary">No query results yet. Click <Text strong>Run Queries</Text> to execute this step.</Text>
                </Card>
            )}

            <div className={styles.resultsGrid}>
                {executionResults?.map((res: any) => (
                    <Card
                        key={res.id}
                        size="small"
                        className={styles.resultCard}
                        title={
                            <Space className={styles.cardTitleWrap}>
                                <Text strong className={styles.cardTitle}>{res.title}</Text>
                                <Tag color={res.status === 'success' ? 'success' : 'error'}>
                                    {res.status === 'success' ? 'READY' : res.status === 'repairing' ? 'REPAIRING' : 'FAILED'}
                                </Tag>
                                {res.repairedSql && <Tag color="processing">REPAIRED</Tag>}
                            </Space>
                        }
                        extra={
                            <Space>
                                {res.executionTime && (
                                    <Tooltip title="Execution Time">
                                        <Text type="secondary" style={{ fontSize: 12 }}>
                                            <ClockCircleOutlined /> {res.executionTime}
                                        </Text>
                                    </Tooltip>
                                )}
                            </Space>
                        }
                    >
                        {res.status === 'success' ? (
                            <div className={styles.successBody}>
                                <div className={styles.resultMeta}>
                                    <Text type="secondary" className={styles.metaText}><TableOutlined /> {res.data?.length || 0} rows retrieved</Text>
                                    {res.repairExplanation && <Text className={styles.repairNote}>{res.repairExplanation}</Text>}
                                </div>
                                <Table
                                    size="small"
                                    pagination={false}
                                    dataSource={res.data?.slice(0, 3)}
                                    className={styles.previewTable}
                                    columns={Object.keys(res.data?.[0] || {})
                                        .filter(key => key !== '__rowKey')
                                        .map(key => ({
                                            title: key,
                                            dataIndex: key,
                                            key: key,
                                            render: (val: any) => (
                                                <div className={styles.cellValue}>
                                                    {String(val)}
                                                </div>
                                            )
                                        }))}
                                    rowKey="__rowKey"
                                />
                            </div>
                        ) : res.status === 'repairing' ? (
                            <div className={styles.repairingState}>
                                <Spin />
                                <Text type="secondary">AI is analyzing and fixing the query...</Text>
                            </div>
                        ) : (
                            <Alert
                                title={<span style={{ color: '#fff' }}>Query Failed</span>}
                                description={
                                    <div>
                                        <div style={{ color: 'rgba(255, 255, 255, 0.8)' }}>{res.error}</div>
                                        {res.sql && (
                                            <div style={{ marginTop: 8 }}>
                                                <Text style={{ fontSize: 11, color: 'rgba(255, 255, 255, 0.5)' }}>Original SQL:</Text>
                                                <pre style={{ fontSize: 10, maxHeight: 60, overflow: 'auto', background: '#0a0c10', padding: 8, borderRadius: 4, marginTop: 4, color: '#e6edf3' }}>
                                                    {res.sql}
                                                </pre>
                                            </div>
                                        )}
                                    </div>
                                }
                                type="error"
                                showIcon
                                className={styles.queryError}
                                action={
                                    <Button
                                        size="small"
                                        icon={<ToolOutlined />}
                                        onClick={() => handleSmartRetry(res.id, res.error, res.sql)}
                                        loading={repairingIds.has(res.id)}
                                    >
                                        Fix with AI
                                    </Button>
                                }
                            />
                        )}
                    </Card>
                ))}
            </div>
        </div>
    );
};

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useWorkflowStore, useConfigStore } from '@/state/stores';
import { runSchemaDiscovery } from '@/lib/agents/nodes';
import {
    Button,
    Card,
    Table,
    Tag,
    Typography,
    Space,
    Divider,
    Input,
    Empty,
    Spin,
    Alert,
    Tooltip,
    Badge,
    Switch
} from 'antd';
import {
    ReloadOutlined,
    CheckCircleOutlined,
    ArrowRightOutlined,
    DatabaseOutlined,
    EditOutlined,
    SaveOutlined,
    InfoCircleOutlined
} from '@ant-design/icons';
import styles from './StepView.module.css';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

const TABLE_INSIGHTS_OVERRIDES_KEY = 'schema_table_insights_overrides';
const COLUMN_TOGGLES_KEY = 'schema_column_toggles';
const SELECTED_TABLES_KEY = 'schema_selected_tables';

export const SchemaDiscoveryView: React.FC = () => {
    const {
        schemaData,
        setSchemaData,
        userSchemaNotes,
        setUserSchemaNotes,
        schemaTimestamp,
        isProcessing,
        setProcessing,
        error,
        setError,
        setStep,
        staleStep,
        setStaleStep
    } = useWorkflowStore();
    const { postgresUrl, connectionStatus, projectContext } = useConfigStore();

    const [localLoading, setLocalLoading] = useState(false);
    const [isEditingNotes, setIsEditingNotes] = useState(false);
    const [localNotes, setLocalNotes] = useState(userSchemaNotes || '');
    const [activeTable, setActiveTable] = useState<string | null>(null);
    const [enableSemanticSearch, setEnableSemanticSearch] = useState(false);
    const [enableTableMetrics, setEnableTableMetrics] = useState(true);
    const [insightOverrides, setInsightOverrides] = useState<Record<string, any>>({});
    const [kpiDrafts, setKpiDrafts] = useState<Record<string, string>>({});
    const [filterDrafts, setFilterDrafts] = useState<Record<string, string>>({});
    const [catDrafts, setCatDrafts] = useState<Record<string, string>>({});
    const [numDrafts, setNumDrafts] = useState<Record<string, string>>({});
    const [columnToggles, setColumnToggles] = useState<Record<string, Record<string, { show?: boolean; filterable?: boolean }>>>({});
    const [rawSchemaData, setRawSchemaData] = useState<any | null>(null);
    const autoRefreshMissingRef = useRef(false);

    const loadOverrides = () => {
        try {
            const raw = localStorage.getItem(TABLE_INSIGHTS_OVERRIDES_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    };

    const saveOverrides = (next: Record<string, any>) => {
        setInsightOverrides(next);
        localStorage.setItem(TABLE_INSIGHTS_OVERRIDES_KEY, JSON.stringify(next));
    };

    const loadColumnToggles = () => {
        try {
            const raw = localStorage.getItem(COLUMN_TOGGLES_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch {
            return {};
        }
    };

    const saveColumnToggles = (next: Record<string, Record<string, { show?: boolean; filterable?: boolean }>>) => {
        setColumnToggles(next);
        localStorage.setItem(COLUMN_TOGGLES_KEY, JSON.stringify(next));
    };

    const getColumnToggle = (
        tableName: string,
        columnName: string,
        togglesMap: Record<string, Record<string, { show?: boolean; filterable?: boolean }>> = columnToggles
    ) => {
        const entry = togglesMap[tableName]?.[columnName] || {};
        return {
            show: entry.show ?? true,
            filterable: entry.filterable ?? true
        };
    };

    const buildMergedInsights = (baseInsights: any, overrides: Record<string, any>) => {
        if (!baseInsights) return baseInsights;
        const merged: Record<string, any> = {};

        Object.entries(baseInsights).forEach(([tableName, insight]) => {
            const override = overrides[tableName] || {};
            const base = insight as any;
            const mergedEntry: any = { ...base };

            if (Array.isArray(override.kpis)) {
                mergedEntry.kpis = override.kpis.map((title: string, idx: number) => ({
                    id: `${tableName}_kpi_custom_${idx}`,
                    title,
                    description: "Custom KPI",
                    aggregation: "count",
                    column: undefined
                }));
            }

            if (Array.isArray(override.filters)) {
                mergedEntry.filters = override.filters.map((title: string, idx: number) => ({
                    id: `${tableName}_filter_custom_${idx}`,
                    title,
                    type: "multi_select",
                    column: title,
                    table: tableName
                }));
            }

            if (override.dataMatrix) {
                const baseMatrix = base.dataMatrix || {};
                const categoricalColumns = Array.isArray(override.dataMatrix.categoricalColumns)
                    ? override.dataMatrix.categoricalColumns
                    : [];
                const numericColumns = Array.isArray(override.dataMatrix.numericColumns)
                    ? override.dataMatrix.numericColumns
                    : [];

                mergedEntry.dataMatrix = {
                    ...baseMatrix,
                    categoricalCandidates: categoricalColumns.map((column: string) => ({
                        column,
                        sampleDistinct: 0,
                        sampleValues: []
                    })),
                    numericCandidates: numericColumns.map((column: string) => ({
                        column,
                        type: ""
                    })),
                    columnCounts: {
                        ...baseMatrix.columnCounts,
                        numeric: numericColumns.length,
                        text: categoricalColumns.length
                    }
                };
            }

            merged[tableName] = mergedEntry;
        });

        return merged;
    };

    const applyColumnToggles = (baseData: any, toggles: Record<string, Record<string, { show?: boolean; filterable?: boolean }>>) => {
        if (!baseData) return baseData;
        const maskedSchemaInfo: Record<string, any> = {};
        const maskedSampleData: Record<string, any[]> = {};
        const maskedInsights: Record<string, any> = {};

        Object.entries(baseData.schemaInfo || {}).forEach(([tableName, info]: [string, any]) => {
            const columns = Array.isArray(info?.columns) ? info.columns : [];
            const allowedColumns = columns.filter((col: any) => {
                const name = col?.name || col?.column_name;
                if (!name) return false;
                return getColumnToggle(tableName, name, toggles).show;
            });
            maskedSchemaInfo[tableName] = { ...info, columns: allowedColumns };

            const rows = Array.isArray(baseData.sampleData?.[tableName]) ? baseData.sampleData[tableName] : [];
            const allowedLower = new Set(
                allowedColumns
                    .map((col: any) => col?.name || col?.column_name)
                    .filter(Boolean)
                    .map((name: string) => name.toLowerCase())
            );
            maskedSampleData[tableName] = rows.map((row: any) => {
                const filtered: Record<string, any> = {};
                Object.entries(row || {}).forEach(([key, value]) => {
                    if (key === '__rowKey') {
                        filtered.__rowKey = value;
                        return;
                    }
                    if (allowedLower.has(String(key).toLowerCase())) {
                        filtered[key] = value;
                    }
                });
                return filtered;
            });

            const insight = baseData.tableInsights?.[tableName];
            if (insight) {
                const allowedSet = new Set(allowedColumns.map((c: any) => c?.name || c?.column_name));
                const allowedFilters = (insight.filters || []).filter((f: any) => {
                    if (!f?.column) return false;
                    const toggled = getColumnToggle(tableName, f.column, toggles);
                    return toggled.show && toggled.filterable;
                });
                const filteredMatrix = insight.dataMatrix ? {
                    ...insight.dataMatrix,
                    categoricalCandidates: (insight.dataMatrix.categoricalCandidates || []).filter((c: any) => allowedSet.has(c.column)),
                    numericCandidates: (insight.dataMatrix.numericCandidates || []).filter((c: any) => allowedSet.has(c.column))
                } : undefined;
                const filteredKpis = (insight.kpis || []).filter((k: any) => {
                    if (!k?.column || k.column === "*") return true;
                    return allowedSet.has(k.column);
                });
                maskedInsights[tableName] = {
                    ...insight,
                    filters: allowedFilters,
                    dataMatrix: filteredMatrix,
                    kpis: filteredKpis
                };
            }
        });

        return {
            ...baseData,
            schemaInfo: maskedSchemaInfo,
            sampleData: maskedSampleData,
            tableInsights: maskedInsights
        };
    };

    const buildFilterCandidatesFromTableInsights = (tableInsights: Record<string, any>) => {
        const dateColumns: { table: string; column: string; type: string }[] = [];
        const categoricalColumns: { table: string; column: string; distinct: any[] }[] = [];
        const entityColumns: { viaTable: string; from: string; to: string }[] = [];

        Object.entries(tableInsights || {}).forEach(([tableName, insight]: [string, any]) => {
            const filters = Array.isArray(insight?.filters) ? insight.filters : [];
            filters.forEach((filter: any) => {
                if (filter.type === 'date_range') {
                    dateColumns.push({ table: tableName, column: filter.column, type: 'date' });
                } else if (filter.type === 'multi_select') {
                    categoricalColumns.push({
                        table: tableName,
                        column: filter.column,
                        distinct: filter.sampleValues || []
                    });
                } else if (filter.type === 'entity') {
                    entityColumns.push({
                        viaTable: tableName,
                        from: `${tableName}.${filter.column}`,
                        to: `${filter.targetTable || ''}`.trim()
                    });
                }
            });
        });

        const primaryDate = dateColumns[0];
        const summaryLines: string[] = [];
        if (primaryDate) {
            summaryLines.push(`Date range filter: ${primaryDate.table}.${primaryDate.column}`);
        }
        if (categoricalColumns.length > 0) {
            summaryLines.push(`Categorical filters: ${categoricalColumns.slice(0, 5).map(c => `${c.table}.${c.column}`).join(', ')}${categoricalColumns.length > 5 ? ' ...' : ''}`);
        }
        if (entityColumns.length > 0) {
            summaryLines.push(`Entity filters: ${entityColumns.slice(0, 5).map(e => e.from).join(', ')}${entityColumns.length > 5 ? ' ...' : ''}`);
        }

        return {
            dateColumns,
            categoricalColumns,
            entityColumns,
            primaryDate,
            summary: summaryLines.join('\n') || 'No filterable dimensions detected.'
        };
    };

    const recomputeSchemaData = (nextOverrides?: Record<string, any>, nextColumnToggles?: Record<string, Record<string, { show?: boolean; filterable?: boolean }>>) => {
        if (!rawSchemaData) return;
        const overrides = nextOverrides ?? insightOverrides;
        const toggles = nextColumnToggles ?? columnToggles;
        const mergedInsights = buildMergedInsights(rawSchemaData.tableInsights, overrides);
        const baseData = {
            ...rawSchemaData,
            tableInsights: mergedInsights
        };
        const maskedData = applyColumnToggles(baseData, toggles);
        const filterCandidates = maskedData.tableInsights ? buildFilterCandidatesFromTableInsights(maskedData.tableInsights) : rawSchemaData.filterCandidates;
        const nextData = {
            ...maskedData,
            filterCandidates,
            filterSummary: filterCandidates?.summary || rawSchemaData.filterSummary,
            projectContext
        };
        setSchemaData(nextData);
    };

    const handleDiscover = useCallback(async (overrideOptions?: {
        enableSemanticSearch?: boolean;
        enableTableKpis?: boolean;
        enableTableMatrix?: boolean;
    }) => {
        if (overrideOptions && 'preventDefault' in overrideOptions) {
            overrideOptions = {};
        }
        if (connectionStatus !== "Connected") {
            setError("Connect to a database via the Data Sources panel before running schema discovery.");
            return;
        }

        setProcessing(true);
        setLocalLoading(true);
        setError(null);

        try {
            const tryDiscover = async (attempts: number) => {
                let lastError: any = null;
                for (let i = 0; i < attempts; i++) {
                    try {
                        const data = await runSchemaDiscovery(postgresUrl, {
                            enableSemanticSearch: semanticEnabled,
                            enableTableKpis: tableKpisEnabled,
                            enableTableMatrix: tableMatrixEnabled,
                            enableTableFilters: tableMatrixEnabled,
                            projectContext
                        }, allowedTables);
                        if (data?.tables && data.tables.length > 0) return data;
                        lastError = new Error("Schema discovery returned no tables.");
                    } catch (err: any) {
                        lastError = err;
                    }
                }
                throw lastError || new Error("Schema discovery failed.");
            };
            const semanticEnabled = overrideOptions?.enableSemanticSearch ?? enableSemanticSearch;
            const tableKpisEnabled = true;
            const tableMatrixEnabled = overrideOptions?.enableTableMatrix ?? enableTableMetrics;
            const storedTablesRaw = localStorage.getItem(SELECTED_TABLES_KEY);
            const allowedTables = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
            const data = await tryDiscover(3);
            const storedOverrides = loadOverrides();
            const storedToggles = loadColumnToggles();
            setInsightOverrides(storedOverrides);
            setColumnToggles(storedToggles);
            setRawSchemaData(data);
            const mergedInsights = buildMergedInsights(data.tableInsights, storedOverrides);
            const baseData = { ...data, tableInsights: mergedInsights };
            const maskedData = applyColumnToggles(baseData, storedToggles);
            const filterCandidates = maskedData.tableInsights ? buildFilterCandidatesFromTableInsights(maskedData.tableInsights) : data.filterCandidates;
            const nextData = {
                ...maskedData,
                connectionString: postgresUrl,
                filterCandidates,
                filterSummary: filterCandidates?.summary || data.filterSummary,
                projectContext
            };
            console.log('[SchemaDiscovery] Loaded data:', data);
            setSchemaData(nextData);
            // Clear stale flag for this step if successful
            if (staleStep === 1) setStaleStep(null);
        } catch (err: any) {
            console.error('[SchemaDiscovery] Error:', err);
            setError(err?.message || "No schema selected or found.");
        } finally {
            setProcessing(false);
            setLocalLoading(false);
        }
    }, [connectionStatus, postgresUrl, projectContext, setSchemaData, setError, setProcessing, setLocalLoading, staleStep, setStaleStep, enableSemanticSearch, enableTableMetrics]);

    useEffect(() => {
        if (!rawSchemaData) return;
        const storedOverrides = loadOverrides();
        const storedToggles = loadColumnToggles();
        setInsightOverrides(storedOverrides);
        setColumnToggles(storedToggles);
        recomputeSchemaData(storedOverrides, storedToggles);
    }, [rawSchemaData]);

    useEffect(() => {
        if (!schemaData || rawSchemaData) return;
        const tableCounts = schemaData.tableCounts || Object.fromEntries(
            (schemaData.tables || []).map((table: string) => [
                table,
                Array.isArray(schemaData.sampleData?.[table]) ? schemaData.sampleData[table].length : 0
            ])
        );
        setRawSchemaData({ ...schemaData, tableCounts });
    }, [schemaData, rawSchemaData]);

    useEffect(() => {
        if (!schemaData?.tables?.length) return;
        if (activeTable) return;
        setActiveTable(schemaData.tables[0]);
    }, [schemaData, activeTable]);

    useEffect(() => {
        if (!rawSchemaData) return;
        recomputeSchemaData();
    }, [projectContext]);

    useEffect(() => {
        if (autoRefreshMissingRef.current) return;
        if (!schemaData || isProcessing || localLoading) return;
        const missingProfiles = !schemaData.sampleData || !schemaData.tableInsights;
        if (missingProfiles && connectionStatus === "Connected" && postgresUrl) {
            autoRefreshMissingRef.current = true;
            handleDiscover();
        }
    }, [schemaData, connectionStatus, postgresUrl, isProcessing, localLoading, handleDiscover]);

    useEffect(() => {
        if (autoRefreshMissingRef.current) return;
        if (schemaData?.tables?.length) return;
        if (isProcessing || localLoading) return;
        if (connectionStatus !== "Connected" || !postgresUrl) return;
        const storedTablesRaw = localStorage.getItem(SELECTED_TABLES_KEY);
        const selectedTables = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
        if (!Array.isArray(selectedTables) || selectedTables.length === 0) return;
        autoRefreshMissingRef.current = true;
        handleDiscover();
    }, [schemaData, connectionStatus, postgresUrl, isProcessing, localLoading, handleDiscover]);

    const updateOverridesForTable = (tableName: string, updates: Record<string, any>) => {
        const next = {
            ...insightOverrides,
            [tableName]: {
                ...(insightOverrides[tableName] || {}),
                ...updates
            }
        };
        saveOverrides(next);
        recomputeSchemaData(next);
    };

    const updateColumnToggle = (tableName: string, columnName: string, key: 'show' | 'filterable', value: boolean) => {
        const next = {
            ...columnToggles,
            [tableName]: {
                ...(columnToggles[tableName] || {}),
                [columnName]: {
                    ...(columnToggles[tableName]?.[columnName] || {}),
                    [key]: value,
                    ...(key === 'show' && value === false ? { filterable: false } : {})
                }
            }
        };
        saveColumnToggles(next);
        recomputeSchemaData(undefined, next);
    };

    const showAllColumns = (tableName: string, columns: any[]) => {
        const tableMap: Record<string, { show?: boolean; filterable?: boolean }> = {};
        columns.forEach((col: any) => {
            const name = col?.name || col?.column_name;
            if (!name) return;
            tableMap[name] = { show: true, filterable: true };
        });
        const next = { ...columnToggles, [tableName]: tableMap };
        saveColumnToggles(next);
        recomputeSchemaData(undefined, next);
    };

    const addKpi = (tableName: string) => {
        const draft = (kpiDrafts[tableName] || '').trim();
        if (!draft) return;
        const current = schemaData?.tableInsights?.[tableName]?.kpis?.map((k: any) => k.title) || [];
        updateOverridesForTable(tableName, { kpis: [...current, draft] });
        setKpiDrafts((prev) => ({ ...prev, [tableName]: '' }));
    };

    const removeKpi = (tableName: string, title: string) => {
        const current = schemaData?.tableInsights?.[tableName]?.kpis?.map((k: any) => k.title) || [];
        updateOverridesForTable(tableName, { kpis: current.filter((kpi: string) => kpi !== title) });
    };

    const addFilter = (tableName: string) => {
        const draft = (filterDrafts[tableName] || '').trim();
        if (!draft) return;
        const current = schemaData?.tableInsights?.[tableName]?.filters?.map((f: any) => f.title) || [];
        updateOverridesForTable(tableName, { filters: [...current, draft] });
        setFilterDrafts((prev) => ({ ...prev, [tableName]: '' }));
    };

    const removeFilter = (tableName: string, title: string) => {
        const current = schemaData?.tableInsights?.[tableName]?.filters?.map((f: any) => f.title) || [];
        updateOverridesForTable(tableName, { filters: current.filter((f: string) => f !== title) });
    };

    const addCategorical = (tableName: string) => {
        const draft = (catDrafts[tableName] || '').trim();
        if (!draft) return;
        const current = schemaData?.tableInsights?.[tableName]?.dataMatrix?.categoricalCandidates?.map((c: any) => c.column) || [];
        updateOverridesForTable(tableName, {
            dataMatrix: {
                ...(insightOverrides[tableName]?.dataMatrix || {}),
                categoricalColumns: [...current, draft]
            }
        });
        setCatDrafts((prev) => ({ ...prev, [tableName]: '' }));
    };

    const removeCategorical = (tableName: string, column: string) => {
        const current = schemaData?.tableInsights?.[tableName]?.dataMatrix?.categoricalCandidates?.map((c: any) => c.column) || [];
        updateOverridesForTable(tableName, {
            dataMatrix: {
                ...(insightOverrides[tableName]?.dataMatrix || {}),
                categoricalColumns: current.filter((c: string) => c !== column)
            }
        });
    };

    const addNumeric = (tableName: string) => {
        const draft = (numDrafts[tableName] || '').trim();
        if (!draft) return;
        const current = schemaData?.tableInsights?.[tableName]?.dataMatrix?.numericCandidates?.map((c: any) => c.column) || [];
        updateOverridesForTable(tableName, {
            dataMatrix: {
                ...(insightOverrides[tableName]?.dataMatrix || {}),
                numericColumns: [...current, draft]
            }
        });
        setNumDrafts((prev) => ({ ...prev, [tableName]: '' }));
    };

    const removeNumeric = (tableName: string, column: string) => {
        const current = schemaData?.tableInsights?.[tableName]?.dataMatrix?.numericCandidates?.map((c: any) => c.column) || [];
        updateOverridesForTable(tableName, {
            dataMatrix: {
                ...(insightOverrides[tableName]?.dataMatrix || {}),
                numericColumns: current.filter((c: string) => c !== column)
            }
        });
    };

    // Auto-discovery disabled: only fetch schema on explicit user action.

    const handleSaveNotes = () => {
        setUserSchemaNotes(localNotes);
        setIsEditingNotes(false);
    };

    if (localLoading || (isProcessing && !schemaData)) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16 }}>
                <Spin size="large" />
                <Text type="secondary">Profiling database and generating semantic analysis...</Text>
            </div>
        );
    }

    const hasTables = schemaData?.tables && schemaData.tables.length > 0;
    const totalRecords = schemaData?.tableCounts
        ? Object.values(schemaData.tableCounts).reduce((sum: number, val: any) => sum + Number(val || 0), 0)
        : 0;
    const relationshipCount = schemaData?.relationships?.length || 0;
    const handleToggleSemantic = (checked: boolean) => {
        setEnableSemanticSearch(checked);
        if (schemaData && connectionStatus === "Connected") {
            handleDiscover({ enableSemanticSearch: checked });
        }
    };

    const handleToggleMetrics = () => {
        // KPI agent is enforced for pipeline stability.
    };

    return (
        <div style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, padding: '16px 20px', borderRadius: 16, border: '1px solid #242a36', background: '#0f1218' }}>
                <div>
                    <Title level={2} style={{ margin: 0 }}>
                        <DatabaseOutlined style={{ marginRight: 12 }} />
                        Schema Discovery
                    </Title>
                    <Space separator={<Text type="secondary">|</Text>}>
                        <Text type="secondary">Review schema before planning</Text>
                        <Tag color="blue">Step 1 of 5</Tag>
                        {schemaTimestamp && (
                            <Text type="secondary">
                                Last refreshed: {new Date(schemaTimestamp).toLocaleString()}
                            </Text>
                        )}
                    </Space>
                </div>
                <Space>
                    <Space size="small">
                        <Tooltip title="Run per-table semantic matching against the semantic registry.">
                            <Space size="small">
                                <Switch checked={enableSemanticSearch} onChange={handleToggleSemantic} />
                                <Text type="secondary" style={{ fontSize: 12 }}>Semantic Search</Text>
                            </Space>
                        </Tooltip>
                        <Tooltip title="KPI agent runs automatically before planning.">
                            <Space size="small">
                                <Switch checked={enableTableMetrics} onChange={handleToggleMetrics} disabled />
                                <Text type="secondary" style={{ fontSize: 12 }}>KPI Agent (Always On)</Text>
                                <Tag color="green">Active</Tag>
                            </Space>
                        </Tooltip>
                    </Space>
                    <Button
                        icon={<ReloadOutlined />}
                        onClick={() => handleDiscover()}
                        loading={isProcessing}
                        disabled={connectionStatus !== "Connected"}
                    >
                        Refresh Schema
                    </Button>
                    <Button
                        type="primary"
                        icon={<ArrowRightOutlined />}
                        onClick={() => setStep(2)}
                        disabled={!schemaData}
                    >
                        Continue to Plan
                    </Button>
                </Space>
            </div>

            {connectionStatus !== "Connected" && (
                <Alert
                    title="Database connection required"
                    description="Schema discovery needs an active database connection. Open the Data Sources panel and connect your database before refreshing."
                    type="warning"
                    showIcon
                    style={{ marginBottom: 24 }}
                />
            )}

            {error && (
                <Alert
                    title="Discovery Error"
                    description={error}
                    type="error"
                    showIcon
                    style={{ marginBottom: 24 }}
                    action={
                        <Button size="small" danger onClick={() => handleDiscover()}>
                            Retry
                        </Button>
                    }
                />
            )}

            {!schemaData && !isProcessing && (
                <Empty description="No schema data found. Connect to a database to begin." />
            )}

            {schemaData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {/* Expert Analysis Section */}
                    <Card
                        title={
                            <Space>
                                <span>Expert Analysis</span>
                                <Tag color="blue">AI Generated</Tag>
                            </Space>
                        }
                        extra={
                            <Button
                                type="text"
                                icon={isEditingNotes ? <SaveOutlined /> : <EditOutlined />}
                                onClick={isEditingNotes ? handleSaveNotes : () => setIsEditingNotes(true)}
                            >
                                {isEditingNotes ? 'Save Notes' : 'Edit Notes'}
                            </Button>
                        }
                    >
                        {isEditingNotes ? (
                            <TextArea
                                value={localNotes}
                                onChange={(e) => setLocalNotes(e.target.value)}
                                placeholder="Add custom notes about the schema here..."
                                autoSize={{ minRows: 4, maxRows: 12 }}
                                style={{ marginBottom: 12 }}
                            />
                        ) : (
                            <Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                                {userSchemaNotes || schemaData.rawAnalysis}
                            </Paragraph>
                        )}
                    </Card>

                    {/* Schema Summary */}
                    {schemaData && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
                            <Card size="small">
                                <Text type="secondary">Tables</Text>
                                <Title level={3} style={{ margin: '4px 0 0 0' }}>{schemaData.tables?.length || 0}</Title>
                            </Card>
                            <Card size="small">
                                <Text type="secondary">Rows Profiled</Text>
                                <Title level={3} style={{ margin: '4px 0 0 0' }}>{totalRecords.toLocaleString()}</Title>
                            </Card>
                            <Card size="small">
                                <Text type="secondary">Relationships</Text>
                                <Title level={3} style={{ margin: '4px 0 0 0' }}>{relationshipCount}</Title>
                            </Card>
                            {schemaData.filterSummary && (
                                <Card size="small">
                                    <Text type="secondary">Filterable Dimensions</Text>
                                    <Paragraph style={{ margin: '4px 0 0 0', whiteSpace: 'pre-line' }}>
                                        {schemaData.filterSummary}
                                    </Paragraph>
                                </Card>
                            )}
                        </div>
                    )}

                    {/* Relationships */}
                    {relationshipCount > 0 && (
                        <Card
                            title="Detected Relationships"
                            size="small"
                        >
                            <Space orientation="vertical" style={{ width: '100%' }}>
                                {schemaData.relationships.map((rel: any, idx: number) => (
                                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                        <Tag color="cyan">{rel.type || 'many-to-one'}</Tag>
                                        <Text code>{`${rel.from?.table}.${rel.from?.column}`}</Text>
                                        <ArrowRightOutlined />
                                        <Text code>{`${rel.to?.table}.${rel.to?.column}`}</Text>
                                    </div>
                                ))}
                            </Space>
                        </Card>
                    )}

                    {/* Table Details Grid */}
                    <Card title="Active Table Preview" size="small" style={{ marginBottom: 20 }}>
                        {activeTable ? (
                            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16 }}>
                                <div>
                                    <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                                        <Text strong>{activeTable}</Text>
                                        <Text type="secondary" style={{ fontSize: 12 }}>
                                            Rows: {schemaData.tableCounts?.[activeTable] ?? 0}
                                        </Text>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                            {(schemaData.tableInsights?.[activeTable]?.kpis || []).map((kpi: any) => (
                                                <Tag key={`${activeTable}-${kpi.id}`} color="blue" style={{ margin: 0 }}>
                                                    {kpi.title}
                                                </Tag>
                                            ))}
                                            {(schemaData.tableInsights?.[activeTable]?.kpis || []).length === 0 && (
                                                <Text type="secondary" style={{ fontSize: 12 }}>No KPIs detected.</Text>
                                            )}
                                        </div>
                                    </Space>
                                </div>
                                <div>
                                    <Text strong type="secondary">Last 5 Records</Text>
                                    <div style={{ marginTop: 8, overflowX: 'auto' }}>
                                        <Table
                                            size="small"
                                            pagination={false}
                                            dataSource={schemaData.sampleData?.[activeTable]?.slice(0, 5)?.map((row: any, idx: number) => {
                                                const { __rowKey, ...rest } = row || {};
                                                return { ...rest, __rowKey: __rowKey || `row-${idx}` };
                                            })}
                                            columns={Object.keys(schemaData.sampleData?.[activeTable]?.[0] || {})
                                                .filter(key => key !== '__rowKey')
                                                .map(key => ({
                                                    title: key,
                                                    dataIndex: key,
                                                    key: key,
                                                    render: (val: any) => (
                                                        <div style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {String(val)}
                                                        </div>
                                                    )
                                                }))}
                                            rowKey="__rowKey"
                                        />
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <Text type="secondary">Select a table to preview KPIs and last 5 records.</Text>
                        )}
                    </Card>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(450px, 1fr))', gap: 24 }}>
                        {schemaData.tables?.map((tableName: string) => (
                            <Card
                                key={tableName}
                                hoverable
                                onClick={() => setActiveTable(tableName)}
                                title={
                                    <Space>
                                        <Text code strong>{tableName}</Text>
                                        <Badge count={schemaData.tableCounts?.[tableName] || 0} overflowCount={999999} style={{ backgroundColor: '#135bec' }} />
                                        <Text type="secondary" style={{ fontSize: 12 }}>Records</Text>
                                    </Space>
                                }
                            >
                                {schemaData.tableInsights?.[tableName] && (
                                    <div style={{ marginBottom: 16 }}>
                                        {schemaData.tableInsights[tableName]?.semanticMatches && (
                                            <div style={{ marginBottom: 12 }}>
                                                <Text strong type="secondary">SEMANTIC MATCHES</Text>
                                                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                    {schemaData.tableInsights[tableName].semanticMatches.metrics.map((metric: any) => (
                                                        <Tag key={`${tableName}-metric-${metric.slug}`} color="geekblue" style={{ margin: 0 }}>
                                                            {metric.name || metric.slug}
                                                        </Tag>
                                                    ))}
                                                    {schemaData.tableInsights[tableName].semanticMatches.dimensions.map((dim: any) => (
                                                        <Tag key={`${tableName}-dim-${dim.slug}`} color="green" style={{ margin: 0 }}>
                                                            {dim.name || dim.slug}
                                                        </Tag>
                                                    ))}
                                                    {schemaData.tableInsights[tableName].semanticMatches.metrics.length === 0 &&
                                                        schemaData.tableInsights[tableName].semanticMatches.dimensions.length === 0 && (
                                                            <Text type="secondary" style={{ fontSize: 12 }}>No semantic matches found.</Text>
                                                        )}
                                                </div>
                                            </div>
                                        )}

                                        {schemaData.tableInsights[tableName]?.kpis && (
                                            <div style={{ marginBottom: 12 }}>
                                                <Text strong type="secondary">SUGGESTED KPIS</Text>
                                                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                    {schemaData.tableInsights[tableName].kpis.map((kpi: any) => (
                                                        <Tooltip key={`${tableName}-kpi-${kpi.id}`} title={kpi.description}>
                                                            <Tag
                                                                color="blue"
                                                                style={{ margin: 0 }}
                                                                closable
                                                                closeIcon={<span style={{ fontSize: 12, marginLeft: 4 }}>×</span>}
                                                                onClose={(e) => {
                                                                    e.preventDefault();
                                                                    removeKpi(tableName, kpi.title);
                                                                }}
                                                            >
                                                                {kpi.title}
                                                            </Tag>
                                                        </Tooltip>
                                                    ))}
                                                </div>
                                                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                                    <Input
                                                        size="small"
                                                        placeholder="Add KPI title"
                                                        value={kpiDrafts[tableName] || ''}
                                                        onChange={(e) => setKpiDrafts((prev) => ({ ...prev, [tableName]: e.target.value }))}
                                                        onPressEnter={() => addKpi(tableName)}
                                                    />
                                                    <Button size="small" onClick={() => addKpi(tableName)}>Add</Button>
                                                </div>
                                            </div>
                                        )}

                                        {schemaData.tableInsights[tableName]?.dataMatrix && (
                                            <div>
                                                <Text strong type="secondary">DATA MATRIX</Text>
                                                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                    <Tag color="default" style={{ margin: 0 }}>
                                                        Rows: {schemaData.tableInsights[tableName].dataMatrix.rowCount ?? 0}
                                                    </Tag>
                                                    <Tag color="default" style={{ margin: 0 }}>
                                                        Numeric: {schemaData.tableInsights[tableName].dataMatrix.columnCounts.numeric}
                                                    </Tag>
                                                    <Tag color="default" style={{ margin: 0 }}>
                                                        Temporal: {schemaData.tableInsights[tableName].dataMatrix.columnCounts.temporal}
                                                    </Tag>
                                                    <Tag color="default" style={{ margin: 0 }}>
                                                        Text: {schemaData.tableInsights[tableName].dataMatrix.columnCounts.text}
                                                    </Tag>
                                                </div>
                                                <div style={{ marginTop: 10 }}>
                                                    <Text type="secondary" style={{ fontSize: 12 }}>Categorical Columns</Text>
                                                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                        {schemaData.tableInsights[tableName].dataMatrix.categoricalCandidates.map((c: any, idx: number) => (
                                                            <Tag
                                                                key={`${tableName}-cat-${c.column}-${idx}`}
                                                                color="default"
                                                                style={{ margin: 0 }}
                                                                closable
                                                                closeIcon={<span style={{ fontSize: 12, marginLeft: 4 }}>×</span>}
                                                                onClose={(e) => {
                                                                    e.preventDefault();
                                                                    removeCategorical(tableName, c.column);
                                                                }}
                                                            >
                                                                {c.column}
                                                            </Tag>
                                                        ))}
                                                    </div>
                                                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                                        <Input
                                                            size="small"
                                                            placeholder="Add categorical column"
                                                            value={catDrafts[tableName] || ''}
                                                            onChange={(e) => setCatDrafts((prev) => ({ ...prev, [tableName]: e.target.value }))}
                                                            onPressEnter={() => addCategorical(tableName)}
                                                        />
                                                        <Button size="small" onClick={() => addCategorical(tableName)}>Add</Button>
                                                    </div>
                                                </div>
                                                <div style={{ marginTop: 12 }}>
                                                    <Text type="secondary" style={{ fontSize: 12 }}>Numeric Columns</Text>
                                                    <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                        {schemaData.tableInsights[tableName].dataMatrix.numericCandidates.map((c: any, idx: number) => (
                                                            <Tag
                                                                key={`${tableName}-num-${c.column}-${idx}`}
                                                                color="default"
                                                                style={{ margin: 0 }}
                                                                closable
                                                                closeIcon={<span style={{ fontSize: 12, marginLeft: 4 }}>×</span>}
                                                                onClose={(e) => {
                                                                    e.preventDefault();
                                                                    removeNumeric(tableName, c.column);
                                                                }}
                                                            >
                                                                {c.column}
                                                            </Tag>
                                                        ))}
                                                    </div>
                                                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                                        <Input
                                                            size="small"
                                                            placeholder="Add numeric column"
                                                            value={numDrafts[tableName] || ''}
                                                            onChange={(e) => setNumDrafts((prev) => ({ ...prev, [tableName]: e.target.value }))}
                                                            onPressEnter={() => addNumeric(tableName)}
                                                        />
                                                        <Button size="small" onClick={() => addNumeric(tableName)}>Add</Button>
                                                    </div>
                                                </div>
                                            </div>
                                        )}

                                        {schemaData.tableInsights[tableName]?.filters && (
                                            <div style={{ marginTop: 12 }}>
                                                <Text strong type="secondary">Filterable Dimensions</Text>
                                                <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                    {schemaData.tableInsights[tableName].filters.map((filter: any, idx: number) => (
                                                        <Tag
                                                            key={`${tableName}-filter-${filter.id}-${idx}`}
                                                            color="purple"
                                                            style={{ margin: 0 }}
                                                            closable
                                                            closeIcon={<span style={{ fontSize: 12, marginLeft: 4 }}>×</span>}
                                                            onClose={(e) => {
                                                                e.preventDefault();
                                                                removeFilter(tableName, filter.title);
                                                            }}
                                                        >
                                                            {filter.title}
                                                        </Tag>
                                                    ))}
                                                </div>
                                                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                                    <Input
                                                        size="small"
                                                        placeholder="Add filter dimension"
                                                        value={filterDrafts[tableName] || ''}
                                                        onChange={(e) => setFilterDrafts((prev) => ({ ...prev, [tableName]: e.target.value }))}
                                                        onPressEnter={() => addFilter(tableName)}
                                                    />
                                                    <Button size="small" onClick={() => addFilter(tableName)}>Add</Button>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {rawSchemaData?.schemaInfo?.[tableName]?.columns?.length > 0 && (
                                    <div style={{ marginBottom: 16 }}>
                                        <details style={{ marginTop: 4 }} className="group">
                                            <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                    <span className="material-symbols-outlined text-[16px] text-slate-400 group-open:rotate-180 transition-transform">expand_more</span>
                                                    <Text strong type="secondary">Column Controls</Text>
                                                </div>
                                                <Button size="small" onClick={(e) => { e.preventDefault(); showAllColumns(tableName, rawSchemaData.schemaInfo[tableName].columns); }}>
                                                    Show all
                                                </Button>
                                            </summary>
                                            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                {rawSchemaData.schemaInfo[tableName].columns.map((col: any, idx: number) => {
                                                    const name = col?.name || col?.column_name;
                                                    const toggles = getColumnToggle(tableName, name);
                                                    return (
                                                        <div key={`${tableName}-col-${name}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 8px', borderRadius: 8, background: 'rgba(255,255,255,0.03)' }}>
                                                            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                                                                <Text style={{ fontSize: 12 }}>{name}</Text>
                                                                <Text type="secondary" style={{ fontSize: 11 }}>{col.type || col.data_type}</Text>
                                                            </div>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                                    <Text type="secondary" style={{ fontSize: 11 }}>Show</Text>
                                                                    <span className="material-symbols-outlined text-[16px] text-slate-400">{toggles.show ? 'visibility' : 'visibility_off'}</span>
                                                                    <Switch
                                                                        size="small"
                                                                        checked={toggles.show}
                                                                        onChange={(checked) => updateColumnToggle(tableName, name, 'show', checked)}
                                                                    />
                                                                </div>
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                                    <Text type="secondary" style={{ fontSize: 11 }}>Filterable</Text>
                                                                    <span className="material-symbols-outlined text-[16px] text-slate-400">{toggles.filterable ? 'filter_alt' : 'filter_alt_off'}</span>
                                                                    <Switch
                                                                        size="small"
                                                                        checked={toggles.filterable}
                                                                        disabled={!toggles.show}
                                                                        onChange={(checked) => updateColumnToggle(tableName, name, 'filterable', checked)}
                                                                    />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </details>
                                    </div>
                                )}

                                <Divider style={{ margin: '12px 0' }} />

                                <div>
                                    <Text strong type="secondary">SAMPLES (LAST 5)</Text>
                                    <div style={{ marginTop: 8, overflowX: 'auto' }}>
                                        <Table
                                            size="small"
                                            pagination={false}
                                            dataSource={schemaData.sampleData[tableName]?.map((row: any, idx: number) => {
                                                const { __rowKey, ...rest } = row || {};
                                                return { ...rest, __rowKey: __rowKey || `row-${idx}` };
                                            })}
                                            columns={Object.keys(schemaData.sampleData[tableName]?.[0] || {})
                                                .filter(key => key !== '__rowKey')
                                                .map(key => ({
                                                title: key,
                                                dataIndex: key,
                                                key: key,
                                                render: (val: any) => (
                                                    <div style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {String(val)}
                                                    </div>
                                                )
                                            }))}
                                            rowKey="__rowKey"
                                        />
                                    </div>
                                </div>
                            </Card>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

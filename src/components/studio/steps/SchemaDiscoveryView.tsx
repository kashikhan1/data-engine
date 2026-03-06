'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkflowStore, useConfigStore } from '@/state/stores';
import { runSchemaDiscovery } from '@/modules/schema/agent';
import type { ColumnProfile, TableClassification, DataQualityReport } from '@/modules/schema/agent';
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
    Switch,
    Progress,
    Statistic
} from 'antd';
import {
    ReloadOutlined,
    CheckCircleOutlined,
    CloseCircleOutlined,
    LoadingOutlined,
    ArrowRightOutlined,
    DatabaseOutlined,
    InfoCircleOutlined,
    SearchOutlined,
    WarningOutlined,
    SafetyOutlined,
    ThunderboltOutlined,
    LineChartOutlined,
    TableOutlined
} from '@ant-design/icons';
import styles from './StepView.module.css';

const { Title, Text } = Typography;

const TABLE_INSIGHTS_OVERRIDES_KEY = 'schema_table_insights_overrides';
const COLUMN_TOGGLES_KEY = 'schema_column_toggles';
const COLUMN_TOGGLES_MIGRATION_KEY = 'schema_column_toggles_migrated_v2';
const SELECTED_TABLES_KEY = 'schema_selected_tables';
const SELECTED_SCHEMA_KEY = 'selected_schema';

export const SchemaDiscoveryView: React.FC = () => {
    const {
        schemaData,
        setSchemaData,
        schemaTimestamp,
        isProcessing,
        setProcessing,
        error,
        setError,
        setStep,
        staleStep,
        setStaleStep,
        query,
        setProgressStages,
        updateProgressStage,
        progressStages
    } = useWorkflowStore();
    const { postgresUrl, mssqlUrl, connectionStatus, projectContext, dataSources, selectedDataSourceId, discoveredTables } = useConfigStore();

    const [localLoading, setLocalLoading] = useState(false);
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
    const [tableSearch, setTableSearch] = useState('');
    const autoRefreshMissingRef = useRef(false);

    const normalizeTableIdentifier = (value: string) =>
        String(value || '')
            .trim()
            .replace(/^\[|\]$/g, '')
            .replace(/^"|"$/g, '')
            .toLowerCase();

    const resolveAllowedTables = useCallback((): string[] => {
        const result: string[] = [];
        const seen = new Set<string>();
        const addMany = (items: unknown[]) => {
            items.forEach((raw) => {
                const table = String(raw || '').trim();
                if (!table) return;
                const key = normalizeTableIdentifier(table);
                if (!key || seen.has(key)) return;
                seen.add(key);
                result.push(table);
            });
        };

        try {
            const storedTablesRaw = localStorage.getItem(SELECTED_TABLES_KEY);
            const selectedTables = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
            if (Array.isArray(selectedTables)) addMany(selectedTables);
        } catch {
            // ignore malformed localStorage
        }

        if (result.length === 0) {
            try {
                const selectedSchemaRaw = localStorage.getItem(SELECTED_SCHEMA_KEY);
                const parsed = selectedSchemaRaw ? JSON.parse(selectedSchemaRaw) : null;
                const schemaDataMap = parsed?.schemaData && typeof parsed.schemaData === 'object'
                    ? parsed.schemaData
                    : parsed;
                if (schemaDataMap && typeof schemaDataMap === 'object') {
                    addMany(Object.keys(schemaDataMap));
                }
            } catch {
                // ignore malformed localStorage
            }
        }

        const discoveredSet = new Set((Array.isArray(discoveredTables) ? discoveredTables : []).map((t) => normalizeTableIdentifier(t)));
        if (discoveredSet.size > 0) {
            const filtered = result.filter((t) => discoveredSet.has(normalizeTableIdentifier(t)));
            return Array.from(new Set(filtered));
        }

        return result;
    }, [discoveredTables]);


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
            const parsed = raw ? JSON.parse(raw) : {};
            // One-time migration: clear legacy "filterable=true for all" defaults while preserving Show toggles.
            if (localStorage.getItem(COLUMN_TOGGLES_MIGRATION_KEY) !== '1') {
                const migrated: Record<string, Record<string, { show?: boolean; filterable?: boolean }>> = {};
                Object.entries(parsed || {}).forEach(([table, cols]: [string, any]) => {
                    const tableMap: Record<string, { show?: boolean; filterable?: boolean }> = {};
                    Object.entries(cols || {}).forEach(([col, entry]: [string, any]) => {
                        tableMap[col] = {
                            ...(typeof entry?.show === 'boolean' ? { show: entry.show } : {})
                        };
                    });
                    migrated[table] = tableMap;
                });
                localStorage.setItem(COLUMN_TOGGLES_KEY, JSON.stringify(migrated));
                localStorage.setItem(COLUMN_TOGGLES_MIGRATION_KEY, '1');
                return migrated;
            }
            return parsed;
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
        togglesMap: Record<string, Record<string, { show?: boolean; filterable?: boolean }>> = columnToggles,
        defaults?: { show?: boolean; filterable?: boolean }
    ) => {
        const entry = togglesMap[tableName]?.[columnName] || {};
        return {
            show: entry.show ?? (defaults?.show ?? true),
            filterable: entry.filterable ?? (defaults?.filterable ?? false)
        };
    };

    const isDefaultFilterableColumn = (tableName: string, columnName: string, tableColumns?: any[]) => {
        const columns = Array.isArray(tableColumns)
            ? tableColumns
            : (rawSchemaData?.schemaInfo?.[tableName]?.columns || []);
        const match = columns.find((c: any) => (c?.name || c?.column_name) === columnName);
        const type = String(match?.type || match?.data_type || '').toLowerCase();
        return /date|time|timestamp/.test(type) || type.includes('enum');
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
        const visibleColumns: Record<string, string[]> = {};
        const filterableColumns: Record<string, string[]> = {};
        const disabledFilterColumns: Record<string, string[]> = {};
        const maskedInsights: Record<string, any> = {};

        Object.entries(baseData.schemaInfo || {}).forEach(([tableName, info]: [string, any]) => {
            const columns = Array.isArray(info?.columns) ? info.columns : [];
            const baseVisible = Array.isArray(baseData.visibleColumns?.[tableName])
                ? baseData.visibleColumns[tableName]
                : columns.map((c: any) => c?.name || c?.column_name).filter(Boolean);
            const baseFilterable = Array.isArray(baseData.filterableColumns?.[tableName])
                ? baseData.filterableColumns[tableName]
                : columns
                    .map((c: any) => c?.name || c?.column_name)
                    .filter((name: string) => Boolean(name) && isDefaultFilterableColumn(tableName, name, columns));

            const visibleSet = new Set<string>();
            const defaultFilterable = new Set<string>(
                columns
                    .map((c: any) => c?.name || c?.column_name)
                    .filter((name: string) => Boolean(name) && isDefaultFilterableColumn(tableName, name, columns))
            );
            const filterableSet = new Set<string>(baseFilterable.filter((name: string) => defaultFilterable.has(name)));
            baseVisible.forEach((col: string) => visibleSet.add(col));

            const explicitlyDisabled = new Set<string>();

            columns.forEach((col: any) => {
                const name = col?.name || col?.column_name;
                if (!name) return;
                const toggle = getColumnToggle(tableName, name, toggles, {
                    show: true,
                    filterable: filterableSet.has(name)
                });
                if (toggle.show === false) {
                    visibleSet.delete(name);
                } else if (toggle.show === true) {
                    visibleSet.add(name);
                }
                if (toggle.filterable === false) {
                    filterableSet.delete(name);
                } else if (toggle.filterable === true) {
                    filterableSet.add(name);
                }
                // Only track columns where the user explicitly set filterable=false in the saved toggle map.
                // We check the raw entry directly — NOT the computed toggle (which has defaults that would
                // incorrectly flag non-default-filterable columns like identifiers and free-text fields).
                const rawEntry = toggles[tableName]?.[name];
                if (rawEntry && 'filterable' in rawEntry && rawEntry.filterable === false) {
                    explicitlyDisabled.add(name);
                }
            });

            visibleColumns[tableName] = Array.from(visibleSet);
            filterableColumns[tableName] = Array.from(filterableSet);
            if (explicitlyDisabled.size > 0) {
                disabledFilterColumns[tableName] = Array.from(explicitlyDisabled);
            }

            const insight = baseData.tableInsights?.[tableName];
            if (insight) {
                const allowedFilters = (insight.filters || []).filter((f: any) => {
                    if (!f?.column) return false;
                    return filterableSet.has(f.column);
                });
                maskedInsights[tableName] = {
                    ...insight,
                    filters: allowedFilters
                };
            }
        });

        return {
            ...baseData,
            visibleColumns,
            filterableColumns,
            disabledFilterColumns,
            tableInsights: maskedInsights
        };
    };

    const buildFilterCandidatesFromTableInsights = (tableInsights: Record<string, any>, filterableColumns?: Record<string, string[]>) => {
        if (filterableColumns && Object.keys(filterableColumns).length > 0) {
            return detectFilterCandidatesFromColumns(rawSchemaData?.schemaInfo || {}, filterableColumns);
        }
        const dateColumns: { table: string; column: string; type: string }[] = [];
        const categoricalColumns: { table: string; column: string; distinct: any[] }[] = [];
        const entityColumns: { viaTable: string; from: string; to: string }[] = [];
        const searchColumns: { table: string; column: string; score: number }[] = [];

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
                } else if (filter.type === 'search') {
                    searchColumns.push({
                        table: tableName,
                        column: filter.column,
                        score: 1
                    });
                }
            });
        });

        const primaryDate = dateColumns[0];
        const primarySearch = searchColumns[0];
        const summaryLines: string[] = [];
        if (primaryDate) {
            summaryLines.push(`Date range filter: ${primaryDate.table}.${primaryDate.column}`);
        }
        if (primarySearch) {
            summaryLines.push(`Search filter: ${primarySearch.table}.${primarySearch.column}`);
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
            searchColumns,
            primarySearch,
            primaryDate,
            summary: summaryLines.join('\n') || 'No filterable dimensions detected.'
        };
    };

    const detectFilterCandidatesFromColumns = (schemaInfo: Record<string, any>, filterable: Record<string, string[]>) => {
        const dateColumns: { table: string; column: string; type: string }[] = [];
        const categoricalColumns: { table: string; column: string; distinct: any[] }[] = [];
        const entityColumns: { viaTable: string; from: string; to: string }[] = [];
        const searchColumns: { table: string; column: string; score: number }[] = [];

        Object.entries(filterable || {}).forEach(([table, columns]) => {
            const info = schemaInfo?.[table];
            const cols = info?.columns || [];
            const foreignKeys = Array.isArray(info?.foreignKeys) ? info.foreignKeys : [];
            columns.forEach((column) => {
                const match = cols.find((c: any) => (c?.name || c?.column_name) === column);
                const type = String(match?.type || match?.data_type || '').toLowerCase();
                if (/date|time|timestamp/.test(type)) {
                    dateColumns.push({ table, column, type });
                } else if (type.includes('enum')) {
                    categoricalColumns.push({ table, column, distinct: [] });
                }
                if (/(char|text|string|uuid|citext|json)/.test(type) && /name|title|label|email|code|reference|number/i.test(column)) {
                    searchColumns.push({ table, column, score: 1 });
                }
                const fk = foreignKeys.find((candidate: any) => String(candidate?.column_name || '') === column);
                if (fk?.foreign_table_name) {
                    entityColumns.push({
                        viaTable: table,
                        from: `${table}.${column}`,
                        to: `${fk.foreign_table_name}.${fk.foreign_column_name || 'id'}`
                    });
                }
            });
        });

        const primaryDate = dateColumns[0];
        const primarySearch = searchColumns[0];
        const summaryLines: string[] = [];
        if (primaryDate) {
            summaryLines.push(`Date range filter: ${primaryDate.table}.${primaryDate.column}`);
        }
        if (primarySearch) {
            summaryLines.push(`Search filter: ${primarySearch.table}.${primarySearch.column}`);
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
            searchColumns,
            primarySearch,
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
        const filterCandidates = maskedData.tableInsights
            ? buildFilterCandidatesFromTableInsights(maskedData.tableInsights, maskedData.filterableColumns)
            : rawSchemaData.filterCandidates;
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

        const defaultStages = [
            { id: 'connect', label: 'Connecting to database', status: 'pending' as const },
            { id: 'discover', label: 'Discovering schema', status: 'pending' as const },
            { id: 'analyze', label: 'Analyzing tables', status: 'pending' as const },
            { id: 'enrich', label: 'Enriching with insights', status: 'pending' as const },
        ];
        
        setProgressStages(defaultStages);

        try {
            const tryDiscover = async (attempts: number) => {
                let lastError: any = null;
                
                updateProgressStage('connect', { status: 'in_progress' });
                
                for (let i = 0; i < attempts; i++) {
                    try {
                        updateProgressStage('connect', { status: 'completed', message: 'Connected' });
                        updateProgressStage('discover', { status: 'in_progress', message: 'Scanning tables...' });
                        
                        const data = await runSchemaDiscovery({
                            connection: effectiveUrl,
                            connectorType: effectiveConnectorType,
                            options: {
                                enableSemanticSearch: semanticEnabled,
                                enableTableKpis: tableKpisEnabled,
                                enableTableMatrix: tableMatrixEnabled,
                                enableTableFilters: tableMatrixEnabled,
                                projectContext
                            },
                            allowedTables
                        });
                        
                        updateProgressStage('discover', { status: 'completed', message: `Found ${data?.tables?.length || 0} tables` });
                        
                        if (data?.tables && data.tables.length > 0) {
                            updateProgressStage('analyze', { status: 'in_progress', message: 'Analyzing columns...' });
                            updateProgressStage('analyze', { status: 'completed' });
                            
                            if (semanticEnabled) {
                                updateProgressStage('enrich', { status: 'in_progress', message: 'Generating insights...' });
                                updateProgressStage('enrich', { status: 'completed' });
                            } else {
                                updateProgressStage('enrich', { status: 'completed' });
                            }
                            
                            return data;
                        }
                        lastError = new Error("Schema discovery returned no tables.");
                    } catch (err: any) {
                        lastError = err;
                        updateProgressStage('connect', { status: 'error', message: err.message });
                    }
                }
                throw lastError || new Error("Schema discovery failed.");
            };
            const semanticEnabled = overrideOptions?.enableSemanticSearch ?? enableSemanticSearch;
            const tableKpisEnabled = false;
            const tableMatrixEnabled = overrideOptions?.enableTableMatrix ?? enableTableMetrics;
            const allowedTables = resolveAllowedTables();
            if (!Array.isArray(allowedTables) || allowedTables.length === 0) {
                throw new Error("No tables selected for schema discovery. Open Data Sources, select at least one table, then refresh schema.");
            }

            // Resolve active connection — supports both PostgreSQL and MSSQL
            const selectedDs = dataSources.find(ds => ds.id === selectedDataSourceId);
            const effectiveUrl = selectedDs?.connectionString || postgresUrl || mssqlUrl;
            const lowerUrl = (effectiveUrl || "").toLowerCase();
            const isMssqlConn = selectedDs?.type === 'MSSQL' ||
                (!lowerUrl.startsWith('postgres') && !lowerUrl.startsWith('postgresql') &&
                    (lowerUrl.startsWith('mssql://') || lowerUrl.startsWith('sqlserver://') ||
                        lowerUrl.includes('server=') || lowerUrl.includes('data source=')));
            const effectiveConnectorType = isMssqlConn ? 'mssql' : undefined;

            const data = await tryDiscover(3);
            const storedOverrides = loadOverrides();
            const storedToggles = loadColumnToggles();
            setInsightOverrides(storedOverrides);
            setColumnToggles(storedToggles);
            setRawSchemaData(data);
            const mergedInsights = buildMergedInsights(data.tableInsights, storedOverrides);
            const baseData = { ...data, tableInsights: mergedInsights };
            const maskedData = applyColumnToggles(baseData, storedToggles);
            const filterCandidates = maskedData.tableInsights
                ? buildFilterCandidatesFromTableInsights(maskedData.tableInsights, maskedData.filterableColumns)
                : data.filterCandidates;
            const nextData = {
                ...maskedData,
                connectionString: effectiveUrl,
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
    }, [connectionStatus, postgresUrl, mssqlUrl, dataSources, selectedDataSourceId, projectContext, setSchemaData, setError, setProcessing, setLocalLoading, staleStep, setStaleStep, enableSemanticSearch, enableTableMetrics, resolveAllowedTables]);

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
        if (missingProfiles && connectionStatus === "Connected" && (postgresUrl || mssqlUrl)) {
            autoRefreshMissingRef.current = true;
            handleDiscover();
        }
    }, [schemaData, connectionStatus, postgresUrl, mssqlUrl, isProcessing, localLoading, handleDiscover]);

    useEffect(() => {
        if (autoRefreshMissingRef.current) return;
        if (schemaData?.tables?.length) return;
        if (isProcessing || localLoading) return;
        if (connectionStatus !== "Connected" || !(postgresUrl || mssqlUrl)) return;
        const selectedTables = resolveAllowedTables();
        if (!Array.isArray(selectedTables) || selectedTables.length === 0) return;
        autoRefreshMissingRef.current = true;
        handleDiscover();
    }, [schemaData, connectionStatus, postgresUrl, mssqlUrl, isProcessing, localLoading, handleDiscover, resolveAllowedTables]);

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
                    [key]: value
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
            tableMap[name] = { show: true };
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

    const hasTables = schemaData?.tables && schemaData.tables.length > 0;
    const tableCount = schemaData?.tables?.length || 0;
    const totalRecords = schemaData?.tableCounts
        ? Object.values(schemaData.tableCounts).reduce((sum: number, val: any) => sum + Number(val || 0), 0)
        : 0;
    const relationshipCount = schemaData?.relationships?.length || 0;
    const joinExamples = useMemo(() => {
        if (!schemaData?.relationships?.length) return [];
        return schemaData.relationships.slice(0, 6).map((rel: any, idx: number) => {
            const fromTable = rel.from?.table || rel.fromTable;
            const fromColumn = rel.from?.column || rel.via;
            const toTable = rel.to?.table || rel.toTable;
            const toColumn = rel.to?.column || rel.targetColumn || "id";
            if (!fromTable || !toTable || !fromColumn) return null;
            return {
                id: `join-example-${idx}`,
                label: `${fromTable}.${fromColumn} -> ${toTable}.${toColumn}`,
                sql: `SELECT a.*, b.*\nFROM "${fromTable}" a\nJOIN "${toTable}" b\n  ON a."${fromColumn}" = b."${toColumn}"\nLIMIT 50;`
            };
        }).filter(Boolean) as Array<{ id: string; label: string; sql: string }>;
    }, [schemaData?.relationships]);
    const handleToggleSemantic = (checked: boolean) => {
        setEnableSemanticSearch(checked);
        if (schemaData && connectionStatus === "Connected") {
            handleDiscover({ enableSemanticSearch: checked });
        }
    };

    // Filtered tables for search
    const filteredTables = useMemo(() => {
        const t = schemaData?.tables || [];
        if (!tableSearch.trim()) return t;
        return t.filter((n: string) => n.toLowerCase().includes(tableSearch.toLowerCase()));
    }, [schemaData?.tables, tableSearch]);

    // Aggregate quality across all tables
    const allQualityScores = useMemo(() => {
        if (!schemaData?.tableInsights) return null;
        const scores = Object.values(schemaData.tableInsights)
            .map((ins: any) => ins?.dataMatrix?.qualityReport?.healthScore)
            .filter((s: any) => typeof s === 'number') as number[];
        if (scores.length === 0) return null;
        return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    }, [schemaData?.tableInsights]);

    // Per-table classification summary for the overview
    const classificationSummary = useMemo(() => {
        if (!schemaData?.tableInsights) return { fact: 0, dimension: 0, junction: 0, lookup: 0, unknown: 0 };
        const counts: Record<string, number> = { fact: 0, dimension: 0, junction: 0, lookup: 0, unknown: 0 };
        Object.values(schemaData.tableInsights).forEach((ins: any) => {
            const cls = ins?.dataMatrix?.classification?.tableClass || 'unknown';
            counts[cls] = (counts[cls] || 0) + 1;
        });
        return counts;
    }, [schemaData?.tableInsights]);

    if (localLoading || (isProcessing && !schemaData)) {
        return (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16 }}>
                <Spin size="large" />
                <Text type="secondary">Profiling database schema — running column statistics, data quality scoring, and semantic analysis...</Text>
            </div>
        );
    }

    const handleToggleMetrics = () => {
        // KPI agent is enforced for pipeline stability.
    };

    // Helper: render classification badge
    const renderClassBadge = (cls: any) => {
        if (!cls) return null;
        const clsMap: Record<string, { color: string; label: string; icon: React.ReactNode }> = {
            fact: { color: '#6366f1', label: 'Fact', icon: <LineChartOutlined /> },
            dimension: { color: '#10b981', label: 'Dimension', icon: <TableOutlined /> },
            junction: { color: '#f59e0b', label: 'Junction', icon: <ArrowRightOutlined /> },
            lookup: { color: '#3b82f6', label: 'Lookup', icon: <SafetyOutlined /> },
            unknown: { color: '#6b7280', label: 'Mixed', icon: <InfoCircleOutlined /> },
        };
        const cfg = clsMap[cls.tableClass] || clsMap.unknown;
        return (
            <Tooltip title={`${cls.confidence}% confidence • ${cls.signals?.[0] || ''}`}>
                <Tag icon={cfg.icon} style={{
                    background: `${cfg.color}22`,
                    border: `1px solid ${cfg.color}55`,
                    color: cfg.color,
                    fontWeight: 600,
                    fontSize: 11
                }}>
                    {cfg.label}
                </Tag>
            </Tooltip>
        );
    };

    // Helper: render column role badge
    const renderRoleBadge = (role: string) => {
        const roleMap: Record<string, { color: string; label: string }> = {
            measure: { color: '#6366f1', label: 'Measure' },
            label: { color: '#10b981', label: 'Label' },
            category: { color: '#f59e0b', label: 'Category' },
            timestamp: { color: '#3b82f6', label: 'Timestamp' },
            id: { color: '#8b5cf6', label: 'ID' },
            flag: { color: '#ec4899', label: 'Flag' },
            unknown: { color: '#6b7280', label: '—' },
        };
        const cfg = roleMap[role] || roleMap.unknown;
        if (role === 'unknown') return null;
        return (
            <span style={{
                fontSize: 9,
                fontWeight: 700,
                padding: '1px 5px',
                borderRadius: 4,
                background: `${cfg.color}22`,
                border: `1px solid ${cfg.color}44`,
                color: cfg.color,
                letterSpacing: '0.04em',
                textTransform: 'uppercase'
            }}>
                {cfg.label}
            </span>
        );
    };

    // Helper: render null rate indicator bar
    const renderNullBar = (nullRate: number) => {
        const pct = Math.round(nullRate * 100);
        const color = pct > 50 ? '#ef4444' : pct > 20 ? '#f59e0b' : '#10b981';
        return (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ flex: 1, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)' }}>
                    <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: color }} />
                </div>
                <Text style={{ fontSize: 10, color, minWidth: 30 }}>{pct}%</Text>
            </div>
        );
    };

    // Helper: data quality health color
    const qualityColor = (score: number) => score >= 80 ? '#10b981' : score >= 60 ? '#f59e0b' : '#ef4444';

    return (
        <div style={{ padding: '24px', height: '100%', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20, padding: '16px 20px', borderRadius: 16, border: '1px solid #242a36', background: '#0f1218' }}>
                <div>
                    <Title level={2} style={{ margin: 0 }}>
                        <DatabaseOutlined style={{ marginRight: 12 }} />
                        Schema Discovery
                    </Title>
                    <Space separator={<Text type="secondary">|</Text>}>
                        <Text type="secondary">Pro Data Profiling</Text>
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
                        disabled={!schemaData || isProcessing || !query?.trim()}
                    >
                        Continue to Plan
                    </Button>
                </Space>
            </div>

            {isProcessing && progressStages.length > 0 && (
                <div style={{ 
                    marginBottom: 24, 
                    padding: 16, 
                    background: 'rgba(99, 102, 241, 0.05)', 
                    borderRadius: 8,
                    border: '1px solid rgba(99, 102, 241, 0.2)'
                }}>
                    <div style={{ marginBottom: 12, fontWeight: 600, color: '#fff' }}>
                        <LoadingOutlined style={{ marginRight: 8 }} />
                        Discovering Database Schema...
                    </div>
                    <Space direction="vertical" style={{ width: '100%' }} size={8}>
                        {progressStages.map((stage, index) => (
                            <div key={stage.id} style={{ 
                                display: 'flex', 
                                alignItems: 'center',
                                opacity: stage.status === 'pending' ? 0.5 : 1
                            }}>
                                {stage.status === 'completed' && <CheckCircleOutlined style={{ color: '#10b981', marginRight: 8 }} />}
                                {stage.status === 'in_progress' && <LoadingOutlined style={{ color: '#6366f1', marginRight: 8 }} />}
                                {stage.status === 'error' && <CloseCircleOutlined style={{ color: '#ef4444', marginRight: 8 }} />}
                                {stage.status === 'pending' && <LoadingOutlined style={{ color: '#6b7280', marginRight: 8 }} />}
                                <span style={{ color: '#fff', flex: 1 }}>{stage.label}</span>
                                {stage.message && (
                                    <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 12 }}>
                                        {stage.message}
                                    </span>
                                )}
                            </div>
                        ))}
                    </Space>
                </div>
            )}

            {connectionStatus !== "Connected" && (
                <Alert
                    title={<span style={{ color: '#fff' }}>Database connection required</span>}
                    description={<span style={{ color: 'rgba(255, 255, 255, 0.7)' }}>Schema discovery needs an active database connection. Open the Data Sources panel and connect your database before refreshing.</span>}
                    type="warning"
                    showIcon
                    style={{ marginBottom: 24, background: 'rgba(250, 173, 20, 0.1)', border: '1px solid rgba(250, 173, 20, 0.3)' }}
                />
            )}

            {error && (
                <Alert
                    title={<span style={{ color: '#fff' }}>Discovery Error</span>}
                    description={<span style={{ color: 'rgba(255, 255, 255, 0.7)' }}>{error}</span>}
                    type="error"
                    showIcon
                    style={{ marginBottom: 24, background: 'rgba(245, 34, 45, 0.1)', border: '1px solid rgba(245, 34, 45, 0.3)' }}
                    action={
                        <Button size="small" danger onClick={() => handleDiscover()}>
                            Retry
                        </Button>
                    }
                />
            )}

            {!query?.trim() && schemaData && (
                <div style={{
                    padding: '24px 32px',
                    borderRadius: '16px',
                    background: 'linear-gradient(135deg, rgba(19, 91, 236, 0.1) 0%, rgba(99, 102, 241, 0.05) 100%)',
                    border: '1px solid rgba(19, 91, 236, 0.2)',
                    marginBottom: 32,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 20
                }}>
                    <div style={{
                        width: 48, height: 48, borderRadius: '14px',
                        background: 'rgba(19, 91, 236, 0.2)', display: 'flex',
                        alignItems: 'center', justifyContent: 'center',
                        color: '#135bec', boxShadow: '0 4px 12px rgba(0,0,0,0.1)'
                    }}>
                        <InfoCircleOutlined style={{ fontSize: 24 }} />
                    </div>
                    <div style={{ flex: 1 }}>
                        <Title level={4} style={{ margin: '0 0 4px 0', color: '#fff', fontSize: 18 }}>Strategic Intent Needed</Title>
                        <Text style={{ color: 'rgba(248, 250, 252, 0.8)', fontSize: 14, lineHeight: 1.5, display: 'block' }}>
                            Schema profiled successfully. Enter your analytics objective in the chat panel to generate a dashboard blueprint.
                        </Text>
                    </div>
                </div>
            )}

            {!schemaData && !isProcessing && (
                <Empty description="No schema data found. Connect to a database to begin." />
            )}

            {schemaData && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {/* ── Schema Overview Stats ───────────────────────────────── */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16 }}>
                        <Card size="small" style={{ textAlign: 'center' }}>
                            <Statistic title="Tables" value={schemaData.tables?.length || 0} styles={{ content: { color: '#6366f1' } }} />
                        </Card>
                        <Card size="small" style={{ textAlign: 'center' }}>
                            <Statistic title="Total Records" value={totalRecords} formatter={(v) => Number(v).toLocaleString()} styles={{ content: { color: '#10b981' } }} />
                        </Card>
                        <Card size="small" style={{ textAlign: 'center' }}>
                            <Statistic title="Relationships" value={relationshipCount} styles={{ content: { color: '#3b82f6' } }} />
                        </Card>
                        {allQualityScores !== null && (
                            <Card size="small" style={{ textAlign: 'center' }}>
                                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Avg Data Quality</Text>
                                <Progress
                                    type="circle"
                                    percent={allQualityScores}
                                    size={64}
                                    strokeColor={qualityColor(allQualityScores)}
                                    format={(p) => <span style={{ fontSize: 14, fontWeight: 700, color: qualityColor(allQualityScores!) }}>{p}</span>}
                                />
                            </Card>
                        )}
                        {/* Table classification summary */}
                        {Object.values(classificationSummary).some(v => v > 0) && (
                            <Card size="small">
                                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>Table Types</Text>
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                    {classificationSummary.fact > 0 && <Tag style={{ background: '#6366f122', border: '1px solid #6366f155', color: '#6366f1' }}>Fact ×{classificationSummary.fact}</Tag>}
                                    {classificationSummary.dimension > 0 && <Tag style={{ background: '#10b98122', border: '1px solid #10b98155', color: '#10b981' }}>Dim ×{classificationSummary.dimension}</Tag>}
                                    {classificationSummary.junction > 0 && <Tag style={{ background: '#f59e0b22', border: '1px solid #f59e0b55', color: '#f59e0b' }}>Junction ×{classificationSummary.junction}</Tag>}
                                    {classificationSummary.lookup > 0 && <Tag style={{ background: '#3b82f622', border: '1px solid #3b82f655', color: '#3b82f6' }}>Lookup ×{classificationSummary.lookup}</Tag>}
                                </div>
                            </Card>
                        )}
                    </div>

                    {/* ── Relationships ───────────────────────────────────────── */}
                    {relationshipCount > 0 && (
                        <Card
                            title={<Space><ArrowRightOutlined /><span>Detected Relationships</span><Badge count={relationshipCount} style={{ backgroundColor: '#6366f1' }} /></Space>}
                            size="small"
                        >
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                {schemaData.relationships.map((rel: any, idx: number) => {
                                    const typeColorMap: Record<string, string> = {
                                        'many-to-one': '#3b82f6',
                                        '1-to-many': '#10b981',
                                        'many-to-many': '#f59e0b',
                                        'junction': '#6366f1',
                                    };
                                    const relType = rel.type || rel.relType || 'many-to-one';
                                    const color = typeColorMap[relType] || '#6b7280';
                                    const fromLabel = rel.from?.table ? `${rel.from.table}.${rel.from.column}` : `${rel.fromTable}.${rel.via}`;
                                    const toLabel = rel.to?.table ? `${rel.to.table}.${rel.to.column}` : rel.toTable;
                                    return (
                                        <div key={idx} style={{
                                            display: 'flex', alignItems: 'center', gap: 6,
                                            padding: '4px 10px', borderRadius: 8,
                                            background: `${color}11`, border: `1px solid ${color}33`
                                        }}>
                                            <Tag style={{ background: `${color}22`, border: `1px solid ${color}55`, color, margin: 0, fontSize: 10 }}>{relType}</Tag>
                                            <Text code style={{ fontSize: 11 }}>{fromLabel}</Text>
                                            <ArrowRightOutlined style={{ color, fontSize: 10 }} />
                                            <Text code style={{ fontSize: 11 }}>{toLabel}</Text>
                                        </div>
                                    );
                                })}
                            </div>
                        </Card>
                    )}
                    {tableCount > 1 && relationshipCount === 0 && (
                        <Alert
                            showIcon
                            type="warning"
                            title="No relationships detected across selected tables"
                            description="Foreign keys may be missing or table names may not match exactly. If your schema has relationships, click Refresh Schema to rescan."
                            style={{ background: 'rgba(250, 173, 20, 0.1)', border: '1px solid rgba(250, 173, 20, 0.35)' }}
                        />
                    )}

                    {joinExamples.length > 0 && (
                        <Card
                            title={<Space><TableOutlined /><span>Join Examples</span><Tag color="processing">Auto Generated</Tag></Space>}
                            size="small"
                        >
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                                {joinExamples.map((example) => (
                                    <div key={example.id} style={{ border: '1px solid rgba(99, 102, 241, 0.25)', borderRadius: 8, background: 'rgba(99, 102, 241, 0.08)' }}>
                                        <div style={{ padding: '8px 10px', borderBottom: '1px solid rgba(99, 102, 241, 0.2)' }}>
                                            <Text strong>{example.label}</Text>
                                        </div>
                                        <pre style={{ margin: 0, padding: '10px 12px', whiteSpace: 'pre-wrap', fontSize: 12, color: '#dbe4ff' }}>
                                            {example.sql}
                                        </pre>
                                    </div>
                                ))}
                            </div>
                        </Card>
                    )}

                    {/* ── Table Search & Grid ─────────────────────────────────── */}
                    {(schemaData.tables?.length || 0) > 6 && (
                        <Input
                            prefix={<SearchOutlined style={{ color: '#6b7280' }} />}
                            placeholder={`Search ${schemaData.tables?.length} tables...`}
                            value={tableSearch}
                            onChange={(e) => setTableSearch(e.target.value)}
                            allowClear
                            style={{ maxWidth: 340 }}
                        />
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 24 }}>
                        {filteredTables.map((tableName: string) => {
                            const insight = schemaData.tableInsights?.[tableName];
                            const qualityReport: DataQualityReport | undefined = insight?.dataMatrix?.qualityReport;
                            const classification: TableClassification | undefined = insight?.dataMatrix?.classification;
                            const columnProfiles: ColumnProfile[] = insight?.dataMatrix?.columnProfiles || [];
                            const columnCount = Array.isArray(schemaData?.schemaInfo?.[tableName]?.columns)
                                ? schemaData.schemaInfo[tableName].columns.length
                                : (insight?.dataMatrix?.columnCounts?.total || 0);
                            const rowCount = schemaData.tableCounts?.[tableName] ?? 0;
                            const qs = qualityReport?.healthScore;

                            return (
                                <Card
                                    key={tableName}
                                    hoverable
                                    onClick={() => setActiveTable(tableName)}
                                    style={{ border: activeTable === tableName ? '1.5px solid #6366f1' : '1px solid #1e2530', borderRadius: 14 }}
                                    title={
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
                                            <Space>
                                                <Text code strong style={{ fontSize: 13 }}>{tableName}</Text>
                                                <Badge count={rowCount} overflowCount={9999999} style={{ backgroundColor: '#135bec' }} />
                                                <Tag color="blue" style={{ margin: 0, fontSize: 10 }}>Columns: {columnCount}</Tag>
                                            </Space>
                                            <Space size={4}>
                                                {classification && renderClassBadge(classification)}
                                                {qs !== undefined && (
                                                    <Tooltip title={`Data quality: ${qualityReport?.completeness}% complete, ${qualityReport?.uniqueness}% unique`}>
                                                        <span style={{
                                                            fontSize: 11, fontWeight: 700,
                                                            padding: '2px 8px', borderRadius: 99,
                                                            background: `${qualityColor(qs)}22`,
                                                            border: `1px solid ${qualityColor(qs)}55`,
                                                            color: qualityColor(qs)
                                                        }}>
                                                            ♥ {qs}
                                                        </span>
                                                    </Tooltip>
                                                )}
                                            </Space>
                                        </div>
                                    }
                                >

                                    {/* ── Quality Issues ─── */}
                                    {qualityReport && qualityReport.issues.length > 0 && (
                                        <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.15)' }}>
                                            <Text strong style={{ fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                                <WarningOutlined /> Data Quality Issues ({qualityReport.issues.length})
                                            </Text>
                                            {qualityReport.issues.slice(0, 5).map((issue, i) => {
                                                const sColor = issue.severity === 'high' ? '#ef4444' : issue.severity === 'medium' ? '#f59e0b' : '#6b7280';
                                                return (
                                                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                                                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: sColor, flexShrink: 0 }} />
                                                        <Text code style={{ fontSize: 10 }}>{issue.column}</Text>
                                                        <Text style={{ fontSize: 10, color: 'rgba(255,255,255,0.6)' }}>{issue.issue}</Text>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    {/* ── Column Profiles ─── */}
                                    {columnProfiles.length > 0 && (
                                        <details style={{ marginBottom: 12 }}>
                                            <summary style={{ cursor: 'pointer', padding: '6px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <ThunderboltOutlined style={{ color: '#6366f1', fontSize: 12 }} />
                                                <Text strong type="secondary" style={{ fontSize: 11 }}>COLUMN PROFILES ({columnProfiles.length})</Text>
                                            </summary>
                                            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                {columnProfiles.map((cp, idx) => (
                                                    <div key={idx} style={{ padding: '8px 10px', borderRadius: 8, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                                <Text style={{ fontSize: 12, fontWeight: 600 }}>{cp.name}</Text>
                                                                {renderRoleBadge(cp.role)}
                                                                <Text type="secondary" style={{ fontSize: 10 }}>{cp.type}</Text>
                                                            </div>
                                                            <div style={{ display: 'flex', gap: 4 }}>
                                                                {cp.qualityFlags.map(f => (
                                                                    <Tooltip key={f} title={f.replace(/_/g, ' ')}>
                                                                        <span style={{
                                                                            fontSize: 9, padding: '1px 4px', borderRadius: 3,
                                                                            background: f === 'potential_pii' ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)',
                                                                            border: f === 'potential_pii' ? '1px solid rgba(239,68,68,0.4)' : '1px solid rgba(245,158,11,0.4)',
                                                                            color: f === 'potential_pii' ? '#ef4444' : '#f59e0b'
                                                                        }}>
                                                                            {f === 'potential_pii' ? '\u{1F512}' : f === 'high_nulls' ? '\u26a0' : '\u2691'}
                                                                        </span>
                                                                    </Tooltip>
                                                                ))}
                                                            </div>
                                                        </div>
                                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
                                                            <div>
                                                                <Text type="secondary" style={{ fontSize: 10 }}>Null rate</Text>
                                                                {renderNullBar(cp.nullRate)}
                                                            </div>
                                                            <div>
                                                                <Text type="secondary" style={{ fontSize: 10 }}>Cardinality</Text>
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                                                    <Text style={{ fontSize: 10 }}>{cp.cardinality}</Text>
                                                                    {cp.isHighCardinality && <Tag style={{ fontSize: 9, padding: '0 4px', margin: 0, background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', color: '#6366f1' }}>high</Tag>}
                                                                    {cp.isConstant && <Tag color="warning" style={{ fontSize: 9, padding: '0 4px', margin: 0 }}>const</Tag>}
                                                                </div>
                                                            </div>
                                                            {cp.mean !== undefined && (
                                                                <>
                                                                    <div>
                                                                        <Text type="secondary" style={{ fontSize: 10 }}>Min / Max</Text>
                                                                        <Text style={{ fontSize: 10 }}>{cp.min?.toLocaleString()} \u2014 {cp.max?.toLocaleString()}</Text>
                                                                    </div>
                                                                    <div>
                                                                        <Text type="secondary" style={{ fontSize: 10 }}>Mean \u00b1 StdDev</Text>
                                                                        <Text style={{ fontSize: 10 }}>
                                                                            {cp.mean?.toFixed(2)} \u00b1 {cp.stddev?.toFixed(2)}
                                                                            {cp.isSkewed && <span style={{ color: '#f59e0b', marginLeft: 4 }}>\u2197 skew</span>}
                                                                        </Text>
                                                                    </div>
                                                                </>
                                                            )}
                                                        </div>
                                                        {cp.topValues.length > 0 && !cp.isHighCardinality && (
                                                            <div style={{ marginTop: 6 }}>
                                                                <Text type="secondary" style={{ fontSize: 10 }}>Top values: </Text>
                                                                {cp.topValues.slice(0, 3).map((tv, vi) => (
                                                                    <Tooltip key={vi} title={`${tv.count}\u00d7 (${tv.pct}%)`}>
                                                                        <Tag style={{ fontSize: 9, padding: '0 5px', margin: '0 3px 0 0', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)' }}>
                                                                            {tv.value.substring(0, 18)}{tv.value.length > 18 ? '\u2026' : ''} \u00b7 {tv.pct}%
                                                                        </Tag>
                                                                    </Tooltip>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                ))}
                                            </div>
                                        </details>
                                    )}

                                    {/* ── Suggested KPIs ─── */}
                                    {insight?.kpis && (
                                        <div style={{ marginBottom: 12 }}>
                                            <Text strong type="secondary" style={{ fontSize: 11 }}>SUGGESTED KPIS</Text>
                                            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                                {insight.kpis.map((kpi: any) => (
                                                    <Tooltip key={`${tableName}-kpi-${kpi.id}`} title={kpi.description}>
                                                        <Tag color="blue" style={{ margin: 0 }} closable closeIcon={<span style={{ fontSize: 12, marginLeft: 4 }}>\u00d7</span>} onClose={(e) => { e.preventDefault(); removeKpi(tableName, kpi.title); }}>
                                                            {kpi.title}
                                                        </Tag>
                                                    </Tooltip>
                                                ))}
                                            </div>
                                            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                                                <Input size="small" placeholder="Add KPI title" value={kpiDrafts[tableName] || ''} onChange={(e) => setKpiDrafts((prev) => ({ ...prev, [tableName]: e.target.value }))} onPressEnter={() => addKpi(tableName)} />
                                                <Button size="small" onClick={() => addKpi(tableName)}>Add</Button>
                                            </div>
                                        </div>
                                    )}

                                    {/* ── Query Examples ─── */}
                                    {insight?.queryExamples && insight.queryExamples.length > 0 && (
                                        <div style={{ marginBottom: 12, padding: '12px', borderRadius: 8, background: 'rgba(19, 91, 236, 0.05)', border: '1px solid rgba(19, 91, 236, 0.2)' }}>
                                            <Text strong type="secondary" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 6 }}>
                                                Query Examples (Executed)
                                            </Text>
                                            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                {insight.queryExamples.slice(0, 5).map((example: any, idx: number) => (
                                                    <details key={`query-${idx}`} style={{ borderRadius: 6, overflow: 'hidden', background: 'rgba(0,0,0,0.2)' }}>
                                                        <summary style={{ cursor: 'pointer', padding: '8px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11 }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                                <Tag color={example.error ? 'red' : 'green'} style={{ margin: 0, fontSize: 10 }}>{example.error ? 'X' : 'OK'}</Tag>
                                                                <Text style={{ fontSize: 11 }}>{example.description}</Text>
                                                            </div>
                                                            {example.executionTime && <Text type="secondary" style={{ fontSize: 10 }}>{example.executionTime}ms</Text>}
                                                        </summary>
                                                        <div style={{ padding: '8px 10px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                                                            <Text code style={{ fontSize: 10, display: 'block', padding: '6px', background: 'rgba(0,0,0,0.3)', borderRadius: 4, marginBottom: 8, overflow: 'auto' }}>
                                                                {example.sql}
                                                            </Text>
                                                            {example.error ? (
                                                                <Alert title={example.error} type="error" style={{ fontSize: 10 }} />
                                                            ) : example.results && example.results.length > 0 ? (
                                                                <div style={{ maxHeight: 120, overflow: 'auto' }}>
                                                                    <Table size="small" pagination={false}
                                                                        dataSource={example.results.map((row: any, ridx: number) => ({ ...row, key: ridx }))}
                                                                        columns={Object.keys(example.results[0] || {}).map((key) => ({
                                                                            title: key, dataIndex: key, key,
                                                                            render: (val: any) => <div style={{ maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10 }}>{String(val)}</div>
                                                                        }))}
                                                                    />
                                                                </div>
                                                            ) : (
                                                                <Text type="secondary" style={{ fontSize: 10 }}>No results</Text>
                                                            )}
                                                        </div>
                                                    </details>
                                                ))}
                                            </div>
                                        </div>
                                    )}

                                    {/* ── Column Controls ─── */}
                                    {rawSchemaData?.schemaInfo?.[tableName]?.columns?.length > 0 && (
                                        <div style={{ marginBottom: 12 }}>
                                            <details>
                                                <summary style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                                    <Text strong type="secondary" style={{ fontSize: 11 }}>COLUMN CONTROLS</Text>
                                                    <Button size="small" onClick={(e) => { e.preventDefault(); showAllColumns(tableName, rawSchemaData.schemaInfo[tableName].columns); }}>Show all</Button>
                                                </summary>
                                                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                    {rawSchemaData.schemaInfo[tableName].columns.map((col: any, idx: number) => {
                                                        const colName = col?.name || col?.column_name;
                                                        const toggles = getColumnToggle(tableName, colName, columnToggles, {
                                                            show: true,
                                                            filterable: isDefaultFilterableColumn(tableName, colName, rawSchemaData.schemaInfo[tableName].columns)
                                                        });
                                                        const profile = columnProfiles.find(p => p.name === colName);
                                                        return (
                                                            <div key={`${tableName}-col-${colName}-${idx}`} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 8px', borderRadius: 7, background: 'rgba(255,255,255,0.02)' }}>
                                                                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                                        <Text style={{ fontSize: 12 }}>{colName}</Text>
                                                                        {profile && renderRoleBadge(profile.role)}
                                                                    </div>
                                                                    <Text type="secondary" style={{ fontSize: 10 }}>{col.type || col.data_type}</Text>
                                                                </div>
                                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                                                        <Text type="secondary" style={{ fontSize: 10 }}>Show</Text>
                                                                        <Switch size="small" checked={toggles.show} onChange={(checked) => updateColumnToggle(tableName, colName, 'show', checked)} />
                                                                    </div>
                                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                                                        <Text type="secondary" style={{ fontSize: 10 }}>Filter</Text>
                                                                        <Switch size="small" checked={toggles.filterable} onChange={(checked) => updateColumnToggle(tableName, colName, 'filterable', checked)} />
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </details>
                                        </div>
                                    )}

                                    <Divider style={{ margin: '10px 0' }} />

                                    {/* ── Sample Data ─── */}
                                    <div>
                                        <Text strong type="secondary" style={{ fontSize: 11 }}>SAMPLES (LAST 10)</Text>
                                        <div style={{ marginTop: 8, overflowX: 'auto' }}>
                                            <Table
                                                size="small"
                                                pagination={false}
                                                dataSource={schemaData.sampleData[tableName]?.map((row: any, idx: number) => {
                                                    const { __rowKey, ...rest } = row || {};
                                                    return { ...rest, __rowKey: __rowKey || `row-${idx}` };
                                                })}
                                                columns={(() => {
                                                    const controlsOrder = (rawSchemaData?.schemaInfo?.[tableName]?.columns || [])
                                                        .map((col: any) => col?.name || col?.column_name)
                                                        .filter(Boolean);
                                                    const visible = (schemaData.visibleColumns?.[tableName] || controlsOrder)
                                                        .filter((key: string) => key !== '__rowKey');
                                                    const ordered = [
                                                        ...controlsOrder.filter((key: string) => visible.includes(key)),
                                                        ...visible.filter((key: string) => !controlsOrder.includes(key))
                                                    ];
                                                    return ordered.map((key: string) => ({
                                                        title: key, dataIndex: key, key,
                                                        render: (val: any) => (
                                                            <div style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                {String(val)}
                                                            </div>
                                                        )
                                                    }));
                                                })()}
                                                rowKey="__rowKey"
                                            />
                                        </div>
                                    </div>
                                </Card>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};

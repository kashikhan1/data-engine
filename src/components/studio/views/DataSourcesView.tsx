'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { AVAILABLE_INTEGRATIONS } from '@/lib/studio-constants';
import NewMcpAgentModal from '../modals/NewMcpAgentModal';
import PostgresConnectionModal from '../modals/PostgresConnectionModal';
import { useConfigStore } from '@/state/stores';
import { dbGateway } from '@/lib/mcp/client';

interface DataSourcesViewProps {
    selectedId: string | null;
    onSelect: (id: string) => void;
}

const DataSourcesView: React.FC<DataSourcesViewProps> = ({ selectedId, onSelect }) => {
    const [isMcpModalOpen, setIsMcpModalOpen] = useState(false);
    const [isPgModalOpen, setIsPgModalOpen] = useState(false);
    const [dbType, setDbType] = useState<'PostgreSQL' | 'MSSQL'>('PostgreSQL');
    const {
        dataSources,
        connectionStatus,
        discoveredTables,
        postgresUrl,
        mssqlUrl,
        setPostgresUrl,
        setMssqlUrl,
        setDiscoveredTables,
        updateDataSource
    } = useConfigStore();
    const [selectedTables, setSelectedTables] = useState<string[]>([]);
    const [activeTable, setActiveTable] = useState<string | null>(null);
    const [tableSchemas, setTableSchemas] = useState<Record<string, any>>({});
    const [tablePreviews, setTablePreviews] = useState<Record<string, any[]>>({});
    const [columnToggles, setColumnToggles] = useState<Record<string, Record<string, { show?: boolean }>>>({});
    const [isSchemaSyncing, setIsSchemaSyncing] = useState(false);
    const [schemaError, setSchemaError] = useState<string | null>(null);
    const [schemaSearch, setSchemaSearch] = useState('');
    const [showSchemaPanel, setShowSchemaPanel] = useState(true);
    const [connectorInstructions, setConnectorInstructions] = useState('');
    const [tableLoading, setTableLoading] = useState<Record<string, { schema: boolean; preview: boolean }>>({});
    const COLUMN_TOGGLES_KEY = 'schema_column_toggles';
    const SELECTED_TABLES_KEY = 'schema_selected_tables';
    const SELECTED_SCHEMA_KEY = 'selected_schema';

    useEffect(() => {
        try {
            const stored = localStorage.getItem('schema_selected_tables');
            if (stored) {
                const parsed = JSON.parse(stored);
                if (Array.isArray(parsed)) setSelectedTables(parsed);
            }
            const storedToggles = localStorage.getItem(COLUMN_TOGGLES_KEY);
            if (storedToggles) {
                const parsedToggles = JSON.parse(storedToggles);
                if (parsedToggles && typeof parsedToggles === 'object') {
                    setColumnToggles(parsedToggles);
                }
            }
        } catch {
            setSelectedTables([]);
        }
    }, []);

    const resolveDisplayStatus = (ds: any) => {
        if (!ds) return "Disconnected";
        return ds.status || "Disconnected";
    };

    const isSqlSource = (ds: any) => Boolean(ds?.connectionString);
    const isMcpSource = (ds: any) => String(ds?.type || '').toLowerCase().includes('mcp');
    const hasHttpEndpoint = (value?: string) => /^https?:\/\//i.test(String(value || '').trim());
    const isMssqlConnectionString = (value?: string) => {
        const lower = String(value || '').toLowerCase();
        return (
            lower.startsWith('mssql://') ||
            lower.startsWith('sqlserver://') ||
            lower.includes('server=') ||
            lower.includes('data source=')
        );
    };
    const isPostgresConnectionString = (value?: string) => {
        const lower = String(value || '').toLowerCase();
        return lower.startsWith('postgres://') || lower.startsWith('postgresql://');
    };

    const checkDataSourceHealth = async (ds: any) => {
        if (isSqlSource(ds)) {
            const conn = String(ds.connectionString || '');
            const type = String(ds?.type || '').toLowerCase();
            const expectsMssql = type.includes('mssql') || type.includes('sql server');
            const expectsPostgres = type.includes('postgres');

            if (expectsMssql && !isMssqlConnectionString(conn)) {
                return { status: 'Error' as const, lastSync: new Date().toLocaleTimeString() };
            }
            if (expectsPostgres && !isPostgresConnectionString(conn)) {
                return { status: 'Error' as const, lastSync: new Date().toLocaleTimeString() };
            }

            try {
                const ok = await dbGateway.connect(conn);
                if (!ok) {
                    return { status: 'Error' as const, lastSync: new Date().toLocaleTimeString() };
                }

                const tables = await dbGateway.listTables(conn);
                const listHealthy = Array.isArray(tables);
                return { 
                    status: (listHealthy ? 'Connected' : 'Error') as "Connected" | "Error", 
                    lastSync: new Date().toLocaleTimeString() 
                };
            } catch {
                return { status: 'Error' as const, lastSync: new Date().toLocaleTimeString() };
            }
        }

        if (isMcpSource(ds) && hasHttpEndpoint(ds.details)) {
            try {
                const result = await dbGateway.testMcpConnection(ds.details);
                return { status: result.status, lastSync: new Date().toLocaleTimeString() };
            } catch {
                return { status: 'Error' as const, lastSync: new Date().toLocaleTimeString() };
            }
        }

        return { status: 'Disconnected' as const, lastSync: ds?.lastSync || 'Not checked' };
    };

    const selectedDataSource = useMemo(() => {
        return dataSources.find((ds) => ds.id === selectedId) || dataSources[0] || null;
    }, [dataSources, selectedId]);

    const selectedConnectionString = useMemo(() => {
        const dsType = String(selectedDataSource?.type || '').toLowerCase();
        if (selectedDataSource?.connectionString) return selectedDataSource.connectionString;
        const details = String(selectedDataSource?.details || '');
        const detailsLooksSql = /^((postgres|postgresql|mssql|sqlserver):\/\/|server=|data source=)/i.test(details);
        if (detailsLooksSql) return details;
        if (dsType.includes('mssql') || dsType.includes('sql server')) return mssqlUrl || '';
        if (dsType.includes('postgres')) return postgresUrl || '';
        return '';
    }, [selectedDataSource, mssqlUrl, postgresUrl]);

    const selectedStatus = useMemo(() => {
        return selectedDataSource ? resolveDisplayStatus(selectedDataSource) : connectionStatus;
    }, [selectedDataSource, connectionStatus]);

    const normalizeTableName = (name: string) => {
        return String(name || '')
            .trim()
            .replace(/^\[|\]$/g, '')
            .replace(/^"|"$/g, '')
            .toLowerCase();
    };

    const normalizeSchemaPayload = (payload: any) => {
        if (!payload || typeof payload !== 'object') return { columns: [] };
        if ((payload as any).error) return { columns: [] };
        if (Array.isArray((payload as any).columns)) return payload;
        if (Array.isArray((payload as any).data?.columns)) return (payload as any).data;
        return { columns: [] };
    };

    const normalizePreviewPayload = (payload: any) => {
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload?.rows)) return payload.rows;
        if (Array.isArray(payload?.data)) return payload.data;
        return [];
    };

    // If nothing selected (or selected source vanished), default to first connected SQL source.
    useEffect(() => {
        const selectedExists = selectedId && dataSources.some((ds) => ds.id === selectedId);
        if (selectedExists) return;
        const preferred = dataSources.find((ds) =>
            resolveDisplayStatus(ds) === 'Connected' &&
            /(postgres|mssql|sql server)/i.test(String(ds?.type || ''))
        );
        if (preferred?.id) onSelect(preferred.id);
    }, [selectedId, dataSources, onSelect]);

    const [isRefreshing, setIsRefreshing] = useState(false);
    const handleRefresh = async () => {
        setIsRefreshing(true);
        await Promise.all(dataSources.map(async (ds) => {
            const next = await checkDataSourceHealth(ds);
            useConfigStore.getState().updateDataSource(ds.id, next);
        }));
        setIsRefreshing(false);
    };

    useEffect(() => {
        let cancelled = false;
        const refresh = async () => {
            const currentSources = useConfigStore.getState().dataSources;
            for (const ds of currentSources) {
                if (cancelled) return;
                const next = await checkDataSourceHealth(ds);
                useConfigStore.getState().updateDataSource(ds.id, next);
            }
        };
        // Always refresh on mount to ping the database
        setIsRefreshing(true);
        refresh().finally(() => {
            if (!cancelled) {
                setIsRefreshing(false);
            }
        });

        const interval = setInterval(refresh, 15000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, []);

    const healthyCount = dataSources.filter(ds => resolveDisplayStatus(ds) === 'Connected').length;
    const errorCount = dataSources.filter(ds => {
        const status = resolveDisplayStatus(ds);
        return status === 'Error' || status === 'Auth Error';
    }).length;

    useEffect(() => {
        // Clear tables when connection changes so they don't leak across DBs
        setDiscoveredTables([]);
        setTablePreviews({});
        setTableSchemas({});

        if (selectedStatus !== 'Connected' || !selectedConnectionString) return;

        dbGateway.listTables(selectedConnectionString)
            .then((tables) => {
                if (Array.isArray(tables)) {
                    setDiscoveredTables(tables);
                    setSelectedTables((prev) => {
                        // If React state is stale (e.g. modal just saved to localStorage),
                        // fall back to localStorage so we don't overwrite a valid selection with [].
                        let effective = prev;
                        if (prev.length === 0) {
                            try {
                                const stored = localStorage.getItem(SELECTED_TABLES_KEY);
                                if (stored) {
                                    const parsed = JSON.parse(stored);
                                    if (Array.isArray(parsed) && parsed.length > 0) effective = parsed;
                                }
                            } catch { /* use empty prev */ }
                        }
                        const available = new Set(tables.map((t) => normalizeTableName(t)));
                        const next = effective.filter((t) => available.has(normalizeTableName(t)));
                        localStorage.setItem(SELECTED_TABLES_KEY, JSON.stringify(next));
                        return Array.from(new Set(next));
                    });
                    setActiveTable((prevActive) =>
                        (prevActive && !new Set(tables.map((t) => normalizeTableName(t))).has(normalizeTableName(prevActive)))
                            ? null
                            : prevActive
                    );
                }
            })
            .catch(() => {
                // ignore
            });
    }, [selectedStatus, selectedConnectionString, setDiscoveredTables]);

    const otherTables = useMemo(() => {
        const selectedSet = new Set(selectedTables);
        return (discoveredTables || []).filter((t) => !selectedSet.has(t));
    }, [discoveredTables, selectedTables]);

    const filteredSelected = useMemo(() => {
        const term = schemaSearch.trim().toLowerCase();
        if (!term) return selectedTables;
        return selectedTables.filter((t) => t.toLowerCase().includes(term));
    }, [schemaSearch, selectedTables]);

    const filteredOther = useMemo(() => {
        const term = schemaSearch.trim().toLowerCase();
        if (!term) return otherTables;
        return otherTables.filter((t) => t.toLowerCase().includes(term));
    }, [schemaSearch, otherTables]);

    const persistSelection = (nextSelected: string[]) => {
        setSelectedTables(nextSelected);
        localStorage.setItem(SELECTED_TABLES_KEY, JSON.stringify(nextSelected));
    };

    const toggleTable = (table: string) => {
        const next = selectedTables.includes(table)
            ? selectedTables.filter((t) => t !== table)
            : [...selectedTables, table];
        persistSelection(next);
    };

    const selectTable = (table: string) => {
        if (!selectedConnectionString || selectedStatus !== 'Connected') {
            setSchemaError('Connect a data source first, then select a table.');
            return;
        }
        if (!selectedTables.includes(table)) {
            persistSelection([...selectedTables, table]);
        }
        setSchemaError(null);
        setActiveTable(table);
        // Clear stale per-table cache before loading to avoid stuck empty states.
        setTableSchemas((prev) => ({ ...prev, [table]: { columns: [] } }));
        setTablePreviews((prev) => ({ ...prev, [table]: [] }));
        setTableLoading((prev) => ({
            ...prev,
            [table]: { ...(prev[table] || { schema: false, preview: false }), schema: true, preview: true }
        }));
        Promise.all([
            dbGateway.getTableSchema(table, selectedConnectionString),
            dbGateway.getTablePreview(table, selectedConnectionString)
        ])
            .then(([schema, rows]) => {
                const safeSchema = normalizeSchemaPayload(schema);
                const safeRows = normalizePreviewPayload(rows);
                setTableSchemas((prev) => ({ ...prev, [table]: safeSchema }));
                setTablePreviews((prev) => ({ ...prev, [table]: safeRows }));

                const existingToggles = columnToggles[table] || {};
                const schemaColumns = Array.isArray((safeSchema as any)?.columns) ? (safeSchema as any).columns : [];
                const inferredColumnNames = schemaColumns.length > 0
                    ? schemaColumns.map((col: any) => col?.column_name || col?.name).filter(Boolean)
                    : Object.keys(safeRows[0] || {}).filter((k) => k !== '__rowKey');
                const nextMap: Record<string, { show?: boolean }> = { ...existingToggles };
                inferredColumnNames.forEach((name: string) => {
                    if (!nextMap[name]) nextMap[name] = { show: true };
                });
                setColumnToggles((prev) => ({ ...prev, [table]: nextMap }));

                if (schemaColumns.length === 0 && safeRows.length === 0) {
                    setSchemaError(`No schema/preview returned for ${table}. Check table permissions or schema name.`);
                }
            })
            .catch((err: any) => setSchemaError(err?.message || `Failed to load table data for ${table}`))
            .finally(() => {
                setTableLoading((prev) => ({
                    ...prev,
                    [table]: { ...(prev[table] || { schema: false, preview: false }), schema: false, preview: false }
                }));
            });
    };

    const disconnectDataSource = (ds: any) => {
        const type = String(ds?.type || '').toLowerCase();
        if (type.includes('postgres')) {
            setPostgresUrl('');
        }
        if (type.includes('mssql') || type.includes('sql server')) {
            setMssqlUrl('');
        }
        updateDataSource(ds.id, {
            status: 'Disconnected',
            lastSync: 'Disconnected',
            connectionString: '',
            details: String(ds?.details || '').startsWith('mcp') ? ds.details : 'Not connected'
        });
        setDiscoveredTables([]);
        setActiveTable(null);
        setTableSchemas({});
        setTablePreviews({});
        setSchemaError(null);
    };

    const updateColumnToggle = (table: string, column: string, value: boolean) => {
        setColumnToggles((prev) => ({
            ...prev,
            [table]: {
                ...(prev[table] || {}),
                [column]: {
                    ...(prev[table]?.[column] || {}),
                    show: value
                }
            }
        }));
    };

    const renderableColumns = useMemo(() => {
        if (!activeTable) return [];
        const schemaCols = Array.isArray(tableSchemas[activeTable]?.columns) ? tableSchemas[activeTable].columns : [];
        if (schemaCols.length > 0) return schemaCols;
        const previewRows = Array.isArray(tablePreviews[activeTable]) ? tablePreviews[activeTable] : [];
        const first = previewRows[0] || {};
        return Object.keys(first)
            .filter((k) => k !== '__rowKey')
            .map((name) => ({ name, column_name: name, data_type: 'unknown' }));
    }, [activeTable, tableSchemas, tablePreviews]);

    const visibleRenderableColumns = useMemo(() => {
        if (!activeTable) return [];
        return renderableColumns.filter((c: any) => {
            const name = c?.column_name || c?.name;
            return name && columnToggles[activeTable]?.[name]?.show !== false;
        });
    }, [activeTable, renderableColumns, columnToggles]);

    const saveSelection = async () => {
        if (!selectedConnectionString) return;
        setIsSchemaSyncing(true);
        setSchemaError(null);
        try {
            const schemaData: Record<string, any> = {};
            const tableCounts: Record<string, number> = {};
            for (const table of selectedTables) {
                const [preview, tableSchema] = await Promise.all([
                    tablePreviews[table] ? Promise.resolve(tablePreviews[table]) : dbGateway.getTablePreview(table, selectedConnectionString),
                    tableSchemas[table] ? Promise.resolve(tableSchemas[table]) : dbGateway.getTableSchema(table, selectedConnectionString)
                ]);

                const toggles = columnToggles[table] || {};
                const normalizedSchema = normalizeSchemaPayload(tableSchema);
                const normalizedPreview = normalizePreviewPayload(preview);
                const columns = Array.isArray(normalizedSchema?.columns) ? normalizedSchema.columns : [];
                const allowedColumns = columns.filter((col: any) => {
                    const name = col?.column_name || col?.name;
                    if (!name) return false;
                    return toggles[name]?.show !== false;
                });
                const sampleRows = Array.isArray(normalizedPreview) ? normalizedPreview : [];
                tableCounts[table] = sampleRows.length;
                const filteredRows = sampleRows.map((row: any) => {
                    const next: Record<string, any> = {};
                    allowedColumns.forEach((col: any) => {
                        const name = col?.column_name || col?.name;
                        if (name && name in row) next[name] = row[name];
                    });
                    if (row.__rowKey) next.__rowKey = row.__rowKey;
                    return next;
                });

                schemaData[table] = {
                    columns: { ...normalizedSchema, columns: allowedColumns },
                    sampleRows: filteredRows
                };
            }
            localStorage.setItem(SELECTED_SCHEMA_KEY, JSON.stringify({ schemaData, tableCounts }));
            localStorage.setItem(SELECTED_TABLES_KEY, JSON.stringify(selectedTables));
            localStorage.setItem(COLUMN_TOGGLES_KEY, JSON.stringify(columnToggles));
        } catch (err: any) {
            setSchemaError(err.message || 'Failed to save schema selection.');
        } finally {
            setIsSchemaSyncing(false);
        }
    };

    useEffect(() => {
        setConnectorInstructions(selectedDataSource?.instructions || '');
    }, [selectedDataSource?.id]);

    return (
        <main className="flex-1 overflow-y-auto bg-[#0b0d11] p-10 canvas-grid custom-scrollbar">
            <div className="max-w-5xl mx-auto space-y-12">
                {/* Header Section */}
                <div className="relative group">
                    <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-[2rem] blur opacity-10 group-hover:opacity-20 transition duration-1000 group-hover:duration-200"></div>
                    <div className="relative bg-[#0f1218]/80 backdrop-blur-xl border border-white/5 p-10 rounded-[2rem] shadow-2xl flex justify-between items-center overflow-hidden">
                        <div className="absolute top-0 right-0 w-96 h-96 bg-blue-600/10 blur-[100px] -mr-48 -mt-48 animate-pulse"></div>
                        <div className="space-y-4 relative z-10 w-full">
                            <div className="flex items-center justify-between">
                                <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-[10px] font-bold uppercase tracking-[2px] text-blue-400">
                                    <span className="relative flex h-2 w-2">
                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
                                    </span>
                                    Live Infrastructure
                                </div>
                                <div className="flex items-center gap-6">
                                    <div className="flex flex-col items-end">
                                        <div className="text-3xl font-black text-white leading-none">{healthyCount}/{dataSources.length}</div>
                                        <div className="text-[10px] font-bold text-[#22c55e] uppercase tracking-wider mt-1">Healthy Nodes</div>
                                    </div>
                                    <div className="w-px h-8 bg-white/10"></div>
                                    <button
                                        onClick={handleRefresh}
                                        disabled={isRefreshing}
                                        className="p-3 bg-white/5 border border-white/10 rounded-2xl text-slate-400 hover:text-white hover:bg-white/10 hover:border-white/20 transition-all group disabled:opacity-50"
                                    >
                                        <span className={`material-symbols-outlined text-[20px] ${isRefreshing ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-500'}`}>sync</span>
                                    </button>
                                </div>
                            </div>
                            <h1 className="text-6xl font-black text-white tracking-tighter">Data Ingestion</h1>
                            <p className="text-slate-400 max-w-lg leading-relaxed text-sm font-medium opacity-70">
                                Connect your enterprise stack. Bridge the gap between raw data and semantic understanding with high-performance throughput.
                            </p>
                        </div>
                    </div>
                </div>

                {/* Integration Protocol Selection */}
                <div className="space-y-8">
                    <div className="flex items-end justify-between px-2">
                        <div className="space-y-1">
                            <h2 className="text-sm font-black text-slate-500 uppercase tracking-[4px]">Protocols</h2>
                            <p className="text-3xl font-black text-white tracking-tight">Deploy New Cluster</p>
                        </div>
                    </div>
                    <div className="grid grid-cols-3 gap-6">
                        {AVAILABLE_INTEGRATIONS.map((int) => (
                            <div
                                key={int.id}
                                onClick={() => {
                                    if (int.name.toLowerCase().includes('mcp')) {
                                        setIsMcpModalOpen(true)
                                    } else if (int.name.toLowerCase().includes('postgres')) {
                                        setDbType('PostgreSQL');
                                        setIsPgModalOpen(true);
                                    } else if (int.name.toLowerCase().includes('mssql') || int.name.toLowerCase().includes('sql server')) {
                                        setDbType('MSSQL');
                                        setIsPgModalOpen(true);
                                    }
                                }}
                                className="relative bg-[#11141d]/40 backdrop-blur-md border border-white/[0.03] rounded-[2.5rem] p-10 flex flex-col items-center text-center gap-8 hover:border-blue-500/30 cursor-pointer transition-all group shadow-2xl hover:-translate-y-2 active:scale-[0.98] overflow-hidden"
                            >
                                <div className="absolute inset-0 bg-gradient-to-br from-blue-600/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
                                <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-blue-500/5 blur-[60px] group-hover:bg-blue-500/10 transition-colors"></div>

                                <div className="relative">
                                    <div className={`w-24 h-24 rounded-[2rem] bg-[#1a202c]/50 border border-white/[0.05] flex items-center justify-center text-slate-500 group-hover:text-blue-400 transition-all group-hover:shadow-[0_0_50px_rgba(59,130,246,0.15)] group-hover:border-blue-500/20`}>
                                        <span className="material-symbols-outlined text-[48px] font-light leading-none">{int.icon}</span>
                                    </div>
                                    <div className="absolute -top-2 -right-2 w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center shadow-2xl opacity-0 group-hover:opacity-100 translate-y-4 group-hover:translate-y-0 transition-all duration-300">
                                        <span className="material-symbols-outlined text-[20px] font-bold">add</span>
                                    </div>
                                </div>
                                <div className="relative z-10 space-y-3">
                                    <div className="text-xl font-black text-white tracking-tight">{int.name}</div>
                                    <div className="text-[10px] text-slate-500 font-bold tracking-[3px] uppercase opacity-50 px-6">{int.description}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Active Pipelines Cards */}
                <div className="space-y-6">
                    <div className="flex items-center justify-between px-2">
                        <div className="flex items-center gap-4">
                            <h2 className="text-sm font-black text-slate-500 uppercase tracking-[4px]">Active Nodes</h2>
                            <div className="h-6 w-px bg-white/10"></div>
                            <span className="text-2xl font-black text-white tracking-tight underline decoration-blue-500 underline-offset-8">Fleet Health</span>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-8">
                        {dataSources.map((ds) => {
                            const displayStatus = resolveDisplayStatus(ds);
                            return (
                                <div
                                    key={ds.id}
                                    onClick={() => onSelect(ds.id)}
                                    className={`relative group cursor-pointer transition-all duration-500 ${selectedId === ds.id ? 'scale-[1.02]' : 'hover:scale-[1.01]'}`}
                                >
                                    <div className={`absolute -inset-0.5 rounded-[2.5rem] blur opacity-20 group-hover:opacity-40 transition duration-500 ${displayStatus === 'Connected' ? 'bg-green-500' : 'bg-red-500'}`}></div>
                                    <div className={`relative bg-[#0f1218]/90 backdrop-blur-2xl border border-white/5 rounded-[2.5rem] p-8 flex flex-col gap-6 overflow-hidden ${selectedId === ds.id ? 'border-blue-500/30' : ''}`}>
                                        <div className="flex items-start justify-between relative z-10">
                                            <div className="flex items-center gap-5">
                                                <div className={`w-16 h-16 rounded-[1.5rem] flex items-center justify-center shadow-2xl transition-all duration-500 ${selectedId === ds.id ? 'bg-blue-500 text-white scale-110 rotate-3' : 'bg-[#1a202c] text-slate-500'}`}>
                                                    <span className="material-symbols-outlined text-[32px]">{ds.icon}</span>
                                                </div>
                                                <div>
                                                    <div className="text-xl font-black text-white tracking-tight">{ds.name}</div>
                                                    <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1 opacity-60">{ds.type}</div>
                                                </div>
                                            </div>
                                            <div className={`px-4 py-1.5 rounded-full border text-[9px] font-black uppercase tracking-[2px] backdrop-blur-md ${displayStatus === 'Connected' ? 'bg-green-500/10 text-green-400 border-green-500/20' : 'bg-red-500/10 text-red-400 border-red-500/20'}`}>
                                                {displayStatus}
                                            </div>
                                        </div>

                                        <div className="grid grid-cols-3 gap-4 border-t border-white/5 pt-6 relative z-10">
                                            <div className="space-y-1">
                                                <div className="text-[8px] text-slate-500 font-black uppercase tracking-widest">Latency</div>
                                                <div className="text-xs font-bold text-slate-200">24ms</div>
                                            </div>
                                            <div className="space-y-1">
                                                <div className="text-[8px] text-slate-500 font-black uppercase tracking-widest">Uptime</div>
                                                <div className="text-xs font-bold text-slate-200">99.9%</div>
                                            </div>
                                            <div className="space-y-1 text-right">
                                                <div className="text-[8px] text-slate-500 font-black uppercase tracking-widest">Last Pulse</div>
                                                <div className="text-xs font-bold text-slate-200">{ds.lastSync}</div>
                                            </div>
                                        </div>
                                        {displayStatus === 'Connected' && (
                                            <div className="relative z-10 pt-2 border-t border-white/5 flex justify-end">
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        disconnectDataSource(ds);
                                                    }}
                                                    className="px-3 py-1.5 rounded-xl bg-black/40 border border-white/10 text-[9px] font-black uppercase tracking-[2px] text-slate-300 hover:text-white hover:border-red-500/40 hover:bg-red-500/10 transition-all"
                                                    title="Disconnect"
                                                >
                                                    Disconnect
                                                </button>
                                            </div>
                                        )}

                                        {/* Abstract Data Visualizer (Mock) */}
                                        <div className="h-1 lg:h-2 w-full bg-white/5 rounded-full overflow-hidden mt-2 relative">
                                            <div className={`absolute top-0 left-0 h-full w-2/3 transition-all duration-1000 ${displayStatus === 'Connected' ? 'bg-gradient-to-r from-green-500 to-emerald-400' : 'bg-red-500'}`}></div>
                                            <div className="absolute top-0 left-0 h-full w-full opacity-10 blur-sm bg-blue-500"></div>
                                        </div>

                                        {selectedId === ds.id && (
                                            <div className="absolute -right-8 -bottom-8 w-32 h-32 bg-blue-500/10 rounded-full blur-[40px] animate-pulse"></div>
                                        )}
                                    </div>
                                </div>
                            )
                        })}
                        {dataSources.length === 0 && (
                            <div className="col-span-2 px-10 py-24 text-center space-y-4 bg-white/[0.01] border border-dashed border-white/10 rounded-[3rem]">
                                <span className="material-symbols-outlined text-6xl text-slate-800 font-light">terminal</span>
                                <p className="text-xs font-black text-slate-500 uppercase tracking-[4px]">Waiting for ingestion...</p>
                            </div>
                        )}
                    </div>
                </div>


                {/* Connected Schema Explorer */}
                <div className="space-y-10 pt-10">
                    <div className="flex items-end justify-between px-2">
                        <div className="space-y-1">
                            <h2 className="text-sm font-black text-slate-500 uppercase tracking-[4px]">Semantic Layer</h2>
                            <p className="text-3xl font-black text-white tracking-tight">Logical Entities</p>
                        </div>
                        <div className="flex items-center gap-4">
                            <button
                                onClick={saveSelection}
                                disabled={isSchemaSyncing || selectedTables.length === 0}
                                className="px-8 py-3 rounded-2xl bg-white text-black text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-all disabled:opacity-30 disabled:grayscale shadow-[0_0_30px_rgba(255,255,255,0.1)] active:scale-95"
                            >
                                {isSchemaSyncing ? 'Syncing...' : 'Push to Production'}
                            </button>
                            <button
                                onClick={() => setShowSchemaPanel(!showSchemaPanel)}
                                className={`w-12 h-12 rounded-2xl border flex items-center justify-center transition-all ${showSchemaPanel ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' : 'bg-white/5 border-white/10 text-slate-500 hover:text-white'}`}
                            >
                                <span className={`material-symbols-outlined text-[20px] transition-transform duration-500 ${showSchemaPanel ? 'rotate-180' : ''}`}>expand_more</span>
                            </button>
                        </div>
                    </div>

                    {showSchemaPanel && (
                        <div className="relative group/panel">
                            <div className="absolute -inset-0.5 bg-gradient-to-b from-blue-500/10 to-transparent rounded-[3rem] blur opacity-40"></div>
                            <div className="relative bg-[#0b0d11]/80 backdrop-blur-3xl border border-white/[0.05] rounded-[3rem] overflow-hidden shadow-2xl">
                                    <div className="flex bg-white/[0.02] border-b border-white/[0.05] px-10 py-6 items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-green-500/10 border border-green-500/20 text-[9px] font-black text-green-400 uppercase tracking-widest">
                                            {selectedStatus}
                                        </div>
                                        <div className="text-[10px] text-slate-500 font-bold uppercase tracking-[2px] opacity-60">
                                            Manifest Explorer
                                        </div>
                                    </div>
                                    <div className="relative w-80">
                                        <span className="absolute left-4 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-600 text-[18px]">search</span>
                                        <input
                                            value={schemaSearch}
                                            onChange={(e) => setSchemaSearch(e.target.value)}
                                            placeholder="FILTER TABLES..."
                                            className="w-full pl-11 pr-4 py-2.5 text-[10px] font-black tracking-widest bg-black/40 border border-white/5 rounded-2xl text-slate-300 placeholder-slate-700 focus:outline-none focus:border-blue-500/50 transition-all"
                                        />
                                    </div>
                                    </div>
                                    {schemaError && (
                                        <div className="px-10 py-3 text-[11px] text-red-300 bg-red-500/10 border-b border-red-500/20">
                                            {schemaError}
                                        </div>
                                    )}
                                    <div className="grid grid-cols-12 h-[min(78vh,860px)]">
                                    {/* Sidebar: Table List */}
                                    <div className="col-span-4 border-r border-white/5 flex flex-col">
                                        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-8">
                                            <div className="space-y-4 min-h-0">
                                                <div className="text-[9px] text-slate-500 font-black uppercase tracking-[3px] px-2 flex justify-between items-center">
                                                    <span>Mounted ({selectedTables.length})</span>
                                                    <div className="w-12 h-px bg-white/5"></div>
                                                </div>
                                                <div className="space-y-2 max-h-[30vh] overflow-y-auto pr-1 custom-scrollbar">
                                                    {filteredSelected.map(table => (
                                                        <div
                                                            key={table}
                                                            onClick={() => selectTable(table)}
                                                            className={`group/item relative px-5 py-3.5 rounded-2xl border transition-all cursor-pointer flex items-center justify-between ${activeTable === table ? 'bg-blue-500/10 border-blue-500/30 ring-1 ring-blue-500/20' : 'bg-white/[0.02] border-white/5 hover:border-white/10'}`}
                                                        >
                                                            <div className="flex items-center gap-3 overflow-hidden">
                                                                <span className={`material-symbols-outlined text-[18px] ${activeTable === table ? 'text-blue-400' : 'text-slate-600'}`}>table_rows</span>
                                                                <span className={`text-xs font-bold truncate ${activeTable === table ? 'text-white' : 'text-slate-400 group-hover/item:text-slate-200'}`}>{table}</span>
                                                            </div>
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); toggleTable(table); }}
                                                                className="opacity-0 group-hover/item:opacity-100 p-1 hover:text-red-400 text-slate-600 transition-all"
                                                            >
                                                                <span className="material-symbols-outlined text-[16px]">close</span>
                                                            </button>
                                                            {activeTable === table && (
                                                                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-4 bg-blue-500 rounded-l-full shadow-[0_0_10px_rgba(59,130,246,0.5)]"></div>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>

                                            <div className="space-y-4 min-h-0">
                                                <div className="text-[9px] text-slate-500 font-black uppercase tracking-[3px] px-2 flex justify-between items-center">
                                                    <span>Available ({otherTables.length})</span>
                                                    <div className="w-12 h-px bg-white/5"></div>
                                                </div>
                                                <div className="grid grid-cols-1 gap-2 max-h-[30vh] overflow-y-auto pr-1 custom-scrollbar">
                                                    {filteredOther.map(table => (
                                                        <button
                                                            key={table}
                                                            onClick={() => selectTable(table)}
                                                            className="px-5 py-3 rounded-2xl bg-black/20 border border-white/[0.03] text-[11px] text-slate-500 font-bold text-left hover:border-white/10 hover:text-slate-300 transition-all flex items-center gap-3"
                                                        >
                                                            <span className="material-symbols-outlined text-[16px] opacity-40">add_box</span>
                                                            <span className="truncate">{table}</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Content: Schema Preview */}
                                    <div className="col-span-8 bg-black/20 flex flex-col relative overflow-hidden">
                                        {!activeTable && (
                                            <div className="flex-1 flex flex-col items-center justify-center text-center p-10 space-y-6">
                                                <div className="w-24 h-24 rounded-full bg-white/[0.02] border border-white/5 flex items-center justify-center">
                                                    <span className="material-symbols-outlined text-4xl text-slate-800 animate-pulse">data_object</span>
                                                </div>
                                                <div className="space-y-2">
                                                    <div className="text-sm font-black text-slate-500 uppercase tracking-widest">No Subject Selected</div>
                                                    <p className="text-xs text-slate-600 max-w-[240px] leading-relaxed">Select an entity from the registry to inspect schema mapping and data samples.</p>
                                                </div>
                                            </div>
                                        )}

                                        {activeTable && (
                                            <div className="flex-1 flex flex-col overflow-hidden">
                                                <div className="px-10 py-8 space-y-8 flex-1 overflow-y-auto custom-scrollbar">
                                                    <div className="flex items-end justify-between border-b border-white/5 pb-6">
                                                        <div className="space-y-2">
                                                            <div className="text-[9px] text-blue-400 font-black uppercase tracking-[3px]">Schema Signature</div>
                                                            <h3 className="text-3xl font-black text-white tracking-tighter">{activeTable}</h3>
                                                        </div>
                                                            <div className="text-right space-y-1">
                                                                <div className="text-[9px] text-slate-500 font-black uppercase tracking-widest">Cardinality</div>
                                                            <div className="text-xs font-bold text-slate-300">
                                                                {tableLoading[activeTable]?.preview
                                                                    ? 'Loading...'
                                                                    : Array.isArray(tablePreviews[activeTable])
                                                                        ? `${tablePreviews[activeTable].length} Records Loaded`
                                                                        : 'Preview unavailable'}
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <div className="grid grid-cols-2 gap-10">
                                                        {/* Columns Section */}
                                                        <div className="space-y-5">
                                                            <div className="flex items-center justify-between">
                                                                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">Field Mapping</h4>
                                                                <span className="text-[9px] text-slate-600 font-bold">{renderableColumns.length} Total</span>
                                                            </div>
                                                            <div className="space-y-2 h-[min(56vh,620px)] overflow-y-auto pr-2 custom-scrollbar">
                                                                {tableLoading[activeTable]?.schema && (
                                                                    <div className="text-[11px] text-slate-400 py-2">Loading columns...</div>
                                                                )}
                                                                {renderableColumns.map((col: any) => {
                                                                    const name = col?.column_name || col?.name;
                                                                    const toggles = columnToggles[activeTable]?.[name] || { show: true };
                                                                    const nullable = String(col?.is_nullable || '').toUpperCase() !== 'NO';
                                                                    const hasDefault = col?.column_default !== undefined && col?.column_default !== null && String(col?.column_default).length > 0;
                                                                    const isPrimary = Boolean(col?.isPrimary || col?.is_primary || col?.primaryKey);
                                                                    return (
                                                                        <div
                                                                            key={name}
                                                                            className={`group/field px-4 py-3 rounded-2xl border flex items-center justify-between transition-all ${toggles.show !== false ? 'bg-white/[0.03] border-white/5' : 'bg-transparent border-white/[0.02] opacity-40'}`}
                                                                        >
                                                                            <div className="flex items-center gap-3">
                                                                                <div className={`w-1.5 h-1.5 rounded-full ${toggles.show !== false ? 'bg-blue-400 shadow-[0_0_8px_rgba(96,165,250,0.5)]' : 'bg-slate-600'}`}></div>
                                                                                <div className="flex flex-col">
                                                                                    <span className="text-xs font-bold text-slate-300">{name}</span>
                                                                                    <span className="text-[8px] text-slate-600 font-black uppercase tracking-widest mt-0.5">{col?.data_type || 'VARCHAR'}</span>
                                                                                    <div className="mt-1 flex items-center gap-1.5 flex-wrap">
                                                                                        <span className={`text-[8px] px-1.5 py-0.5 rounded border ${nullable ? 'text-slate-500 border-white/10' : 'text-amber-300 border-amber-500/30 bg-amber-500/10'}`}>
                                                                                            {nullable ? 'NULL' : 'NOT NULL'}
                                                                                        </span>
                                                                                        {isPrimary && (
                                                                                            <span className="text-[8px] px-1.5 py-0.5 rounded border text-purple-300 border-purple-500/30 bg-purple-500/10">
                                                                                                PK
                                                                                            </span>
                                                                                        )}
                                                                                        {hasDefault && (
                                                                                            <span className="text-[8px] px-1.5 py-0.5 rounded border text-blue-300 border-blue-500/30 bg-blue-500/10">
                                                                                                DEFAULT
                                                                                            </span>
                                                                                        )}
                                                                                    </div>
                                                                                </div>
                                                                            </div>
                                                                            <label className="relative inline-flex items-center cursor-pointer">
                                                                                <input
                                                                                    type="checkbox"
                                                                                    className="sr-only peer"
                                                                                    checked={toggles.show !== false}
                                                                                    onChange={(e) => updateColumnToggle(activeTable, name, e.target.checked)}
                                                                                />
                                                                                <div className="w-8 h-4 bg-white/5 rounded-full peer peer-checked:bg-blue-500/20 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-600 peer-checked:after:bg-blue-400 after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4 border border-white/10 group-hover/field:border-white/20 transition-colors"></div>
                                                                            </label>
                                                                        </div>
                                                                    );
                                                                })}
                                                            </div>
                                                        </div>

                                                        {/* Snapshot Section */}
                                                        <div className="space-y-5">
                                                            <div className="flex items-center justify-between">
                                                                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[2px]">Data Snapshot</h4>
                                                                <span className="text-[9px] text-slate-600 font-bold uppercase">Raw Buffer</span>
                                                            </div>
                                                            <div className="bg-black/40 border border-white/5 rounded-[2rem] overflow-hidden">
                                                                <div className="p-4 overflow-x-auto custom-scrollbar-h">
                                                                    {tableLoading[activeTable]?.preview && (
                                                                        <div className="text-[11px] text-slate-400 pb-3">Loading preview rows...</div>
                                                                    )}
                                                                    <table className="w-full text-left border-collapse">
                                                                        <thead>
                                                                            <tr className="border-b border-white/5">
                                                                                <th className="px-3 py-2 text-[8px] font-black text-slate-600 uppercase tracking-widest">Index</th>
                                                                                {visibleRenderableColumns.map((col: any) => (
                                                                                    <th key={col.column_name || col.name} className="px-3 py-2 text-[8px] font-black text-slate-600 uppercase tracking-widest truncate max-w-[80px]">
                                                                                        {col.column_name || col.name}
                                                                                    </th>
                                                                                ))}
                                                                            </tr>
                                                                        </thead>
                                                                        <tbody className="divide-y divide-white/[0.02]">
                                                                            {(tablePreviews[activeTable] || []).slice(0, 10).map((row: any, i: number) => (
                                                                                <tr key={i} className="hover:bg-white/[0.01] transition-colors">
                                                                                    <td className="px-3 py-2 text-[9px] font-mono text-slate-700">{i + 1}</td>
                                                                                    {visibleRenderableColumns.map((col: any) => (
                                                                                        <td key={col.column_name || col.name} className="px-3 py-2 text-[10px] text-slate-400 font-medium truncate max-w-[80px]">
                                                                                            {String(row[col.column_name || col.name] || '—')}
                                                                                        </td>
                                                                                    ))}
                                                                                </tr>
                                                                            ))}
                                                                            {(!tableLoading[activeTable]?.preview && (tablePreviews[activeTable] || []).length === 0) && (
                                                                                <tr>
                                                                                    <td
                                                                                        colSpan={Math.max(2, visibleRenderableColumns.length + 1)}
                                                                                        className="px-3 py-4 text-[11px] text-slate-500 text-center"
                                                                                    >
                                                                                        No records returned for this table.
                                                                                    </td>
                                                                                </tr>
                                                                            )}
                                                                        </tbody>
                                                                    </table>
                                                                </div>
                                                                <div className="bg-white/[0.02] px-4 py-3 flex justify-center">
                                                                    <button className="text-[8px] font-black text-slate-500 uppercase tracking-widest hover:text-white transition-all">View Full Registry</button>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>

            </div>

            <NewMcpAgentModal isOpen={isMcpModalOpen} onClose={() => setIsMcpModalOpen(false)} />
            <PostgresConnectionModal isOpen={isPgModalOpen} onClose={() => {
                setIsPgModalOpen(false);
                // Modal may have saved tables to localStorage — sync our state with it
                try {
                    const stored = localStorage.getItem(SELECTED_TABLES_KEY);
                    if (stored) {
                        const parsed = JSON.parse(stored);
                        if (Array.isArray(parsed)) setSelectedTables(parsed);
                    }
                } catch { /* ignore */ }
            }} dbType={dbType} />
        </main>
    );
};

export default DataSourcesView;

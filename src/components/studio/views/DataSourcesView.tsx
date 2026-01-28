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
    const { dataSources, connectionStatus, discoveredTables, postgresUrl, setDiscoveredTables } = useConfigStore();
    const [selectedTables, setSelectedTables] = useState<string[]>([]);
    const [activeTable, setActiveTable] = useState<string | null>(null);
    const [tableSchemas, setTableSchemas] = useState<Record<string, any>>({});
    const [tablePreviews, setTablePreviews] = useState<Record<string, any[]>>({});
    const [columnToggles, setColumnToggles] = useState<Record<string, Record<string, { show?: boolean }>>>({});
    const [isSchemaSyncing, setIsSchemaSyncing] = useState(false);
    const [schemaError, setSchemaError] = useState<string | null>(null);
    const [schemaSearch, setSchemaSearch] = useState('');

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
    }, [isPgModalOpen, isMcpModalOpen]);

    useEffect(() => {
        if (connectionStatus !== 'Connected' || !postgresUrl) return;
        if ((discoveredTables || []).length > 0) return;
        dbGateway.listTables(postgresUrl)
            .then((tables) => {
                if (Array.isArray(tables)) setDiscoveredTables(tables);
            })
            .catch(() => {
                // ignore
            });
    }, [connectionStatus, postgresUrl, discoveredTables, setDiscoveredTables]);

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
        if (!selectedTables.includes(table)) {
            persistSelection([...selectedTables, table]);
        }
        setActiveTable(table);
        if (!tableSchemas[table]) {
            dbGateway.getTableSchema(table, postgresUrl)
                .then((schema) => {
                    setTableSchemas((prev) => ({ ...prev, [table]: schema }));
                    if (!columnToggles[table]) {
                        const columns = Array.isArray(schema?.columns) ? schema.columns : [];
                        const nextMap: Record<string, { show?: boolean }> = {};
                        columns.forEach((col: any) => {
                            const name = col?.column_name || col?.name;
                            if (!name) return;
                            nextMap[name] = { show: true };
                        });
                        setColumnToggles((prev) => ({ ...prev, [table]: nextMap }));
                    }
                })
                .catch(() => setSchemaError(`Failed to load schema for ${table}`));
        }
        if (!tablePreviews[table]) {
            dbGateway.getTablePreview(table, postgresUrl)
                .then((rows) => {
                    setTablePreviews((prev) => ({ ...prev, [table]: Array.isArray(rows) ? rows : [] }));
                })
                .catch(() => setSchemaError(`Failed to load preview for ${table}`));
        }
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

    const saveSelection = async () => {
        if (!postgresUrl) return;
        setIsSchemaSyncing(true);
        setSchemaError(null);
        try {
            const schemaData: Record<string, any> = {};
            const tableCounts: Record<string, number> = {};
            for (const table of selectedTables) {
                const [preview, tableSchema] = await Promise.all([
                    tablePreviews[table] ? Promise.resolve(tablePreviews[table]) : dbGateway.getTablePreview(table, postgresUrl),
                    tableSchemas[table] ? Promise.resolve(tableSchemas[table]) : dbGateway.getTableSchema(table, postgresUrl)
                ]);

                const toggles = columnToggles[table] || {};
                const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
                const allowedColumns = columns.filter((col: any) => {
                    const name = col?.column_name || col?.name;
                    if (!name) return false;
                    return toggles[name]?.show !== false;
                });
                const sampleRows = Array.isArray(preview) ? preview : [];
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
                    columns: { ...tableSchema, columns: allowedColumns },
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

    const healthyCount = dataSources.filter(ds => ds.status === 'Connected').length;
    const errorCount = dataSources.filter(ds => ds.status === 'Error' || ds.status === 'Auth Error').length;

    return (
        <main className="flex-1 overflow-y-auto bg-[#0b0d11] p-10 canvas-grid custom-scrollbar">
            <div className="max-w-5xl mx-auto space-y-12">
                {/* Header Section */}
                <div className="flex justify-between items-start">
                    <div className="space-y-2">
                        <h1 className="text-4xl font-extrabold text-white tracking-tight">Data Source</h1>
                        <p className="text-slate-400 max-w-xl leading-relaxed text-sm font-medium">
                            Manage your data connections, configure sync settings, and monitor data freshness. Connect to databases, SaaS tools, and APIs.
                        </p>
                    </div>
                    <div className="flex gap-4">
                        <button className="flex items-center gap-2.5 px-5 py-2.5 bg-[#1a202c] border border-[#2d3748] rounded-xl text-xs font-bold uppercase tracking-widest text-slate-300 hover:text-white hover:bg-[#232936] transition-all shadow-lg active:scale-95">
                            <span className="material-symbols-outlined text-[18px]">sync</span>
                            Sync All
                        </button>
                        <button
                            onClick={() => {
                                setDbType('PostgreSQL');
                                setIsPgModalOpen(true);
                            }}
                            className="flex items-center gap-2.5 px-6 py-2.5 bg-[#135bec] text-white rounded-xl text-xs font-bold uppercase tracking-widest hover:bg-blue-600 transition-all shadow-[0_0_20px_rgba(19,91,236,0.3)] active:scale-95"
                        >
                            <span className="material-symbols-outlined text-[18px]">add</span>
                            New Source
                        </button>
                    </div>
                </div>

                {/* Summary Stats Cards */}
                <div className="grid grid-cols-3 gap-6">
                    <div className="bg-[#111318] border border-[#2d3748] p-8 rounded-2xl flex items-center gap-6 relative overflow-hidden group hover:border-[#2d3748]/80 transition-all shadow-xl">
                        <div className="absolute top-0 right-0 w-32 h-32 bg-blue-500/5 blur-[80px] -mr-16 -mt-16 group-hover:bg-blue-500/10 transition-colors"></div>
                        <div className="w-14 h-14 rounded-2xl bg-blue-500/10 text-[#135bec] flex items-center justify-center relative shadow-inner">
                            <span className="material-symbols-outlined text-[32px]">database</span>
                        </div>
                        <div>
                            <div className="text-4xl font-extrabold text-white tracking-tighter">{dataSources.length}</div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-[2px] font-black mt-1">Total Sources</div>
                        </div>
                    </div>
                    <div className="bg-[#111318] border border-[#2d3748] p-8 rounded-2xl flex items-center gap-6 relative overflow-hidden group hover:border-[#2d3748]/80 transition-all shadow-xl">
                        <div className="absolute top-0 right-0 w-32 h-32 bg-green-500/5 blur-[80px] -mr-16 -mt-16 group-hover:bg-green-500/10 transition-colors"></div>
                        <div className="w-14 h-14 rounded-2xl bg-green-500/10 text-green-500 flex items-center justify-center relative shadow-inner">
                            <span className="material-symbols-outlined text-[32px]">check_circle</span>
                        </div>
                        <div>
                            <div className="text-4xl font-extrabold text-white tracking-tighter">{healthyCount}</div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-[2px] font-black mt-1">Healthy</div>
                        </div>
                    </div>
                    <div className="bg-[#111318] border border-[#2d3748] p-8 rounded-2xl flex items-center gap-6 relative overflow-hidden group hover:border-[#2d3748]/80 transition-all shadow-xl">
                        <div className="absolute top-0 right-0 w-32 h-32 bg-red-500/5 blur-[80px] -mr-16 -mt-16 group-hover:bg-red-500/10 transition-colors"></div>
                        <div className="w-14 h-14 rounded-2xl bg-red-500/10 text-red-500 flex items-center justify-center relative shadow-inner">
                            <span className="material-symbols-outlined text-[32px]">error</span>
                        </div>
                        <div>
                            <div className="text-4xl font-extrabold text-white tracking-tighter">{errorCount}</div>
                            <div className="text-[10px] text-slate-500 uppercase tracking-[2px] font-black mt-1">Failures</div>
                        </div>
                    </div>
                </div>

                {/* Active Connections */}
                <div className="space-y-6">
                    <div className="flex items-center justify-between">
                        <h2 className="text-2xl font-extrabold text-white tracking-tight">Active Connections</h2>
                        <div className="bg-[#1a202c] border border-[#2d3748] px-4 py-2 rounded-xl flex items-center gap-3 cursor-pointer hover:bg-[#232936] transition-all shadow-sm group">
                            <span className="material-symbols-outlined text-slate-500 group-hover:text-white text-[20px]">filter_list</span>
                            <span className="text-[11px] text-slate-400 font-bold uppercase tracking-widest">All Types</span>
                            <span className="material-symbols-outlined text-slate-600 text-[18px]">expand_more</span>
                        </div>
                    </div>

                    <div className="bg-[#111318] border border-[#2d3748] rounded-[24px] overflow-hidden shadow-2xl">
                        <div className="grid grid-cols-12 px-8 py-5 border-b border-[#2d3748] text-[10px] font-black text-slate-500 uppercase tracking-[3px] bg-[#1a202c]/30">
                            <div className="col-span-4">Source Name</div>
                            <div className="col-span-3 text-center">Type</div>
                            <div className="col-span-3 text-center">Status</div>
                            <div className="col-span-2 text-right">Last Sync</div>
                        </div>
                        <div className="divide-y divide-[#2d3748]/50">
                            {dataSources.map((ds) => (
                                <div
                                    key={ds.id}
                                    onClick={() => onSelect(ds.id)}
                                    className={`grid grid-cols-12 px-8 py-6 items-center cursor-pointer transition-all group ${selectedId === ds.id ? 'bg-[#135bec]/10 relative shadow-[inset_0_0_30px_rgba(19,91,236,0.05)]' : 'hover:bg-white/5'}`}
                                >
                                    {selectedId === ds.id && <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#135bec] shadow-[0_0_15px_rgba(19,91,236,0.8)]"></div>}
                                    <div className="col-span-4 flex items-center gap-4">
                                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-all shadow-sm ${selectedId === ds.id ? 'bg-[#135bec]/20 text-[#135bec]' : 'bg-[#1a202c] text-slate-500 group-hover:text-white'}`}>
                                            <span className="material-symbols-outlined text-[24px]">{ds.icon}</span>
                                        </div>
                                        <div>
                                            <div className="text-[15px] font-bold text-white tracking-tight">{ds.name}</div>
                                            <div className="text-[11px] text-slate-500 font-mono mt-1 opacity-80">{ds.details}</div>
                                        </div>
                                    </div>
                                    <div className="col-span-3 flex justify-center">
                                        <span className="px-3.5 py-1.5 rounded-lg bg-[#1a202c] border border-[#2d3748] text-[10px] text-slate-300 font-black uppercase tracking-[2px] shadow-inner">
                                            {ds.type}
                                        </span>
                                    </div>
                                    <div className="col-span-3 flex justify-center">
                                        <div className="flex items-center gap-3 px-4 py-2 rounded-full bg-[#1a202c]/50 border border-[#2d3748] shadow-sm">
                                            <div className={`w-2.5 h-2.5 rounded-full ${ds.status === 'Connected' ? 'bg-green-500 glow-success' :
                                                ds.status === 'Auth Error' || ds.status === 'Error' ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.6)]' :
                                                    'bg-slate-500 animate-pulse'
                                                }`} />
                                            <span className={`text-[11px] font-black uppercase tracking-widest ${ds.status === 'Connected' ? 'text-green-500' :
                                                ds.status === 'Auth Error' || ds.status === 'Error' ? 'text-red-500' :
                                                    'text-slate-400'
                                                }`}>{ds.status}</span>
                                        </div>
                                    </div>
                                    <div className="col-span-2 text-right">
                                        <span className="text-xs text-slate-500 font-bold tracking-tight">{ds.lastSync}</span>
                                    </div>
                                </div>
                            ))}
                            {dataSources.length === 0 && (
                                <div className="px-8 py-12 text-center text-slate-500">
                                    <p className="text-sm font-medium">No active connections found. Connect a data source to get started.</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Connected Schema */}
                <div className="space-y-6">
                    <div className="flex items-center justify-between">
                        <div>
                            <h2 className="text-2xl font-extrabold text-white tracking-tight">Connected Schema</h2>
                            <p className="text-xs text-slate-500 mt-1">Selected tables are prioritized for planning and SQL generation.</p>
                        </div>
                        <div className="flex items-center gap-3">
                            <button
                                onClick={saveSelection}
                                disabled={isSchemaSyncing || selectedTables.length === 0}
                                className="px-4 py-2 rounded-lg bg-[#135bec] text-white text-[11px] font-black uppercase tracking-widest shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isSchemaSyncing ? 'Saving...' : 'Save Selection'}
                            </button>
                            <span className={`px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-[2px] border ${connectionStatus === 'Connected'
                                ? 'bg-green-500/10 text-green-400 border-green-500/30'
                                : 'bg-red-500/10 text-red-400 border-red-500/30'
                                }`}>
                                {connectionStatus === 'Connected' ? 'Connected' : 'Not Connected'}
                            </span>
                        </div>
                    </div>
                    <div className="bg-[#0f1218] border border-[#242a36] rounded-[18px] px-4 py-3 flex items-center justify-between">
                        <div className="flex items-center gap-3 text-xs text-slate-400 font-bold uppercase tracking-widest">
                            <span>Selected: {selectedTables.length}</span>
                            <span className="text-slate-600">•</span>
                            <span>Other: {otherTables.length}</span>
                            <span className="text-slate-600">•</span>
                            <span>Total: {discoveredTables.length}</span>
                        </div>
                        <div className="relative w-64">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-600 text-[16px]">search</span>
                            <input
                                value={schemaSearch}
                                onChange={(e) => setSchemaSearch(e.target.value)}
                                placeholder="Search tables..."
                                className="w-full pl-9 pr-3 py-2 text-xs bg-[#0b0f16] border border-[#1b2230] rounded-lg text-slate-300 placeholder-slate-600 focus:outline-none focus:border-[#135bec]/60"
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-12 gap-6">
                        <div className="col-span-12 lg:col-span-5 bg-[#0f1218] border border-[#242a36] rounded-[22px] p-6">
                            <div className="flex items-center justify-between mb-4">
                                <div className="text-[11px] text-slate-500 font-black uppercase tracking-[3px]">Selected Tables</div>
                                <span className="text-[10px] text-slate-400 font-bold">{selectedTables.length} tables</span>
                            </div>
                            {filteredSelected.length > 0 ? (
                                <div className="flex flex-col gap-2">
                                    {filteredSelected.map((table) => (
                                        <div
                                            key={table}
                                            className={`px-3 py-2 rounded-lg border text-sm text-white font-semibold flex items-center justify-between gap-3 transition-all ${activeTable === table
                                                ? 'bg-[#135bec]/15 border-[#135bec]/60'
                                                : 'bg-[#141924] border-[#2a3342]'
                                                }`}
                                        >
                                            <button
                                                onClick={() => selectTable(table)}
                                                className="flex-1 text-left hover:text-white"
                                            >
                                                {table}
                                            </button>
                                            <button
                                                onClick={() => toggleTable(table)}
                                                className="text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-red-400"
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-sm text-slate-500">No tables selected.</div>
                            )}
                        </div>
                        <div className="col-span-12 lg:col-span-7 bg-[#0f1218] border border-[#242a36] rounded-[22px] p-6">
                            <div className="flex items-center justify-between mb-4">
                                <div className="text-[11px] text-slate-500 font-black uppercase tracking-[3px]">Other Tables</div>
                                <span className="text-[10px] text-slate-400 font-bold">{otherTables.length} tables</span>
                            </div>
                            {filteredOther.length > 0 ? (
                                <div className="grid grid-cols-2 gap-2">
                                    {filteredOther.map((table) => (
                                        <button
                                            key={table}
                                            onClick={() => selectTable(table)}
                                            className="px-3 py-2 rounded-lg bg-[#0b0f16] border border-[#1b2230] text-xs text-slate-400 font-semibold text-left hover:border-slate-500 hover:text-slate-200 transition-all"
                                        >
                                            {table}
                                        </button>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-sm text-slate-500">No other tables found.</div>
                            )}
                        </div>
                        <div className="col-span-12 bg-[#0f1218] border border-[#242a36] rounded-[22px] p-6">
                            <div className="flex items-center justify-between mb-4">
                                <div className="text-[11px] text-slate-500 font-black uppercase tracking-[3px]">
                                    Table Preview {activeTable ? `• ${activeTable}` : ''}
                                </div>
                                <span className="text-[10px] text-slate-400 font-bold">Last 5 records</span>
                            </div>
                            {!activeTable && (
                                <div className="text-sm text-slate-500">Select a table to preview records and toggle columns.</div>
                            )}
                            {activeTable && (
                                <div className="grid grid-cols-12 gap-6">
                                    <div className="col-span-12 lg:col-span-4">
                                        <div className="text-[10px] text-slate-500 uppercase tracking-[2px] font-black mb-2">Columns</div>
                                        <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
                                            {(tableSchemas[activeTable]?.columns || []).map((col: any, idx: number) => {
                                                const name = col?.column_name || col?.name;
                                                if (!name) return null;
                                                const toggles = columnToggles[activeTable]?.[name] || { show: true };
                                                return (
                                                    <label key={`${activeTable}-${name}-${idx}`} className="flex items-center justify-between px-3 py-2 rounded-lg bg-[#11141d] border border-[#1f2530] text-xs text-slate-300">
                                                        <span>{name}</span>
                                                        <input
                                                            type="checkbox"
                                                            checked={toggles.show !== false}
                                                            onChange={(e) => updateColumnToggle(activeTable, name, e.target.checked)}
                                                        />
                                                    </label>
                                                );
                                            })}
                                        </div>
                                    </div>
                                    <div className="col-span-12 lg:col-span-8">
                                        <div className="text-[10px] text-slate-500 uppercase tracking-[2px] font-black mb-2">Preview</div>
                                        <div className="bg-[#0b0f16] border border-[#1b2230] rounded-lg overflow-hidden">
                                            <div className="grid grid-cols-12 px-4 py-2 border-b border-[#1b2230] text-[10px] font-black text-slate-500 uppercase tracking-[2px]">
                                                {(tableSchemas[activeTable]?.columns || [])
                                                    .filter((col: any) => {
                                                        const name = col?.column_name || col?.name;
                                                        if (!name) return false;
                                                        return columnToggles[activeTable]?.[name]?.show !== false;
                                                    })
                                                    .slice(0, 6)
                                                    .map((col: any, idx: number) => (
                                                        <div key={`${activeTable}-col-${idx}`} className="col-span-2 truncate">
                                                            {col?.column_name || col?.name}
                                                        </div>
                                                    ))}
                                            </div>
                                            <div className="divide-y divide-[#1b2230]">
                                                {(tablePreviews[activeTable] || []).slice(0, 5).map((row: any, rowIdx: number) => (
                                                    <div key={`${activeTable}-row-${rowIdx}`} className="grid grid-cols-12 px-4 py-2 text-[11px] text-slate-300">
                                                        {(tableSchemas[activeTable]?.columns || [])
                                                            .filter((col: any) => {
                                                                const name = col?.column_name || col?.name;
                                                                if (!name) return false;
                                                                return columnToggles[activeTable]?.[name]?.show !== false;
                                                            })
                                                            .slice(0, 6)
                                                            .map((col: any, idx: number) => {
                                                                const name = col?.column_name || col?.name;
                                                                return (
                                                                    <div key={`${activeTable}-cell-${rowIdx}-${idx}`} className="col-span-2 truncate">
                                                                        {name && row && name in row ? String(row[name]) : '—'}
                                                                    </div>
                                                                );
                                                            })}
                                                    </div>
                                                ))}
                                                {(tablePreviews[activeTable] || []).length === 0 && (
                                                    <div className="px-4 py-4 text-sm text-slate-500">No preview rows available.</div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                            {schemaError && (
                                <div className="mt-4 text-sm text-red-400">{schemaError}</div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Available Integrations Section */}
                <div className="space-y-6 pt-4">
                    <div className="flex items-center justify-between">
                        <h2 className="text-2xl font-extrabold text-white tracking-tight">Available Integrations</h2>
                        <button className="text-[11px] font-black text-[#135bec] uppercase tracking-widest hover:underline underline-offset-8 transition-all">View Marketplace</button>
                    </div>
                    <div className="grid grid-cols-4 gap-6">
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
                                className="bg-[#111318] border border-[#2d3748] rounded-[24px] p-7 flex flex-col items-center text-center gap-4 hover:border-[#135bec]/40 cursor-pointer transition-all group shadow-xl hover:-translate-y-1 active:scale-[0.98]"
                            >
                                <div className="relative">
                                    <div className={`w-16 h-16 rounded-[20px] bg-gradient-to-br from-[#1a202c] to-[#0b0d11] border border-[#2d3748] flex items-center justify-center text-slate-400 group-hover:text-[#135bec] transition-all group-hover:shadow-[0_0_20px_rgba(19,91,236,0.15)] group-hover:border-[#135bec]/20`}>
                                        <span className="material-symbols-outlined text-[36px]">{int.icon}</span>
                                    </div>
                                    <button className="absolute -top-2 -right-2 w-7 h-7 rounded-full bg-[#111318] border border-[#2d3748] text-slate-500 hover:text-white hover:bg-[#135bec] hover:border-[#135bec] transition-all flex items-center justify-center shadow-lg">
                                        <span className="material-symbols-outlined text-[16px] font-bold">add</span>
                                    </button>
                                </div>
                                <div>
                                    <div className="text-sm font-black text-white tracking-tight uppercase">{int.name}</div>
                                    <div className="text-[10px] text-slate-500 font-bold mt-1.5 tracking-widest uppercase opacity-60">{int.description}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <NewMcpAgentModal isOpen={isMcpModalOpen} onClose={() => setIsMcpModalOpen(false)} />
            <PostgresConnectionModal isOpen={isPgModalOpen} onClose={() => setIsPgModalOpen(false)} dbType={dbType} />
        </main>
    );
};

export default DataSourcesView;

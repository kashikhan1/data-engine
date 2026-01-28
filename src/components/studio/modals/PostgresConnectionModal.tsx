import React, { useState, useEffect } from 'react';
import { useConfigStore } from '@/state/stores';
import { dbGateway } from '@/lib/mcp/client';

interface PostgresConnectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    dbType?: 'PostgreSQL' | 'MSSQL';
}

const PostgresConnectionModal: React.FC<PostgresConnectionModalProps> = ({ isOpen, onClose, dbType = 'PostgreSQL' }) => {
    const { postgresUrl, setPostgresUrl, setConnectionStatus, addDataSource } = useConfigStore();
    const [url, setUrl] = useState(postgresUrl);
    const [isConnecting, setIsConnecting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Table selection state
    const [step, setStep] = useState<'connect' | 'tables'>('connect');
    const [tables, setTables] = useState<string[]>([]);
    const [selectedTables, setSelectedTables] = useState<string[]>([]);
    const [isFetchingTables, setIsFetchingTables] = useState(false);
    const [tableSearch, setTableSearch] = useState('');
    const [activeTable, setActiveTable] = useState<string | null>(null);
    const [tableSchemas, setTableSchemas] = useState<Record<string, any>>({});
    const [columnToggles, setColumnToggles] = useState<Record<string, Record<string, { show?: boolean; filterable?: boolean }>>>({});

    const COLUMN_TOGGLES_KEY = 'schema_column_toggles';
    const SELECTED_TABLES_KEY = 'schema_selected_tables';

    useEffect(() => {
        if (isOpen) {
            setStep('connect');
            setError(null);
            setTableSearch('');
            setActiveTable(null);
            try {
                const storedToggles = localStorage.getItem(COLUMN_TOGGLES_KEY);
                if (storedToggles) {
                    setColumnToggles(JSON.parse(storedToggles));
                }
            } catch {
                setColumnToggles({});
            }
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleConnect = async () => {
        setIsConnecting(true);
        setError(null);
        setConnectionStatus("Connecting");

        try {
            const success = await dbGateway.connect(url);
            if (success) {
                setPostgresUrl(url);
                setConnectionStatus("Connected");

                // Fetch tables for next step
                setIsFetchingTables(true);
                setStep('tables');
                const tableList = await dbGateway.listTables(url);
                if (Array.isArray(tableList)) {
                    setTables(tableList);
                } else {
                    setError("Connected but failed to fetch table list.");
                }
            } else {
                setConnectionStatus("Error");
                setError("Failed to connect to Postgres.");
            }
        } catch (err: any) {
            setConnectionStatus("Error");
            setError(err.message || "An unexpected error occurred.");
        } finally {
            setIsConnecting(false);
            setIsFetchingTables(false);
        }
    };

    const handleSaveSelection = async () => {
        setIsConnecting(true);
        try {
            const schemaData: Record<string, any> = {};

            for (const table of selectedTables) {
                const [preview, tableSchema] = await Promise.all([
                    dbGateway.getTablePreview(table, url),
                    tableSchemas[table] ? Promise.resolve(tableSchemas[table]) : dbGateway.getTableSchema(table, url)
                ]);

                const toggles = columnToggles[table] || {};
                const columns = Array.isArray(tableSchema?.columns) ? tableSchema.columns : [];
                const allowedColumns = columns.filter((col: any) => {
                    const name = col?.column_name || col?.name;
                    if (!name) return false;
                    return toggles[name]?.show !== false;
                });
                const sampleRows = Array.isArray(preview) ? preview : [];
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

            // Save to localStorage
            localStorage.setItem('selected_schema', JSON.stringify(schemaData));
            localStorage.setItem(SELECTED_TABLES_KEY, JSON.stringify(selectedTables));
            localStorage.setItem(COLUMN_TOGGLES_KEY, JSON.stringify(columnToggles));

            addDataSource({
                id: 'ds_postgres',
                name: `${dbType} Database`,
                type: dbType,
                details: `${selectedTables.length} tables selected`,
                status: 'Connected',
                lastSync: new Date().toLocaleTimeString(),
                icon: 'database',
                connectionString: url
            });

            onClose();
        } catch (err: any) {
            setError("Failed to save table metadata: " + err.message);
        } finally {
            setIsConnecting(false);
        }
    };

    const toggleTable = (table: string) => {
        setSelectedTables(prev =>
            prev.includes(table) ? prev.filter(t => t !== table) : [...prev, table]
        );
        if (!tableSchemas[table]) {
            dbGateway.getTableSchema(table).then((schema) => {
                setTableSchemas((prev) => ({ ...prev, [table]: schema }));
                if (!columnToggles[table]) {
                    const columns = Array.isArray(schema?.columns) ? schema.columns : [];
                    const nextMap: Record<string, { show?: boolean; filterable?: boolean }> = {};
                    columns.forEach((col: any) => {
                        const name = col?.column_name || col?.name;
                        if (!name) return;
                        nextMap[name] = { show: true, filterable: true };
                    });
                    setColumnToggles((prev) => ({ ...prev, [table]: nextMap }));
                }
            }).catch(() => {
                setError(`Failed to load schema for ${table}`);
            });
        }
        if (!selectedTables.includes(table)) {
            setActiveTable(table);
        } else if (activeTable === table) {
            setActiveTable(null);
        }
    };

    const updateColumnToggle = (table: string, column: string, key: 'show' | 'filterable', value: boolean) => {
        setColumnToggles((prev) => ({
            ...prev,
            [table]: {
                ...(prev[table] || {}),
                [column]: {
                    ...(prev[table]?.[column] || {}),
                    [key]: value,
                    ...(key === 'show' && value === false ? { filterable: false } : {})
                }
            }
        }));
    };

    const showAllColumns = (table: string) => {
        const columns = Array.isArray(tableSchemas[table]?.columns) ? tableSchemas[table].columns : [];
        const nextMap: Record<string, { show?: boolean; filterable?: boolean }> = {};
        columns.forEach((col: any) => {
            const name = col?.column_name || col?.name;
            if (!name) return;
            nextMap[name] = { show: true, filterable: true };
        });
        setColumnToggles((prev) => ({ ...prev, [table]: nextMap }));
    };

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-lg bg-[#111318] border border-[#2d3748] rounded-2xl shadow-2xl overflow-hidden animate-slide-in-top">
                <div className="px-6 py-5 border-b border-[#2d3748] flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-bold text-white tracking-tight">
                            {step === 'connect' ? `Connect ${dbType} Source` : 'Select Target Tables'}
                        </h2>
                        <p className="text-xs text-slate-500 mt-1">
                            {step === 'connect'
                                ? 'Direct database connection for real-time profiling.'
                                : 'Choose the tables you want to use for dashboard generation.'}
                        </p>
                    </div>
                </div>

                <div className="p-6 space-y-6 max-h-[60vh] overflow-y-auto">
                    {step === 'connect' ? (
                        <div className="space-y-2">
                            <label className="text-xs font-bold text-slate-300 tracking-wide uppercase">Connection URL</label>
                            <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 material-symbols-outlined text-slate-500 text-[20px]">link</span>
                                <input
                                    type="text"
                                    value={url}
                                    onChange={(e) => setUrl(e.target.value)}
                                    placeholder={dbType === 'MSSQL'
                                        ? 'sqlserver://user:pass@localhost:1433/db'
                                        : 'postgresql://user:pass@localhost:5432/db'}
                                    className="w-full bg-[#1a202c] border border-[#2d3748] rounded-lg pl-10 pr-4 py-3 text-sm text-slate-200 focus:border-[#135bec] focus:ring-1 focus:ring-[#135bec]/20 outline-none font-mono"
                                />
                            </div>
                            <p className="text-[10px] text-slate-500 font-medium">
                                {dbType === 'MSSQL'
                                    ? 'Format: sqlserver://[user]:[password]@[host]:[port]/[database]'
                                    : 'Format: postgresql://[user]:[password]@[host]:[port]/[database]'}
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            <div>
                                <label className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Search Tables</label>
                                <input
                                    type="text"
                                    value={tableSearch}
                                    onChange={(e) => setTableSearch(e.target.value)}
                                    placeholder="Search tables..."
                                    className="mt-2 w-full bg-[#1a202c] border border-[#2d3748] rounded-lg px-3 py-2 text-xs text-slate-200 focus:border-[#135bec] focus:ring-1 focus:ring-[#135bec]/20 outline-none"
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                            {isFetchingTables ? (
                                <div className="col-span-2 py-10 flex flex-col items-center justify-center gap-3">
                                    <div className="w-8 h-8 border-2 border-[#135bec]/30 border-t-[#135bec] rounded-full animate-spin" />
                                    <p className="text-sm text-slate-400">Fetching tables...</p>
                                </div>
                            ) : tables.length > 0 ? (
                                tables
                                    .filter((table) => table.toLowerCase().includes(tableSearch.toLowerCase()))
                                    .map(table => (
                                    <button
                                        key={table}
                                        onClick={() => toggleTable(table)}
                                        className={`flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${selectedTables.includes(table)
                                            ? 'bg-[#135bec]/10 border-[#135bec] text-white'
                                            : 'bg-[#1a202c] border-[#2d3748] text-slate-400 hover:border-slate-500'
                                            }`}
                                    >
                                        <span className={`material-symbols-outlined text-[20px] ${selectedTables.includes(table) ? 'text-[#135bec]' : 'text-slate-600'
                                            }`}>
                                            {selectedTables.includes(table) ? 'check_box' : 'check_box_outline_blank'}
                                        </span>
                                        <span className="text-xs font-semibold truncate">{table}</span>
                                    </button>
                                ))
                            ) : (
                                <p className="col-span-2 text-center py-5 text-slate-500 text-sm">No tables found in public schema.</p>
                            )}
                            </div>

                            {activeTable && tableSchemas[activeTable]?.columns && (
                                <div className="border border-[#2d3748] rounded-xl p-3 bg-[#121621]">
                                    <div className="flex items-center justify-between mb-3">
                                        <div className="text-xs font-bold text-slate-200">Column Controls: {activeTable}</div>
                                        <button
                                            onClick={() => showAllColumns(activeTable)}
                                            className="text-[10px] font-bold text-slate-400 hover:text-white uppercase tracking-widest"
                                        >
                                            Show all
                                        </button>
                                    </div>
                                    <div className="flex flex-col gap-2 max-h-48 overflow-y-auto pr-1">
                                        {tableSchemas[activeTable].columns.map((col: any, idx: number) => {
                                            const name = col?.column_name || col?.name;
                                            if (!name) return null;
                                            const toggles = columnToggles[activeTable]?.[name] || { show: true, filterable: true };
                                            return (
                                                <div key={`${activeTable}-${name}-${idx}`} className="flex items-center gap-3 bg-black/20 border border-[#2d3748] rounded-lg px-2 py-2">
                                                    <div className="flex-1">
                                                        <div className="text-xs text-slate-200">{name}</div>
                                                        <div className="text-[10px] text-slate-500">{col.data_type || col.type}</div>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[10px] text-slate-500 uppercase tracking-widest">Show</span>
                                                        <input
                                                            type="checkbox"
                                                            checked={toggles.show}
                                                            onChange={(e) => updateColumnToggle(activeTable, name, 'show', e.target.checked)}
                                                        />
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[10px] text-slate-500 uppercase tracking-widest">Filter</span>
                                                        <input
                                                            type="checkbox"
                                                            checked={toggles.filterable}
                                                            disabled={!toggles.show}
                                                            onChange={(e) => updateColumnToggle(activeTable, name, 'filterable', e.target.checked)}
                                                        />
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {error && (
                        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center gap-3 text-red-500">
                            <span className="material-symbols-outlined text-[18px]">error</span>
                            <span className="text-xs font-medium">{error}</span>
                        </div>
                    )}
                </div>

                <div className="px-6 py-5 border-t border-[#2d3748] bg-[#111318] flex items-center justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-slate-400 hover:text-white transition-colors">
                        Cancel
                    </button>
                    {step === 'connect' ? (
                        <button
                            onClick={handleConnect}
                            disabled={isConnecting || !url}
                            className="flex items-center gap-2 px-6 py-2 bg-[#135bec] text-white rounded-lg text-sm font-bold hover:bg-blue-600 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isConnecting ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    Connecting...
                                </>
                            ) : (
                                <>
                                    <span className="material-symbols-outlined text-[18px]">power</span>
                                    Connect & Pick Tables
                                </>
                            )}
                        </button>
                    ) : (
                        <button
                            onClick={handleSaveSelection}
                            disabled={isConnecting || selectedTables.length === 0}
                            className="flex items-center gap-2 px-6 py-2 bg-[#135bec] text-white rounded-lg text-sm font-bold hover:bg-blue-600 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {isConnecting ? (
                                <>
                                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                    Initializing...
                                </>
                            ) : (
                                <>
                                    <span className="material-symbols-outlined text-[18px]">rocket_launch</span>
                                    Finalize Discovery
                                </>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

export default PostgresConnectionModal;

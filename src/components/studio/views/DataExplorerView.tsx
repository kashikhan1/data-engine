'use client';
import React, { useState, useEffect } from 'react';

import { dbGateway } from '@/lib/mcp/client';
import { useConfigStore, useRunStore, useUIStore } from '@/state/stores';
import { useCreateRun } from '@/hooks/useRunStream';
import { AgentTimeline } from '@/components/chat/AgentTimeline';
import { runSchemaDiscovery } from '@/modules/schema/agent';

const DataExplorerView: React.FC = () => {
    const { setDiscoveredTables, connectionStatus, discoveredTables, postgresUrl, canonicalPlan, setCanonicalPlan, projectContext, disabledWidgetTypes } = useConfigStore();
    const [tables, setTables] = useState<string[]>(discoveredTables || []);
    const [selectedTable, setSelectedTable] = useState<string | null>(null);
    const [records, setRecords] = useState<any[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedTableSchema, setSelectedTableSchema] = useState<any | null>(null);

    // Deep Intelligence State
    const [isProfiling, setIsProfiling] = useState(false);
    const [actionablePlan, setActionablePlan] = useState<string | null>(null);
    const [stats, setStats] = useState<{ tables: number, relations: number } | null>(null);
    const [profiledData, setProfiledData] = useState<{
        schemaInfo: Record<string, any>,
        sampleData: Record<string, any[]>,
        relationships: any[]
    } | null>(null);
    const [structuredPlan, setStructuredPlan] = useState<any | null>(null);
    const [isEditingPlan, setIsEditingPlan] = useState(false);
    const [editedPlan, setEditedPlan] = useState<string>('');
    const [validationErrors, setValidationErrors] = useState<string[]>([]);
    const { setCurrentView } = useUIStore();
    const { createRun } = useCreateRun();
    const { steps } = useRunStore();

    // Listen to run store for schema updates during profiling
    useEffect(() => {
        const lastStep = steps[steps.length - 1];
        if (lastStep?.step === 'plan' && lastStep.status === 'done') {
            // We can't easily get the schemaInfo from the store as it's not mirrored there yet
            // but the EventSource in handleDeepProfile still works for that.
            // Actually, let's just use useRunStore's side effect for the UI.
        }
    }, [steps]);

    useEffect(() => {
        if (canonicalPlan && !actionablePlan && !selectedTable && !isProfiling) {
            setActionablePlan(canonicalPlan);
        }
    }, [canonicalPlan, actionablePlan, selectedTable, isProfiling]);

    useEffect(() => {
        const fetchTables = async () => {
            setLoading(true);
            try {
                // First, check if we need to connect
                if (connectionStatus !== "Connected") {
                    const config = await dbGateway.getEnvConfig();
                    const envUrl = config.postgresUrl || config.mssqlUrl;
                    if (envUrl) {
                        console.log("[Explorer] Attempting auto-connect to DB URL from env");
                        const connected = await dbGateway.connect(envUrl);
                        if (connected) {
                            // We don't have access to the setConnectionStatus here directly 
                            // but we can proceed with fetching since the server-side pool is initialized
                        }
                    }
                }

                const schema: any = await dbGateway.getSchema(postgresUrl);
                if (schema && schema.error) {
                    setError(schema.error);
                } else if (schema) {
                    const tableNames = Object.keys(schema);
                    console.log(`[Explorer] Discovered ${tableNames.length} tables`);
                    setTables(tableNames);
                    setDiscoveredTables(tableNames);
                }
            } catch (err: any) {
                setError(err.message);
            } finally {
                setLoading(false);
            }
        };
        fetchTables();
    }, [setDiscoveredTables, connectionStatus]);

    const handleManualSync = async () => {
        setIsProfiling(true);
        setError(null);
        try {
            console.log("[Explorer] Manual sync via runSchemaDiscovery agent...");
            const storedTablesRaw = localStorage.getItem('schema_selected_tables');
            const allowedTables = storedTablesRaw ? JSON.parse(storedTablesRaw) : [];
            const data = await runSchemaDiscovery(undefined, { projectContext }, allowedTables);

            if (data) {
                setTables(data.tables);
                setDiscoveredTables(data.tables);
                setProfiledData({
                    schemaInfo: data.schemaInfo,
                    sampleData: data.sampleData,
                    relationships: data.relationships
                });
                setStats({
                    tables: data.tables.length,
                    relations: data.relationships?.length || 0
                });
                if (data.rawAnalysis) {
                    // Set it as a default plan if none exists
                    if (!actionablePlan) {
                        setActionablePlan(data.rawAnalysis);
                        setEditedPlan(data.rawAnalysis);
                    }
                }
            }
        } catch (err: any) {
            setError(err.message);
        } finally {
            setIsProfiling(false);
        }
    };

    const handleDeepProfile = async (focusTable?: string | null) => {
        setIsProfiling(true);
        setError(null);
        setActionablePlan(null);
        try {
            const query = focusTable
                ? `Analyze the '${focusTable}' table, its structure, and its relations to generate a specialized domain plan.`
                : "Analyze every table in the database and generate a master architecture plan.";

            const runId = await createRun({
                originalQuery: query,
                context: {
                    mode: 'exhaustive_profiling',
                    focusTable: focusTable,
                    projectContext,
                    postgresUrl,
                    disabledWidgetTypes
                }
            });

            // We still need a local event source just for the 'schema_update' event 
            // since the global run store doesn't handle that event type specifically yet
            const eventSource = new EventSource(`/api/runs/${runId}/stream`);
            eventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);

                if (data.type === 'schema_update') {
                    setProfiledData({
                        schemaInfo: data.schemaInfo,
                        sampleData: data.sampleData,
                        relationships: data.schemaRelationships
                    });
                    setStats({
                        tables: Object.keys(data.schemaInfo).length,
                        relations: data.schemaRelationships?.length || 0
                    });
                }

                if (data.type === 'partial_dashboard' && data.dashboard?.actionablePlan) {
                    setActionablePlan(data.dashboard.actionablePlan);
                    setEditedPlan(data.dashboard.actionablePlan);
                }

                if (data.type === 'final') {
                    eventSource.close();
                    setIsProfiling(false);
                    if (data.envelope?.dashboard) {
                        const dashboards = data.envelope.dashboard;

                        // We want the structured plan preferentially
                        const derivedPlan = {
                            title: dashboards.name || (focusTable ? `${focusTable} Domain Plan` : "Database Master Plan"),
                            widgets: dashboards.widgets || [],
                            entities: Object.keys(data.schemaInfo || {}),
                            lastUpdated: new Date().toISOString()
                        };

                        const planStr = JSON.stringify(derivedPlan, null, 2);
                        setActionablePlan(planStr);
                        setEditedPlan(planStr);
                        setStructuredPlan(derivedPlan);
                        setCanonicalPlan(planStr);
                    }
                }
                if (data.type === 'error') {
                    setError(data.message);
                    setIsProfiling(false);
                    eventSource.close();
                }
            };
        } catch (err: any) {
            setError(err.message);
            setIsProfiling(false);
        }
    };

    const handleTableClick = async (tableName: string) => {
        setActionablePlan(null);
        setSelectedTable(tableName);
        setLoading(true);
        setError(null);
        try {
            const data: any = await dbGateway.getTablePreview(tableName);
            if (data && data.error) {
                setError(data.error);
                setRecords([]);
            } else {
                setRecords(Array.isArray(data) ? data : []);
            }

            // Fetch Schema & Relations for the selected table
            const schemaData = await dbGateway.getTableSchema(tableName);
            setSelectedTableSchema(schemaData);

            // Fetch related table info for deep context if missing
            if (schemaData.foreignKeys) {
                for (const fk of schemaData.foreignKeys) {
                    const targetTable = fk.foreign_table_name;
                    if (!profiledData?.schemaInfo[targetTable]) {
                        // Fetch on the fly
                        const tSchema = await dbGateway.getTableSchema(targetTable);
                        const tRecords = await dbGateway.getTablePreview(targetTable);

                        setProfiledData(prev => {
                            const base = prev || { schemaInfo: {}, sampleData: {}, relationships: [] };
                            return {
                                ...base,
                                schemaInfo: { ...base.schemaInfo, [targetTable]: tSchema },
                                sampleData: { ...base.sampleData, [targetTable]: tRecords }
                            };
                        });
                    }
                }
            }
        } catch (err: any) {
            setError(err.message);
            setRecords([]);
        } finally {
            setLoading(false);
        }
    };

    const validatePlan = (plan: any) => {
        const errors: string[] = [];
        if (!profiledData) return [];

        try {
            const parsed = typeof plan === 'string' ? JSON.parse(plan) : plan;
            if (parsed.widgets) {
                parsed.widgets.forEach((w: any) => {
                    if (w.entities) {
                        w.entities.forEach((e: string) => {
                            if (!profiledData.schemaInfo[e]) {
                                errors.push(`Widget "${w.title}" references unknown table: ${e}`);
                            }
                        });
                    }
                });
            }
        } catch (e) {
            errors.push("Invalid JSON format");
        }
        return errors;
    };

    const handleSavePlan = () => {
        const errors = validatePlan(editedPlan);
        if (errors.length > 0) {
            setValidationErrors(errors);
            return;
        }

        setValidationErrors([]);
        setCanonicalPlan(editedPlan);
        setActionablePlan(editedPlan);
        setIsEditingPlan(false);

        try {
            const parsed = JSON.parse(editedPlan);
            setStructuredPlan(parsed);
        } catch (e) { }
    };

    const handleBuildFromPlan = async () => {
        if (!actionablePlan) return;

        // Ensure plan is saved first
        setCanonicalPlan(actionablePlan);

        // Switch to build view
        setCurrentView('build');

        // Trigger a full dashboard generation run based on this plan
        try {
            await createRun({
                originalQuery: "Build a complete dashboard based on the optimized Master Blueprint provided in the context.",
                context: {
                    mode: 'build_from_plan',
                    canonicalPlan: actionablePlan,
                    projectContext,
                    postgresUrl,
                    disabledWidgetTypes
                }
            });
        } catch (err: any) {
            console.error("Failed to trigger build from plan:", err);
        }
    };

    return (
        <div className="flex h-full bg-[#0b0d11] text-white overflow-hidden">
            {/* Sidebar: Table List */}
            <div className="w-72 border-r border-[#2d3748] flex flex-col bg-[#0f1115]">
                <div className="p-6 border-b border-[#2d3748] space-y-4">
                    <h2 className="text-[10px] font-black uppercase tracking-[2px] text-[#135bec]">Database Explorer</h2>

                    <div className="space-y-2">
                        <button
                            onClick={() => handleDeepProfile()}
                            disabled={isProfiling}
                            className={`w-full py-3 px-4 rounded-xl text-[11px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all shadow-lg ${isProfiling
                                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                                : 'bg-gradient-to-r from-[#135bec] to-[#0a369d] text-white hover:scale-[1.02] active:scale-95'
                                }`}
                        >
                            <span className="material-symbols-outlined text-[18px]">instinct</span>
                            {isProfiling ? 'Generating...' : 'Generate AI Plan'}
                        </button>

                        <button
                            onClick={handleManualSync}
                            disabled={isProfiling}
                            className={`w-full py-3 px-4 rounded-xl text-[11px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all border ${isProfiling
                                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                                : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10 hover:text-white'
                                }`}
                        >
                            <span className="material-symbols-outlined text-[18px]">sync</span>
                            {isProfiling ? 'Syncing...' : 'Sync DB Schema'}
                        </button>

                        {(canonicalPlan || actionablePlan) && (
                            <button
                                onClick={() => {
                                    setSelectedTable(null);
                                    setActionablePlan(canonicalPlan || actionablePlan);
                                }}
                                className={`w-full py-3 px-4 rounded-xl text-[11px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 transition-all border ${!selectedTable
                                    ? 'bg-[#135bec]/10 border-[#135bec] text-[#135bec]'
                                    : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10 hover:text-white'
                                    }`}
                            >
                                <span className="material-symbols-outlined text-[18px]">architecture</span>
                                Database Overview
                            </button>
                        )}
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-1 custom-scrollbar">
                    <div className="flex items-center justify-between mb-4 px-2">
                        <span className="text-[10px] uppercase font-bold text-slate-500 tracking-widest">Tables ({tables.length})</span>
                    </div>
                    {loading && !tables.length && (
                        <div className="p-4 text-xs text-slate-500 animate-pulse">Loading tables...</div>
                    )}
                    {tables.map(table => (
                        <button
                            key={table}
                            onClick={() => handleTableClick(table)}
                            className={`w-full text-left px-4 py-3 rounded-xl text-xs font-semibold transition-all group ${selectedTable === table
                                ? 'bg-[#135bec]/20 text-[#135bec] border border-[#135bec]/30 shadow-lg'
                                : 'text-slate-400 hover:bg-white/5 hover:text-white'
                                }`}
                        >
                            <div className="flex items-center gap-3">
                                <span className={`material-symbols-outlined text-[18px] transition-colors ${selectedTable === table ? 'text-[#135bec]' : 'text-slate-600 group-hover:text-slate-400'}`}>table_chart</span>
                                <span className="truncate">{table}</span>
                            </div>
                        </button>
                    ))}
                    {!loading && !tables.length && !error && (
                        <div className="p-8 text-center">
                            <span className="material-symbols-outlined text-4xl text-slate-700 opacity-20">database_off</span>
                            <p className="mt-2 text-[10px] text-slate-600 uppercase font-black tracking-widest">No tables found</p>
                        </div>
                    )}
                </div>
            </div>

            {/* Main Content: Table Data or Plan */}
            <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
                {isProfiling && (
                    <div className="absolute inset-0 bg-[#0b0d11]/80 backdrop-blur-md z-[100] flex flex-col items-center justify-center text-center p-12 overflow-y-auto">
                        <div className="max-w-xl w-full space-y-8 animate-in fade-in zoom-in-95 duration-500">
                            <div className="flex flex-col items-center space-y-6">
                                <div className="w-24 h-24 relative">
                                    <div className="absolute inset-0 border-4 border-[#135bec]/10 rounded-full"></div>
                                    <div className="absolute inset-0 border-4 border-t-[#135bec] rounded-full animate-spin"></div>
                                    <div className="absolute inset-4 bg-[#135bec]/20 rounded-full animate-pulse flex items-center justify-center">
                                        <span className="material-symbols-outlined text-[#135bec] text-3xl">psychology</span>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <h3 className="text-xl font-black uppercase tracking-[4px]">AI Deep Profiling</h3>
                                    <p className="text-slate-400 text-sm max-w-sm mx-auto leading-relaxed">
                                        Retrieving exhaustive schemas, profiling relationships, and synthesizing a canonical master plan...
                                    </p>
                                </div>
                            </div>

                            {/* Timeline of agents running */}
                            <div className="bg-[#111318] border border-[#2d3748] rounded-[32px] p-8 text-left shadow-2xl">
                                <h4 className="text-[10px] font-black text-slate-500 uppercase tracking-[2px] mb-6 flex items-center gap-2">
                                    <span className="material-symbols-outlined text-[16px]">account_tree</span>
                                    Live Agent Pipeline
                                </h4>
                                <AgentTimeline steps={steps} isStreaming={true} />
                            </div>
                        </div>
                    </div>
                )}

                {actionablePlan ? (
                    <div className="h-full flex flex-col overflow-hidden bg-[#0c0e12]">
                        <div className="p-8 border-b border-[#2d3748] bg-gradient-to-r from-[#11141d] to-[#0c0e12]">
                            <div className="flex items-center gap-4 mb-4">
                                <div className="w-12 h-12 rounded-2xl bg-[#135bec]/20 border border-[#135bec]/30 flex items-center justify-center">
                                    <span className="material-symbols-outlined text-[#135bec] text-2xl">verified</span>
                                </div>
                                <div>
                                    <h2 className="text-2xl font-black tracking-tight text-white uppercase">Canonical Data Plan</h2>
                                    <p className="text-xs text-slate-500 font-bold uppercase tracking-widest mt-1">AI-Synthesized Master Architecture</p>
                                </div>
                            </div>

                            <div className="flex gap-6 mt-6">
                                <div className="bg-[#1a202c] px-4 py-2 rounded-xl border border-[#2d3748] flex items-center gap-3">
                                    <span className="text-[10px] font-black text-slate-500 uppercase">Context Coverage</span>
                                    <span className="text-sm font-bold text-[#135bec]">100% EXHAUSTIVE</span>
                                </div>
                                <div className="bg-[#1a202c] px-4 py-2 rounded-xl border border-[#2d3748] flex items-center gap-3">
                                    <span className="text-[10px] font-black text-slate-500 uppercase">Relations Identified</span>
                                    <span className="text-sm font-bold text-white">{stats?.relations || 'Detecting...'}</span>
                                </div>
                                <div className="bg-[#1a202c] px-4 py-2 rounded-xl border border-[#2d3748] flex items-center gap-3">
                                    <span className="text-[10px] font-black text-slate-500 uppercase">Profiled Tables</span>
                                    <span className="text-sm font-bold text-white">{stats?.tables || 'Detecting...'}</span>
                                </div>
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-12 custom-scrollbar">
                            <div className="max-w-6xl mx-auto space-y-16">
                                {/* The Actionable Plan Section */}
                                <div className="prose prose-invert prose-slate max-w-none">
                                    <div className="bg-[#111318] p-10 rounded-[40px] border border-[#2d3748] shadow-2xl relative overflow-hidden group">
                                        <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:opacity-10 transition-opacity">
                                            <span className="material-symbols-outlined text-9xl">architecture</span>
                                        </div>

                                        <div className="flex justify-between items-center mb-6 relative z-10">
                                            <h4 className="text-sm font-black uppercase text-[#135bec] tracking-[3px]">Master Blueprint</h4>
                                            {!isEditingPlan ? (
                                                <button
                                                    onClick={() => setIsEditingPlan(true)}
                                                    className="px-4 py-2 rounded-xl bg-[#135bec]/10 text-[#135bec] text-[10px] font-black uppercase tracking-widest border border-[#135bec]/20 hover:bg-[#135bec]/20 transition-all flex items-center gap-2"
                                                >
                                                    <span className="material-symbols-outlined text-[16px]">edit_note</span>
                                                    Refine Plan
                                                </button>
                                            ) : (
                                                <div className="flex gap-2">
                                                    <button
                                                        onClick={() => {
                                                            setIsEditingPlan(false);
                                                            setEditedPlan(actionablePlan || '');
                                                        }}
                                                        className="px-4 py-2 rounded-xl bg-slate-800 text-slate-400 text-[10px] font-black uppercase tracking-widest hover:bg-slate-700 transition-all"
                                                    >
                                                        Cancel
                                                    </button>
                                                    <button
                                                        onClick={() => {
                                                            setIsEditingPlan(false);
                                                            setActionablePlan(editedPlan);
                                                            setCanonicalPlan(editedPlan);
                                                        }}
                                                        className="px-4 py-2 rounded-xl bg-white text-black text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-all flex items-center gap-2"
                                                    >
                                                        <span className="material-symbols-outlined text-[16px]">save</span>
                                                        Apply Blueprint
                                                    </button>
                                                </div>
                                            )}
                                        </div>

                                        <div className="relative z-10">
                                            {isEditingPlan ? (
                                                <div className="space-y-4">
                                                    <textarea
                                                        value={editedPlan}
                                                        onChange={(e) => {
                                                            setEditedPlan(e.target.value);
                                                            if (validationErrors.length > 0) setValidationErrors([]);
                                                        }}
                                                        className="w-full h-[500px] bg-black/40 text-slate-200 p-6 rounded-2xl border border-[#135bec]/30 focus:border-[#135bec] outline-none font-mono text-sm leading-relaxed resize-none custom-scrollbar"
                                                    />

                                                    {validationErrors.length > 0 && (
                                                        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl space-y-2">
                                                            <p className="text-[10px] font-black text-red-400 uppercase tracking-widest flex items-center gap-2">
                                                                <span className="material-symbols-outlined text-[14px]">report</span>
                                                                Validation Failures
                                                            </p>
                                                            {validationErrors.map((err, i) => (
                                                                <p key={i} className="text-xs text-red-500/80 font-medium">• {err}</p>
                                                            ))}
                                                        </div>
                                                    )}

                                                    <div className="flex gap-4">
                                                        <button
                                                            onClick={handleSavePlan}
                                                            className="flex-1 py-4 rounded-2xl bg-white text-black text-[10px] font-black uppercase tracking-widest hover:bg-slate-200 transition-all"
                                                        >
                                                            Save Master Plan
                                                        </button>
                                                        <button
                                                            onClick={() => setIsEditingPlan(false)}
                                                            className="px-8 py-4 rounded-2xl bg-white/5 border border-white/10 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-white transition-all"
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="space-y-8">
                                                    <div className="bg-black/40 rounded-[32px] border border-white/5 p-8 relative group">
                                                        <div className="absolute top-6 right-6 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                            <button
                                                                onClick={() => {
                                                                    setEditedPlan(actionablePlan || '');
                                                                    setIsEditingPlan(true);
                                                                }}
                                                                className="p-2 rounded-lg bg-white/5 border border-white/10 text-slate-400 hover:text-white"
                                                            >
                                                                <span className="material-symbols-outlined text-[18px]">edit</span>
                                                            </button>
                                                        </div>
                                                        <pre className="whitespace-pre-wrap leading-relaxed text-slate-300 font-mono text-sm">
                                                            {actionablePlan}
                                                        </pre>
                                                    </div>

                                                    <div className="pt-8 border-t border-white/5">
                                                        <button
                                                            onClick={handleBuildFromPlan}
                                                            className="w-full py-6 rounded-[32px] bg-gradient-to-r from-[#135bec] to-[#6366f1] text-white text-[11px] font-black uppercase tracking-[3px] shadow-[0_20px_40px_-10px_rgba(19,91,236,0.3)] hover:scale-[1.01] active:scale-[0.98] transition-all flex items-center justify-center gap-4 group"
                                                        >
                                                            <span className="material-symbols-outlined text-2xl group-hover:rotate-12 transition-transform">rocket_launch</span>
                                                            Build Dashboard from Blueprint
                                                        </button>
                                                        <p className="text-center text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-4 opacity-60">
                                                            This will trigger the full 12-agent pipeline using your refined architecture.
                                                        </p>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>

                                {/* Exhaustive Knowledge Base Section */}
                                <div className="space-y-8">
                                    <div className="flex items-center gap-4 border-l-4 border-[#135bec] pl-6">
                                        <div>
                                            <h3 className="text-2xl font-black uppercase tracking-tight">Database Knowledge Base</h3>
                                            <p className="text-slate-500 text-xs font-bold uppercase tracking-widest mt-1">Detailed profiling of every identified entity</p>
                                        </div>
                                    </div>

                                    <div className="space-y-12">
                                        {profiledData && Object.entries(profiledData.schemaInfo).map(([tableName, schema]: [string, any]) => {
                                            const tableRecords = profiledData.sampleData[tableName] || [];
                                            const tableRelations = profiledData.relationships.filter((r: any) => r.fromTable === tableName || r.toTable === tableName);

                                            return (
                                                <div key={tableName} className="bg-[#111318] border border-[#2d3748] rounded-[48px] overflow-hidden shadow-2xl">
                                                    {/* Table Header */}
                                                    <div className="p-8 border-b border-[#2d3748] bg-white/[0.02] flex items-center justify-between">
                                                        <div className="flex items-center gap-4">
                                                            <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center">
                                                                <span className="material-symbols-outlined text-slate-400">table_chart</span>
                                                            </div>
                                                            <h4 className="text-2xl font-black text-white">{tableName}</h4>
                                                        </div>
                                                        <span className="px-3 py-1 rounded-full bg-[#135bec]/10 text-[#135bec] text-[10px] font-black uppercase tracking-widest border border-[#135bec]/20">Active Schema</span>
                                                    </div>

                                                    <div className="p-8 grid grid-cols-1 xl:grid-cols-2 gap-12">
                                                        {/* Left: Schema & Relations */}
                                                        <div className="space-y-8">
                                                            <div>
                                                                <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-[2px] mb-4 flex items-center gap-2">
                                                                    <span className="material-symbols-outlined text-[16px]">data_array</span>
                                                                    Schema Definitions
                                                                </h5>
                                                                <div className="bg-black/20 rounded-3xl border border-[#2d3748]/50 overflow-hidden">
                                                                    <table className="w-full text-[11px] text-left">
                                                                        <thead className="bg-white/5 text-slate-500 font-black uppercase">
                                                                            <tr>
                                                                                <th className="px-5 py-3">Column</th>
                                                                                <th className="px-5 py-3">Type</th>
                                                                                <th className="px-5 py-3">Constraint</th>
                                                                            </tr>
                                                                        </thead>
                                                                        <tbody className="divide-y divide-white/5">
                                                                            {(schema.columns as any[])?.map((col: any) => (
                                                                                <tr key={col.column_name}>
                                                                                    <td className="px-5 py-3 text-white font-bold">{col.column_name}</td>
                                                                                    <td className="px-5 py-3 text-slate-400 font-mono">{col.data_type}</td>
                                                                                    <td className="px-5 py-3">
                                                                                        {col.is_nullable === 'NO' && <span className="text-amber-500 text-[9px] font-black bg-amber-500/10 px-1.5 py-0.5 rounded">REQUIRED</span>}
                                                                                    </td>
                                                                                </tr>
                                                                            ))}
                                                                        </tbody>
                                                                    </table>
                                                                </div>
                                                            </div>

                                                            {tableRelations.length > 0 && (
                                                                <div>
                                                                    <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-[2px] mb-4 flex items-center gap-2">
                                                                        <span className="material-symbols-outlined text-[16px]">hub</span>
                                                                        Relationships
                                                                    </h5>
                                                                    <div className="space-y-3">
                                                                        {tableRelations.map((rel: any, ridx: number) => (
                                                                            <div key={ridx} className="bg-blue-500/5 border border-blue-500/10 rounded-2xl p-4 flex items-center gap-4">
                                                                                <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                                                                                    <span className="material-symbols-outlined text-blue-500 text-[18px]">link</span>
                                                                                </div>
                                                                                <div className="flex-1 overflow-hidden">
                                                                                    <div className="flex items-center justify-between mb-2">
                                                                                        <div>
                                                                                            <p className="text-xs font-bold text-white">
                                                                                                {rel.fromTable} <span className="text-blue-400">→</span> {rel.toTable}
                                                                                            </p>
                                                                                            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-black">
                                                                                                {rel.type === 'many-to-many' ? 'Many-to-Many via ' : 'via '} {rel.via}
                                                                                            </p>
                                                                                        </div>
                                                                                        <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest shrink-0 ${rel.type === 'many-to-many' ? 'bg-purple-500/10 text-purple-400' : 'bg-blue-500/10 text-blue-400'}`}>
                                                                                            {rel.type}
                                                                                        </span>
                                                                                    </div>

                                                                                    {/* Deep Context for related table */}
                                                                                    {(() => {
                                                                                        const targetTableName = rel.toTable === tableName ? rel.fromTable : rel.toTable;
                                                                                        const junctionTable = rel.type === 'many-to-many' ? rel.via : null;

                                                                                        return (
                                                                                            <div className="mt-4 pt-4 border-t border-blue-500/10 space-y-6">
                                                                                                {/* The Target Table Context */}
                                                                                                <div className="space-y-4">
                                                                                                    <p className="text-[9px] font-black text-[#135bec] uppercase tracking-widest flex items-center gap-1.5">
                                                                                                        <span className="material-symbols-outlined text-[14px]">table_chart</span>
                                                                                                        Linked Entity: {targetTableName}
                                                                                                    </p>
                                                                                                    {profiledData?.schemaInfo[targetTableName] && (
                                                                                                        <div className="space-y-4">
                                                                                                            <div className="flex gap-2 flex-wrap">
                                                                                                                {profiledData.schemaInfo[targetTableName].columns.slice(0, 4).map((c: any) => (
                                                                                                                    <span key={c.column_name} className="px-2 py-1 rounded bg-black/30 text-[9px] text-slate-400 border border-white/5 font-mono">
                                                                                                                        {c.column_name}
                                                                                                                    </span>
                                                                                                                ))}
                                                                                                            </div>
                                                                                                            {(profiledData.sampleData[targetTableName] || []).length > 0 && (
                                                                                                                <div className="bg-black/40 rounded-xl p-3 border border-white/5 overflow-hidden">
                                                                                                                    <div className="space-y-1.5 max-h-[80px] overflow-y-auto custom-scrollbar-sm pr-1">
                                                                                                                        {profiledData.sampleData[targetTableName].slice(0, 3).map((row: any, sidx: number) => (
                                                                                                                            <div key={sidx} className="text-[9px] text-slate-400 font-mono bg-white/[0.01] p-1.5 rounded border border-white/[0.02] truncate">
                                                                                                                                {Object.entries(row).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' | ')}
                                                                                                                            </div>
                                                                                                                        ))}
                                                                                                                    </div>
                                                                                                                </div>
                                                                                                            )}
                                                                                                        </div>
                                                                                                    )}
                                                                                                </div>

                                                                                                {/* The Junction Table Context (M:M only) */}
                                                                                                {junctionTable && profiledData?.schemaInfo[junctionTable] && (
                                                                                                    <div className="mt-4 p-4 rounded-2xl bg-purple-500/5 border border-purple-500/10 space-y-3">
                                                                                                        <p className="text-[9px] font-black text-purple-400 uppercase tracking-widest flex items-center gap-1.5">
                                                                                                            <span className="material-symbols-outlined text-[14px]">link</span>
                                                                                                            Junction Data: {junctionTable}
                                                                                                        </p>
                                                                                                        <div className="flex gap-2 flex-wrap">
                                                                                                            {profiledData.schemaInfo[junctionTable].columns.slice(0, 3).map((c: any) => (
                                                                                                                <span key={c.column_name} className="px-1.5 py-0.5 rounded bg-black/40 text-[8px] text-purple-300/60 border border-purple-500/10 font-mono">
                                                                                                                    {c.column_name}
                                                                                                                </span>
                                                                                                            ))}
                                                                                                        </div>
                                                                                                        {(profiledData.sampleData[junctionTable] || []).length > 0 && (
                                                                                                            <div className="space-y-1">
                                                                                                                {profiledData.sampleData[junctionTable].slice(0, 2).map((row: any, sidx: number) => (
                                                                                                                    <div key={sidx} className="text-[8px] text-slate-500 font-mono truncate">
                                                                                                                        {Object.entries(row).map(([k, v]) => `${k}:${v}`).join(', ')}
                                                                                                                    </div>
                                                                                                                ))}
                                                                                                            </div>
                                                                                                        )}
                                                                                                    </div>
                                                                                                )}
                                                                                            </div>
                                                                                        );
                                                                                    })()}
                                                                                </div>
                                                                            </div>
                                                                        ))}
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>

                                                        {/* Right: Sample Data */}
                                                        <div>
                                                            <h5 className="text-[10px] font-black text-slate-500 uppercase tracking-[2px] mb-4 flex items-center gap-2">
                                                                <span className="material-symbols-outlined text-[16px]">visibility</span>
                                                                Real Data Snapshots
                                                            </h5>
                                                            <div className="bg-black/20 rounded-3xl border border-[#2d3748]/50 overflow-hidden shadow-inner">
                                                                <div className="overflow-x-auto max-h-[400px] overflow-y-auto custom-scrollbar">
                                                                    {tableRecords.length > 0 ? (
                                                                        <table className="w-full text-[10px] text-left border-collapse">
                                                                            <thead>
                                                                                <tr className="bg-white/5 text-slate-500 font-bold border-b border-white/10 uppercase tracking-widest">
                                                                                    {Object.keys(tableRecords[0]).map(k => (
                                                                                        <th key={k} className="px-4 py-3 whitespace-nowrap">{k}</th>
                                                                                    ))}
                                                                                </tr>
                                                                            </thead>
                                                                            <tbody className="divide-y divide-white/5">
                                                                                {tableRecords.map((row: any, ridx: number) => (
                                                                                    <tr key={ridx} className="hover:bg-white/5 transition-colors">
                                                                                        {Object.values(row).map((val: any, vidx: number) => (
                                                                                            <td key={vidx} className="px-4 py-3 font-mono text-slate-400 whitespace-nowrap max-w-[150px] truncate">
                                                                                                {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                                                                                            </td>
                                                                                        ))}
                                                                                    </tr>
                                                                                ))}
                                                                            </tbody>
                                                                        </table>
                                                                    ) : (
                                                                        <div className="p-8 text-center italic text-slate-600">No sample data available</div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div className="pt-20 text-center pb-12">
                                    <div className="inline-flex items-center gap-4 px-8 py-4 rounded-full bg-slate-900 border border-slate-800">
                                        <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                                        <span className="text-[11px] font-black uppercase tracking-[3px] text-slate-500">Live Knowledge Base Synced</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                ) :
                    selectedTable ? (
                        <>
                            <div className="p-8 border-b border-[#2d3748] flex justify-between items-center bg-[#0c0e12] relative overflow-hidden">
                                <div className="absolute top-0 right-0 w-64 h-64 bg-[#135bec]/5 blur-[80px] rounded-full -mr-32 -mt-32"></div>
                                <div className="relative z-10">
                                    <h3 className="text-3xl font-black tracking-tight text-white uppercase">{selectedTable}</h3>
                                    <div className="flex items-center gap-3 mt-2">
                                        <span className="text-[10px] text-slate-500 uppercase tracking-[3px] font-black">Data Preview</span>
                                        <div className="h-1 w-1 rounded-full bg-slate-700"></div>
                                        <span className="text-[10px] text-[#135bec] uppercase tracking-[3px] font-black">Latest 5 Records</span>
                                    </div>
                                </div>
                                <div className="flex items-center gap-4 relative z-10">
                                    <button
                                        onClick={() => handleDeepProfile(selectedTable)}
                                        disabled={isProfiling}
                                        className={`px-6 py-3 rounded-2xl text-[10px] font-black uppercase tracking-widest flex items-center gap-2 transition-all shadow-xl ${isProfiling
                                            ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                                            : 'bg-gradient-to-r from-[#135bec] to-[#0a369d] text-white hover:scale-[1.02] active:scale-95'
                                            }`}
                                    >
                                        <span className="material-symbols-outlined text-[18px]">instinct</span>
                                        {isProfiling ? 'Generating...' : 'Generate AI Plan'}
                                    </button>

                                    {(canonicalPlan || actionablePlan) && (
                                        <button
                                            onClick={() => {
                                                setSelectedTable(null);
                                                setActionablePlan(canonicalPlan || actionablePlan);
                                            }}
                                            className="px-5 py-3 rounded-2xl bg-white/5 border border-white/10 text-[10px] font-black uppercase tracking-widest text-slate-400 hover:text-[#135bec] hover:border-[#135bec]/30 transition-all flex items-center gap-2 hover:bg-white/10"
                                        >
                                            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                                            Global Blueprint
                                        </button>
                                    )}
                                    <button
                                        onClick={() => handleTableClick(selectedTable)}
                                        className="px-6 py-3 border border-[#2d3748] bg-[#111318] rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-white/5 hover:border-slate-500 active:scale-95 transition-all flex items-center gap-3 shadow-xl"
                                    >
                                        <span className="material-symbols-outlined text-[18px]">refresh</span>
                                        Refresh View
                                    </button>
                                </div>
                            </div>

                            <div className="flex-1 overflow-auto p-12 relative bg-[#0b0d11]">
                                {loading ? (
                                    <div className="absolute inset-0 bg-[#0b0d11]/50 backdrop-blur-sm flex items-center justify-center z-10">
                                        <div className="w-12 h-12 border-4 border-[#135bec]/10 border-t-[#135bec] rounded-full animate-spin"></div>
                                    </div>
                                ) : null}

                                {error ? (
                                    <div className="p-8 bg-red-500/5 border border-red-500/10 rounded-[32px] flex items-center gap-5 text-red-500 text-sm max-w-2xl mx-auto shadow-2xl animate-shake">
                                        <div className="w-12 h-12 rounded-2xl bg-red-500/20 flex items-center justify-center">
                                            <span className="material-symbols-outlined">error</span>
                                        </div>
                                        <div>
                                            <h4 className="font-black uppercase text-[10px] tracking-widest mb-1">Execution Error</h4>
                                            <p className="text-slate-400 font-medium">{error}</p>
                                        </div>
                                    </div>
                                ) : records.length > 0 ? (
                                    <div className="border border-[#2d3748]/50 rounded-[40px] overflow-hidden shadow-[0_25px_100px_-20px_rgba(0,0,0,0.8)] bg-[#111318] max-w-[1200px] mx-auto">
                                        <div className="max-h-[600px] overflow-auto custom-scrollbar">
                                            <table className="w-full text-xs text-left border-collapse">
                                                <thead>
                                                    <tr className="bg-[#1a202c]/30 text-slate-500 font-black uppercase tracking-[3px] border-b border-[#2d3748]/50">
                                                        {Object.keys(records[0]).map((key, i) => (
                                                            <th key={key} className={`px-8 py-6 min-w-[180px] ${i === 0 ? 'pl-10' : ''}`}>
                                                                <div className="flex items-center gap-2">
                                                                    <span className="w-1.5 h-1.5 rounded-full bg-[#135bec]/40"></span>
                                                                    {key}
                                                                </div>
                                                            </th>
                                                        ))}
                                                    </tr>
                                                </thead>
                                                <tbody className="divide-y divide-[#2d3748]/30">
                                                    {records.map((row: any, idx: number) => (
                                                        <tr key={idx} className="hover:bg-white/5 transition-all group">
                                                            {Object.values(row).map((val: any, vIdx: number) => (
                                                                <td key={vIdx} className={`px-8 py-6 font-mono text-slate-300 group-hover:text-white transition-colors ${vIdx === 0 ? 'pl-10' : ''}`}>
                                                                    <div className="truncate max-w-[300px]" title={typeof val === 'object' ? JSON.stringify(val) : String(val)}>
                                                                        {typeof val === 'object'
                                                                            ? <span className="text-blue-400/80">{JSON.stringify(val)}</span>
                                                                            : String(val)}
                                                                    </div>
                                                                </td>
                                                            ))}
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                        <div className="p-4 bg-[#1a202c]/20 border-t border-[#2d3748]/50 flex justify-center">
                                            <p className="text-[10px] text-slate-600 font-black uppercase tracking-widest">End of Record Snapshot</p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="h-full flex flex-col items-center justify-center text-slate-700 space-y-6">
                                        <span className="material-symbols-outlined text-8xl opacity-10">dataset_linked</span>
                                        <div className="text-center">
                                            <h3 className="text-sm font-black uppercase tracking-widest">Empty Dataset</h3>
                                            <p className="text-xs mt-1 font-medium italic">No records found for this table.</p>
                                        </div>
                                    </div>
                                )}

                                {/* Schema & Relations for Selected Table */}
                                {selectedTableSchema && (
                                    <div className="mt-16 max-w-[1200px] mx-auto space-y-16 animate-in fade-in slide-in-from-bottom-4 duration-1000">
                                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-12">
                                            {/* Schema info */}
                                            <div className="space-y-6">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-10 h-10 rounded-xl bg-[#135bec]/10 border border-[#135bec]/20 flex items-center justify-center">
                                                        <span className="material-symbols-outlined text-[#135bec]">data_array</span>
                                                    </div>
                                                    <div>
                                                        <h4 className="text-lg font-black uppercase tracking-tight">Technical Schema</h4>
                                                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Column definitions & constraints</p>
                                                    </div>
                                                </div>
                                                <div className="bg-[#111318] border border-[#2d3748] rounded-[32px] overflow-hidden shadow-2xl">
                                                    <table className="w-full text-[11px] text-left">
                                                        <thead className="bg-white/5 text-slate-500 font-black uppercase">
                                                            <tr>
                                                                <th className="px-6 py-4">Column</th>
                                                                <th className="px-6 py-4">Type</th>
                                                                <th className="px-6 py-4">Status</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-white/5">
                                                            {selectedTableSchema.columns?.map((col: any) => (
                                                                <tr key={col.column_name} className="hover:bg-white/2 transition-colors">
                                                                    <td className="px-6 py-4 text-white font-bold flex items-center gap-2">
                                                                        {col.isPrimaryKey && <span className="material-symbols-outlined text-[14px] text-amber-500">key</span>}
                                                                        {col.column_name}
                                                                    </td>
                                                                    <td className="px-6 py-4 text-slate-400 font-mono italic">{col.data_type}</td>
                                                                    <td className="px-6 py-4">
                                                                        {col.is_nullable === 'NO' ? (
                                                                            <span className="px-2 py-0.5 rounded-full bg-red-500/10 text-red-500 text-[9px] font-black uppercase tracking-tighter border border-red-500/20">Required</span>
                                                                        ) : (
                                                                            <span className="px-2 py-0.5 rounded-full bg-slate-500/10 text-slate-600 text-[9px] font-black uppercase tracking-tighter">Optional</span>
                                                                        )}
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>

                                            {/* Relationships */}
                                            <div className="space-y-6">
                                                <div className="flex items-center gap-4">
                                                    <div className="w-10 h-10 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
                                                        <span className="material-symbols-outlined text-orange-500">hub</span>
                                                    </div>
                                                    <div>
                                                        <h4 className="text-lg font-black uppercase tracking-tight">Active Relationships</h4>
                                                        <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Foreign key linkages</p>
                                                    </div>
                                                </div>
                                                {selectedTableSchema.foreignKeys && selectedTableSchema.foreignKeys.length > 0 ? (
                                                    <div className="space-y-4">
                                                        {selectedTableSchema.foreignKeys.map((rel: any, idx: number) => (
                                                            <div key={idx} className="bg-[#111318] border border-[#2d3748] rounded-[32px] p-6 flex items-center gap-6 group hover:border-[#135bec]/30 transition-all shadow-xl">
                                                                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5 flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform">
                                                                    <span className="material-symbols-outlined text-slate-400 group-hover:text-[#135bec]">link</span>
                                                                </div>
                                                                <div className="flex-1 overflow-hidden">
                                                                    <div className="flex items-center justify-between mb-2">
                                                                        <div className="flex items-center gap-3">
                                                                            <span className="text-white font-black text-sm uppercase">{selectedTable}</span>
                                                                            <span className="material-symbols-outlined text-slate-600 text-[18px]">forward</span>
                                                                            <span className="text-[#135bec] font-black text-sm uppercase underline decoration-2 underline-offset-4">{rel.foreign_table_name}</span>
                                                                        </div>
                                                                        <span className="px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest bg-blue-500/10 text-blue-400 border border-blue-500/10 shrink-0">
                                                                            Foreign Key
                                                                        </span>
                                                                    </div>
                                                                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-[2px] mt-2">Mapped via <span className="text-slate-300">{rel.column_name}</span></p>

                                                                    {/* Deep Context for related table from Profiled Data */}
                                                                    {profiledData?.schemaInfo[rel.foreign_table_name] && (
                                                                        <div className="mt-6 pt-6 border-t border-white/5 space-y-6">
                                                                            {/* Structure Summary */}
                                                                            <div>
                                                                                <p className="text-[8px] font-black text-slate-600 uppercase tracking-widest mb-3 flex items-center gap-1">
                                                                                    <span className="material-symbols-outlined text-[10px]">schema</span>
                                                                                    {rel.foreign_table_name} Structure
                                                                                </p>
                                                                                <div className="flex gap-2 flex-wrap">
                                                                                    {profiledData.schemaInfo[rel.foreign_table_name].columns.slice(0, 4).map((c: any) => (
                                                                                        <span key={c.column_name} className="px-2 py-1 rounded bg-black/40 text-[9px] text-slate-400 border border-white/5 font-mono">
                                                                                            {c.column_name}
                                                                                        </span>
                                                                                    ))}
                                                                                    {profiledData.schemaInfo[rel.foreign_table_name].columns.length > 4 && (
                                                                                        <span className="text-[9px] text-slate-700 py-1 font-black">+{profiledData.schemaInfo[rel.foreign_table_name].columns.length - 4}</span>
                                                                                    )}
                                                                                </div>
                                                                            </div>

                                                                            {/* Sample Records */}
                                                                            {profiledData.sampleData[rel.foreign_table_name] && profiledData.sampleData[rel.foreign_table_name].length > 0 && (
                                                                                <div className="bg-black/40 rounded-2xl p-4 border border-white/5 overflow-hidden shadow-inner">
                                                                                    <div className="flex items-center justify-between mb-3">
                                                                                        <p className="text-[8px] font-black text-slate-700 uppercase tracking-[2px] flex items-center gap-1">
                                                                                            <span className="material-symbols-outlined text-[12px]">database</span>
                                                                                            Live Snapshot from {rel.foreign_table_name}
                                                                                        </p>
                                                                                    </div>
                                                                                    <div className="space-y-2 max-h-[100px] overflow-y-auto custom-scrollbar-sm pr-1">
                                                                                        {profiledData.sampleData[rel.foreign_table_name].slice(0, 3).map((row: any, sidx: number) => (
                                                                                            <div key={sidx} className="text-[9px] text-slate-400 font-mono bg-white/[0.01] p-2 rounded-lg border border-white/[0.02] truncate hover:text-slate-200 transition-colors">
                                                                                                {Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(' | ')}
                                                                                            </div>
                                                                                        ))}
                                                                                    </div>
                                                                                </div>
                                                                            )}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                ) : (
                                                    <div className="bg-[#111318] border border-[#2d3748]/50 border-dashed rounded-[32px] p-12 flex flex-col items-center justify-center text-center opacity-50">
                                                        <span className="material-symbols-outlined text-4xl mb-3">link_off</span>
                                                        <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">No defined relationships</p>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <div className="h-full flex flex-col items-center justify-center bg-[#0b0d11]">
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,#135bec05_0%,transparent_70%)]"></div>
                            <div className="relative group perspective-1000">
                                <div className="w-32 h-32 rounded-[48px] bg-[#111318] flex items-center justify-center border border-[#2d3748] shadow-[0_20px_50px_rgba(0,0,0,0.5)] transform transition-all group-hover:rotate-y-12 group-hover:scale-110 duration-500">
                                    <span className="material-symbols-outlined text-[60px] text-[#135bec] drop-shadow-[0_0_15px_rgba(19,91,236,0.3)]">database_search</span>
                                </div>
                                <div className="absolute -inset-4 bg-[#135bec]/10 blur-2xl rounded-full opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                            </div>
                            <div className="text-center space-y-4 mt-12 relative z-10 max-w-sm">
                                <h3 className="text-2xl font-black text-white uppercase tracking-[8px]">Data Explorer</h3>
                                <p className="text-xs text-slate-500 leading-relaxed font-medium">
                                    Select a table to preview live data or trigger a <span className="text-[#135bec] font-black underline underline-offset-4 decoration-2">Deep Intelligence</span> profiling session to map your entire architectural landscape.
                                </p>
                            </div>

                            <div className="mt-16 grid grid-cols-2 gap-4 w-[400px]">
                                <div className="p-4 rounded-2xl bg-[#0f1115] border border-[#2d3748] flex flex-col items-center gap-2">
                                    <span className="material-symbols-outlined text-slate-500">table_view</span>
                                    <span className="text-[10px] font-black uppercase text-slate-600 tracking-widest">Live Preview</span>
                                </div>
                                <div className="p-4 rounded-2xl bg-[#0f1115] border border-[#2d3748] flex flex-col items-center gap-2">
                                    <span className="material-symbols-outlined text-slate-500">architecture</span>
                                    <span className="text-[10px] font-black uppercase text-slate-600 tracking-widest">Plan Mapping</span>
                                </div>
                            </div>
                        </div>
                    )}
            </div>
        </div>
    );
};

export default DataExplorerView;

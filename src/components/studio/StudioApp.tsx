'use client';

import React, { useState, useMemo, useEffect } from 'react';
import Header from './Header';
import { ChatPanel } from '@/components/chat/ChatPanel';
import InspectorSidebar from './InspectorSidebar';
import { DashboardCanvas } from '@/components/canvas/DashboardCanvas';
import DataSourcesView from './views/DataSourcesView';
import SettingsView from './views/SettingsView';
import WorkbenchView from './views/WorkbenchView';
import { ACTIVE_CONNECTIONS } from '@/lib/studio-constants';
import { useDashboardStore, useEditorStore, useRunStore, useConfigStore, useUIStore, AppView, useWorkflowStore, useAuthStore } from '@/state/stores';
import { LoginPage } from '@/components/auth/LoginPage';
import { dbGateway } from '@/lib/mcp/client';
import { DataSource } from '@/types/dashboard';
import { Widget } from '@/types/studio';

// Sequential Flow Steps
import { WorkflowStepper } from './WorkflowStepper';
import { SchemaDiscoveryView } from './steps/SchemaDiscoveryView';
import { DashboardPlannerView } from './steps/DashboardPlannerView';
import { QueryGeneratorView } from './steps/QueryGeneratorView';
import { QueryExecutorView } from './steps/QueryExecutorView';
import { DashboardRenderView } from './steps/DashboardRenderView';

const StudioApp: React.FC = () => {
    const { currentView, setCurrentView } = useUIStore();
    const [showInspector, setShowInspector] = useState(false);
    const [showCopilot, setShowCopilot] = useState(true);

    // Sync with real stores
    const { dashboard, isLoading: isDashboardLoading } = useDashboardStore();
    const { selectedWidgetId, selectWidget, localLayout, localWidgets } = useEditorStore();
    const { partialResults } = useRunStore();
    const { postgresUrl, setConnectionStatus, dataSources, selectedDataSourceId, setSelectedDataSourceId, connectionStatus } = useConfigStore();

    // Auto-connect to Database on mount
    const { setPostgresUrl, setMssqlUrl, addDataSource } = useConfigStore();
    useEffect(() => {
        const initDb = async () => {
            try {
                const env = await dbGateway.getEnvConfig();

                // Track IDs we've added to avoid duplicates if same URL is in both env vars
                const addedUrls = new Set<string>();

                const processEnvUrl = async (url: string | undefined, defaultType: 'PostgreSQL' | 'MSSQL') => {
                    if (!url || addedUrls.has(url)) return;
                    addedUrls.add(url);

                    const lowerUrl = url.toLowerCase();
                    const isMssql = !lowerUrl.startsWith('postgres://') &&
                        !lowerUrl.startsWith('postgresql://') &&
                        (lowerUrl.startsWith('mssql://') ||
                            lowerUrl.startsWith('sqlserver://') ||
                            lowerUrl.includes('server=') ||
                            lowerUrl.includes('data source='));

                    const detectedType = isMssql ? 'MSSQL' : 'PostgreSQL';
                    const id = isMssql ? 'ds_mssql_auto' : 'ds_postgres_auto';

                    if (isMssql) setMssqlUrl(url);
                    else setPostgresUrl(url);

                    addDataSource({
                        id,
                        name: `${detectedType} (Auto)`,
                        type: detectedType,
                        details: url,
                        status: 'Connecting',
                        lastSync: new Date().toLocaleTimeString(),
                        icon: 'database',
                        connectionString: url
                    });

                    const connected = await dbGateway.connect(url);
                    if (connected) {
                        const tables = await dbGateway.listTables(url);
                        if (Array.isArray(tables)) {
                            useConfigStore.getState().updateDataSource(id, { status: 'Connected' });
                            useConfigStore.getState().setDiscoveredTables(tables);
                        } else {
                            useConfigStore.getState().updateDataSource(id, { status: 'Error' });
                        }
                    } else {
                        useConfigStore.getState().updateDataSource(id, { status: 'Error' });
                    }
                };

                await processEnvUrl(env.postgresUrl, 'PostgreSQL');
                await processEnvUrl(env.mssqlUrl, 'MSSQL');

                // Auto-select the first connected node if none selected
                const currentStore = useConfigStore.getState();
                if (!currentStore.selectedDataSourceId) {
                    const firstConnected = currentStore.dataSources.find(ds => ds.status === 'Connected');
                    if (firstConnected) {
                        setSelectedDataSourceId(firstConnected.id);
                    } else if (currentStore.dataSources.length > 0) {
                        setSelectedDataSourceId(currentStore.dataSources[0].id);
                    }
                }

                // Update global connection status
                const connectedCount = useConfigStore.getState().dataSources.filter(ds => ds.status === 'Connected').length;
                if (connectedCount > 0) {
                    setConnectionStatus("Connected");
                } else if (addedUrls.size > 0) {
                    setConnectionStatus("Error");
                }
            } catch (err) {
                console.error("[INIT] Failed to sync env config:", err);
            }
        };
        initDb();
    }, []); // Run once on mount

    // Workflow State
    const { currentStep, query: workflowQuery, setStep, executionResults, schemaData } = useWorkflowStore();

    const isEditorView = currentView === 'build' || currentView === 'data-sources' || currentView === 'schema';

    useEffect(() => {
        if (currentView !== 'build') return;
        if (workflowQuery) return;

        const hasSchema = (() => {
            if (!schemaData) return false;
            const tables = Array.isArray(schemaData?.tables) ? schemaData.tables : [];
            if (tables.length > 0) return true;
            const info = schemaData?.schemaInfo;
            return !!info && Object.keys(info).length > 0;
        })();
        if (hasSchema) return;

        const hasConnectedSqlSource = (() => {
            const selected = dataSources.find((ds) => ds.id === selectedDataSourceId);
            const candidates = selected ? [selected] : dataSources;
            const connected = candidates.find((ds) => {
                const type = String(ds?.type || "").toLowerCase();
                const isSql = type.includes('postgres') || type.includes('mssql') || type.includes('sql');
                return isSql && String(ds?.status || '').toLowerCase() === 'connected';
            });
            if (connected) return true;
            return connectionStatus === 'Connected';
        })();

        if (!hasConnectedSqlSource) {
            setCurrentView('data-sources');
            return;
        }

        setCurrentView('schema');
        setStep(1);
    }, [currentView, workflowQuery, schemaData, dataSources, selectedDataSourceId, connectionStatus, setCurrentView, setStep]);

    // Compute layout and widgets
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

    const getWidgetData = (widgetId: string) => {
        // Prefer fresh executor results (step 4 output)
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

        // Live partial streaming data
        const streamResults = partialResults.get(`q_${widgetId}`) || partialResults.get(widgetId);
        if (streamResults) return streamResults;

        // Query-mapped results from partials
        const query = dashboard?.queries?.find((q: any) => q.widgetIds.includes(widgetId));
        if (query?.id && partialResults.has(query.id)) {
            return partialResults.get(query.id);
        }

        // Fall back to widget-embedded data
        const widget = dashboard?.widgets?.find((w: any) => w.id === widgetId);
        return widget?.data;
    };

    const renderMainContent = () => {
        if (currentView === 'build') {
            // If we're in the middle of a workflow (Steps 1-5)
            if (workflowQuery) {
                return (
                    <div className="flex flex-col h-full">
                        <WorkflowStepper />
                        <div className="flex-1 overflow-hidden relative">
                            {currentStep === 1 && <SchemaDiscoveryView />}
                            {currentStep === 2 && <DashboardPlannerView />}
                            {currentStep === 3 && <QueryGeneratorView />}
                            {currentStep === 4 && <QueryExecutorView />}
                            {currentStep === 5 && <DashboardRenderView />}
                        </div>
                    </div>
                );
            }

            // Otherwise, show the canvas (Search or Dashboard)
            return (
                <DashboardCanvas
                    widgets={widgets}
                    layout={layout as any}
                    isEditing={true}
                    onWidgetClick={(id) => selectWidget(id)}
                    getWidgetData={getWidgetData}
                />
            );
        }

        if (currentView === 'schema') return <SchemaDiscoveryView />;
        if (currentView === 'data-sources') return <DataSourcesView selectedId={selectedDataSourceId} onSelect={setSelectedDataSourceId} />;
        if (currentView === 'settings') return <SettingsView />;
        if (currentView === 'workbench') return <WorkbenchView widgets={[]} selectedWidget={null as any} />;

        return null;
    };

    const gridTemplate = useMemo(() => {
        if (!isEditorView) return '1fr';
        let cols = [];
        if (showCopilot) cols.push('380px');
        cols.push('1fr');
        if (showInspector) cols.push('340px');
        return cols.join(' ');
    }, [isEditorView, showCopilot, showInspector]);

    const { isAuthenticated } = useAuthStore();

    if (!isAuthenticated) {
        return <LoginPage />;
    }

    return (
        <div className="flex h-screen w-full flex-col bg-[var(--bg-app)] text-white overflow-hidden font-sans antialiased">
            <Header />

            <div
                className="flex-1 overflow-hidden grid"
                style={{ gridTemplateColumns: gridTemplate }}
            >
                {/* Left Side: Copilot */}
                {isEditorView && showCopilot && (
                    <aside className="w-[380px] flex flex-col border-r border-[var(--border)] bg-[var(--bg-app)] z-[50] shrink-0 relative overflow-hidden">
                        <ChatPanel onCollapse={() => setShowCopilot(false)} />
                    </aside>
                )}

                {/* Center Main Content */}
                <main className="min-w-0 h-full relative flex flex-col bg-[var(--bg-app)] overflow-hidden">
                    {renderMainContent()}

                    {/* Floating Sidebar Controls */}
                    {isEditorView && !showCopilot && (
                        <div className="absolute inset-y-0 left-0 flex items-center pointer-events-none px-2 z-50">
                            <button
                                onClick={() => setShowCopilot(true)}
                                className="pointer-events-auto p-1.5 bg-[#135bec] rounded-lg shadow-lg hover:scale-110 transition-transform"
                            >
                                <span className="material-symbols-outlined text-white text-[18px]">menu_open</span>
                            </button>
                        </div>
                    )}
                </main>

                {/* Right Side: Inspector */}
                {isEditorView && showInspector && (
                    <div className="relative h-full border-l border-[#2d3748]">
                        <InspectorSidebar
                            currentView={currentView === 'data-sources' ? 'data-sources' : 'build'}
                            selectedWidget={widgets.find(w => w.id === selectedWidgetId) as any}
                            selectedDataSource={dataSources.find(ds => ds.id === selectedDataSourceId) || dataSources[0]}
                        />
                        <button
                            onClick={() => setShowInspector(false)}
                            className="absolute top-4 left-4 p-1.5 text-slate-500 hover:text-white transition-all z-[60]"
                            title="Collapse Inspector"
                        >
                            <span className="material-symbols-outlined text-[18px]">last_page</span>
                        </button>
                    </div>
                )}

                {/* Re-expand Inspector button */}
                {isEditorView && !showInspector && (
                    <div className="absolute inset-y-0 right-0 flex items-center pointer-events-none px-2 z-50">
                        <button
                            onClick={() => setShowInspector(true)}
                            className="pointer-events-auto p-1.5 bg-[#135bec] rounded-lg shadow-lg hover:scale-110 transition-transform"
                        >
                            <span className="material-symbols-outlined text-white text-[18px]">last_page</span>
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};

export default StudioApp;

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import { enableMapSet } from "immer";

enableMapSet();
import type {
    Dashboard,
    WidgetSpec,
    LayoutItem,
    Filter,
    RunEvent,
    AgentStep,
    StepStatus,
    DataSource,
} from "@/types/dashboard";

// ============================================================================
// RUN STATE (Streaming)
// ============================================================================
export interface StepState {
    step: AgentStep;
    status: StepStatus;
    message?: string;
    logs: string[];
    startedAt?: string;
    completedAt?: string;
}

export interface RunState {
    runId: string | null;
    isStreaming: boolean;
    steps: StepState[];
    partialDashboard: Partial<Dashboard> | null;
    partialResults: Map<string, any[]>;
    error: string | null;
    startedAt: string | null;
    completedAt: string | null;
}

interface RunStore extends RunState {
    // Actions
    startRun: (runId: string) => void;
    handleEvent: (event: RunEvent) => void;
    endRun: (success: boolean, error?: string) => void;
    reset: () => void;
}

const initialRunState: RunState = {
    runId: null,
    isStreaming: false,
    steps: [],
    partialDashboard: null,
    partialResults: new Map(),
    error: null,
    startedAt: null,
    completedAt: null,
};

export const useRunStore = create<RunStore>()(
    devtools(
        immer((set) => ({
            ...initialRunState,

            startRun: (runId) => set((state) => {
                state.runId = runId;
                state.isStreaming = true;
                state.steps = [];
                state.partialDashboard = null;
                state.partialResults = new Map();
                state.error = null;
                state.startedAt = new Date().toISOString();
                state.completedAt = null;
            }),

            handleEvent: (event) => set((state) => {
                const dashboardStore = useDashboardStore.getState();
                const uiStore = useUIStore.getState();

                switch (event.type) {
                    case "step": {
                        const existingIdx = state.steps.findIndex(s => s.step === event.step);
                        const existingLogs = existingIdx >= 0 ? state.steps[existingIdx].logs : [];
                        const stepState: StepState = {
                            step: event.step,
                            status: event.status,
                            message: event.message,
                            logs: existingLogs || [],
                            ...(event.status === "running" && { startedAt: event.ts }),
                            ...(["done", "warn", "fail"].includes(event.status) && { completedAt: event.ts }),
                        };

                        if (existingIdx >= 0) {
                            state.steps[existingIdx] = { ...state.steps[existingIdx], ...stepState };
                        } else {
                            state.steps.push(stepState);
                        }
                        break;
                    }

                    case "partial_dashboard": {
                        state.partialDashboard = {
                            ...state.partialDashboard,
                            ...event.dashboard,
                        };
                        dashboardStore.mergeDashboard(event.dashboard);
                        break;
                    }

                    case "partial_results": {
                        state.partialResults.set(event.queryId, event.rowsPreview);
                        break;
                    }

                    case "log": {
                        const targetStep = event.step;
                        let stepIdx = -1;
                        if (targetStep) {
                            stepIdx = state.steps.findIndex(s => s.step === targetStep);
                        }
                        if (stepIdx < 0) {
                            stepIdx = state.steps.length - 1;
                        }
                        if (stepIdx >= 0) {
                            if (!state.steps[stepIdx].logs) {
                                state.steps[stepIdx].logs = [];
                            }
                            state.steps[stepIdx].logs.push(event.message);
                        }
                        break;
                    }

                    case "final": {
                        state.partialDashboard = event.envelope.dashboard || null;
                        state.isStreaming = false;
                        state.completedAt = event.ts;

                        if (event.envelope.dashboard) {
                            dashboardStore.setDashboard(event.envelope.dashboard as any);
                            uiStore.setCurrentView("build");
                            useWorkflowStore.getState().setQuery("");
                        }
                        break;
                    }

                    case "error": {
                        state.error = event.message;
                        state.isStreaming = false;
                        state.completedAt = event.ts;
                        break;
                    }
                }
            }),

            endRun: (success, error) => set((state) => {
                state.isStreaming = false;
                state.completedAt = new Date().toISOString();
                if (!success && error) {
                    state.error = error;
                }
            }),

            reset: () => set(() => initialRunState),
        })),
        { name: "run-store" }
    )
);

// ============================================================================
// EDITOR STATE (Canvas editing)
// ============================================================================
export interface EditorState {
    // Selection
    selectedWidgetId: string | null;
    selectedWidgetIds: string[];

    // Editing mode
    isEditing: boolean;
    isDragging: boolean;
    isResizing: boolean;

    // Local edits (before saving)
    localWidgets: Map<string, Partial<WidgetSpec>>;
    localLayout: LayoutItem[] | null;
    localFilters: Filter[] | null;

    // Undo/Redo
    undoStack: LayoutItem[][];
    redoStack: LayoutItem[][];

    // UI state
    inspectorTab: "properties" | "data" | "interactions";
    debugDrawerOpen: boolean;
    debugDrawerTab: "sql" | "params" | "qa" | "lineage" | "results";

    // Dirty flag
    isDirty: boolean;
}

interface EditorStore extends EditorState {
    // Selection
    selectWidget: (id: string | null) => void;
    selectMultipleWidgets: (ids: string[]) => void;
    clearSelection: () => void;

    // Layout editing
    setDragging: (dragging: boolean) => void;
    setResizing: (resizing: boolean) => void;
    updateLayout: (layout: LayoutItem[]) => void;

    // Widget editing
    updateWidget: (id: string, updates: Partial<WidgetSpec>) => void;
    deleteWidget: (id: string) => void;
    duplicateWidget: (id: string) => void;

    // Undo/Redo
    undo: () => void;
    redo: () => void;
    saveToUndoStack: (layout: LayoutItem[]) => void;

    // UI
    setInspectorTab: (tab: EditorState["inspectorTab"]) => void;
    setDebugDrawerOpen: (open: boolean) => void;
    setDebugDrawerTab: (tab: EditorState["debugDrawerTab"]) => void;

    // Dirty state
    markDirty: () => void;
    markClean: () => void;

    // Reset
    reset: () => void;
}

const initialEditorState: EditorState = {
    selectedWidgetId: null,
    selectedWidgetIds: [],
    isEditing: false,
    isDragging: false,
    isResizing: false,
    localWidgets: new Map(),
    localLayout: null,
    localFilters: null,
    undoStack: [],
    redoStack: [],
    inspectorTab: "properties",
    debugDrawerOpen: false,
    debugDrawerTab: "sql",
    isDirty: false,
};

export const useEditorStore = create<EditorStore>()(
    devtools(
        immer((set, get) => ({
            ...initialEditorState,

            selectWidget: (id) => set((state) => {
                state.selectedWidgetId = id;
                state.selectedWidgetIds = id ? [id] : [];
            }),

            selectMultipleWidgets: (ids) => set((state) => {
                state.selectedWidgetIds = ids;
                state.selectedWidgetId = ids[0] || null;
            }),

            clearSelection: () => set((state) => {
                state.selectedWidgetId = null;
                state.selectedWidgetIds = [];
            }),

            setDragging: (dragging) => set((state) => {
                state.isDragging = dragging;
            }),

            setResizing: (resizing) => set((state) => {
                state.isResizing = resizing;
            }),

            updateLayout: (layout) => set((state) => {
                state.localLayout = layout;
                state.isDirty = true;
            }),

            updateWidget: (id, updates) => set((state) => {
                const existing = state.localWidgets.get(id) || {};
                state.localWidgets.set(id, { ...existing, ...updates });
                state.isDirty = true;
            }),

            deleteWidget: (id) => set((state) => {
                state.localWidgets.delete(id);
                if (state.localLayout) {
                    state.localLayout = state.localLayout.filter(item => item.i !== id);
                }
                if (state.selectedWidgetId === id) {
                    state.selectedWidgetId = null;
                }
                state.selectedWidgetIds = state.selectedWidgetIds.filter(wid => wid !== id);
                state.isDirty = true;
            }),

            duplicateWidget: (id) => set((state) => {
                const widget = state.localWidgets.get(id);
                if (widget) {
                    const newId = `${id}_copy_${Date.now()}`;
                    state.localWidgets.set(newId, { ...widget, id: newId });

                    if (state.localLayout) {
                        const originalLayout = state.localLayout.find(item => item.i === id);
                        if (originalLayout) {
                            state.localLayout.push({
                                ...originalLayout,
                                i: newId,
                                y: originalLayout.y + originalLayout.h,
                            });
                        }
                    }
                    state.isDirty = true;
                }
            }),

            undo: () => set((state) => {
                if (state.undoStack.length > 0) {
                    const previous = state.undoStack.pop()!;
                    if (state.localLayout) {
                        state.redoStack.push(state.localLayout);
                    }
                    state.localLayout = previous;
                }
            }),

            redo: () => set((state) => {
                if (state.redoStack.length > 0) {
                    const next = state.redoStack.pop()!;
                    if (state.localLayout) {
                        state.undoStack.push(state.localLayout);
                    }
                    state.localLayout = next;
                }
            }),

            saveToUndoStack: (layout) => set((state) => {
                state.undoStack.push(layout);
                state.redoStack = [];
                // Keep only last 20 states
                if (state.undoStack.length > 20) {
                    state.undoStack.shift();
                }
            }),

            setInspectorTab: (tab) => set((state) => {
                state.inspectorTab = tab;
            }),

            setDebugDrawerOpen: (open) => set((state) => {
                state.debugDrawerOpen = open;
            }),

            setDebugDrawerTab: (tab) => set((state) => {
                state.debugDrawerTab = tab;
            }),

            markDirty: () => set((state) => {
                state.isDirty = true;
            }),

            markClean: () => set((state) => {
                state.isDirty = false;
            }),

            reset: () => set(() => initialEditorState),
        })),
        { name: "editor-store" }
    )
);

// ============================================================================
// DASHBOARD STORE (Current dashboard state)
// ============================================================================
export interface DashboardState {
    dashboard: Dashboard | null;
    isLoading: boolean;
    error: string | null;

    // Filter state (cross-filtering)
    activeFilters: Map<string, any>;
    filtersActivated: boolean;

    // History
    recentDashboards: Array<{
        id: string;
        name: string;
        updatedAt: string;
    }>;

    // Recent queries
    recentQueries: Array<{
        query: string;
        timestamp: string;
        dashboardId?: string;
    }>;
}

interface DashboardStore extends DashboardState {
    setDashboard: (dashboard: Dashboard | null) => void;
    setLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;

    // Filtering
    setFilter: (dimension: string, value: any) => void;
    clearFilter: (dimension: string) => void;
    clearAllFilters: () => void;
    markFiltersActivated: () => void;

    // History
    addToRecentDashboards: (dashboard: Pick<Dashboard, "id" | "name" | "updatedAt">) => void;
    addToRecentQueries: (query: string, dashboardId?: string) => void;

    // Merge partial updates
    mergeDashboard: (partial: Partial<Dashboard>) => void;

    reset: () => void;
}

const initialDashboardState: DashboardState = {
    dashboard: null,
    isLoading: false,
    error: null,
    activeFilters: new Map(),
    filtersActivated: false,
    recentDashboards: [],
    recentQueries: [],
};

export const useDashboardStore = create<DashboardStore>()(
    devtools(
        persist(
            immer((set) => ({
                ...initialDashboardState,

                setDashboard: (dashboard) => set((state) => {
                    state.dashboard = dashboard;
                    state.error = null;
                    state.filtersActivated = false;
                }),

                setLoading: (loading) => set((state) => {
                    state.isLoading = loading;
                }),

                setError: (error) => set((state) => {
                    state.error = error;
                }),

                setFilter: (dimension, value) => set((state) => {
                    state.activeFilters.set(dimension, value);
                }),

                clearFilter: (dimension) => set((state) => {
                    state.activeFilters.delete(dimension);
                }),

                clearAllFilters: () => set((state) => {
                    state.activeFilters = new Map();
                }),

                markFiltersActivated: () => set((state) => {
                    state.filtersActivated = true;
                }),

                addToRecentDashboards: (dashboard) => set((state) => {
                    const existing = state.recentDashboards.findIndex(d => d.id === dashboard.id);
                    if (existing >= 0) {
                        state.recentDashboards.splice(existing, 1);
                    }
                    state.recentDashboards.unshift({
                        id: dashboard.id,
                        name: dashboard.name,
                        updatedAt: dashboard.updatedAt,
                    });
                    // Keep only last 20
                    state.recentDashboards = state.recentDashboards.slice(0, 20);
                }),

                addToRecentQueries: (query, dashboardId) => set((state) => {
                    state.recentQueries.unshift({
                        query,
                        timestamp: new Date().toISOString(),
                        dashboardId,
                    });
                    // Keep only last 50
                    state.recentQueries = state.recentQueries.slice(0, 50);
                }),

                mergeDashboard: (partial) => set((state) => {
                    if (state.dashboard) {
                        state.dashboard = { ...state.dashboard, ...partial };
                    } else {
                        state.dashboard = partial as Dashboard;
                    }
                }),

                reset: () => set((state) => {
                    state.dashboard = null;
                    state.isLoading = false;
                    state.error = null;
                    state.activeFilters = new Map();
                    state.filtersActivated = false;
                }),
            })),
            {
                name: "dashboard-store",
                partialize: (state) => ({
                    recentDashboards: state.recentDashboards,
                    recentQueries: state.recentQueries,
                }),
            }
        ),
        { name: "dashboard-store" }
    )
);
// ============================================================================
// CONFIG STORE (Settings & Data Sources)
// ============================================================================
export interface ConfigState {
    postgresUrl: string;
    connectionStatus: "Connected" | "Disconnected" | "Connecting" | "Error";
    dataSources: DataSource[];
    selectedDataSourceId: string | null;
    discoveredTables: string[];
    canonicalPlan: string | null;
    projectContext: string;
}

interface ConfigStore extends ConfigState {
    setPostgresUrl: (url: string) => void;
    setConnectionStatus: (status: ConfigState["connectionStatus"]) => void;
    addDataSource: (ds: DataSource) => void;
    removeDataSource: (id: string) => void;
    setDiscoveredTables: (tables: string[]) => void;
    setSelectedDataSourceId: (id: string | null) => void;
    setCanonicalPlan: (plan: string | null) => void;
    setProjectContext: (context: string) => void;
}

const initialConfigState: ConfigState = {
    postgresUrl: "postgresql://localhost:5432/postgres",
    connectionStatus: "Disconnected",
    dataSources: [
        {
            id: "ds_mcp",
            name: "Internal Knowledge Base",
            type: "MCP Agent",
            details: "mcp-server-memory",
            status: "Connected",
            lastSync: "Running",
            icon: "smart_toy"
        }
    ],
    selectedDataSourceId: "ds_mcp",
    discoveredTables: [],
    canonicalPlan: null,
    projectContext: "",
};

export const useConfigStore = create<ConfigStore>()(
    devtools(
        persist(
            immer((set) => ({
                ...initialConfigState,

                setPostgresUrl: (url) => set((state) => {
                    state.postgresUrl = url;
                }),

                setConnectionStatus: (status) => set((state) => {
                    state.connectionStatus = status;
                }),

                addDataSource: (ds) => set((state) => {
                    const idx = state.dataSources.findIndex((d: DataSource) => d.id === ds.id);
                    if (idx >= 0) {
                        state.dataSources[idx] = ds;
                    } else {
                        state.dataSources.push(ds);
                    }
                    if (!state.selectedDataSourceId && ds.id) {
                        state.selectedDataSourceId = ds.id;
                    }
                }),

                removeDataSource: (id) => set((state) => {
                    state.dataSources = state.dataSources.filter((d: DataSource) => d.id !== id);
                    if (state.selectedDataSourceId === id) {
                        state.selectedDataSourceId = state.dataSources[0]?.id || null;
                    }
                }),

                setDiscoveredTables: (tables) => set((state) => {
                    state.discoveredTables = tables;
                }),
                setSelectedDataSourceId: (id) => set((state) => {
                    state.selectedDataSourceId = id;
                }),
                setCanonicalPlan: (plan) => set((state) => {
                    state.canonicalPlan = plan;
                }),
                setProjectContext: (context) => set((state) => {
                    state.projectContext = context;
                }),
            })),
            {
                name: "config-store",
            }
        ),
        { name: "config-store" }
    )
);
// ============================================================================
// UI STORE (Navigation & View states)
// ============================================================================
export type AppView = 'build' | 'data-explorer' | 'data-sources' | 'settings' | 'workbench' | 'schema';

interface UIState {
    currentView: AppView;
}

interface UIStore extends UIState {
    setCurrentView: (view: AppView) => void;
}

export const useUIStore = create<UIStore>()(
    devtools(
        immer((set) => ({
            currentView: 'build',
            setCurrentView: (view) => set((state) => {
                state.currentView = view;
            }),
        })),
        { name: "ui-store" }
    )
);
// ============================================================================
// WORKFLOW STORE (Multi-step generation)
// ============================================================================
export type WorkflowStep = 1 | 2 | 3 | 4 | 5;

export interface WorkflowState {
    currentStep: WorkflowStep;
    query: string;

    // Step 1: Schema
    schemaData: any | null;
    userSchemaNotes: string;
    schemaTimestamp: string | null;

    // Step 2: Plan
    aiPlan: any | null;
    userPlan: any | null;

    // Step 3: SQL
    aiQueries: any[] | null;
    userQueries: any[] | null;

    // Step 4: Execution
    executionResults: any | null;
    sqlErrorLog: Array<{
        id: string;
        title?: string;
        sql?: string;
        error: string;
        timestamp: string;
    }>;

    // Step 5: Dashboard
    dashboardConfig: any | null;

    // Global Status
    isProcessing: boolean;
    error: string | null;
    staleStep: number | null;
}

interface WorkflowStore extends WorkflowState {
    setStep: (step: WorkflowStep) => void;
    setQuery: (query: string) => void;
    setSchemaData: (data: any) => void;
    setUserSchemaNotes: (notes: string) => void;
    setAiPlan: (plan: any) => void;
    setUserPlan: (plan: any) => void;
    setAiQueries: (queries: any[]) => void;
    setUserQueries: (queries: any[]) => void;
    setExecutionResults: (results: any) => void;
    addSqlError: (entry: { id: string; title?: string; sql?: string; error: string }) => void;
    setDashboardConfig: (config: any) => void;
    setProcessing: (processing: boolean) => void;
    setError: (error: string | null) => void;
    setStaleStep: (step: number | null) => void;
    reset: () => void;
}

const initialWorkflowState: WorkflowState = {
    currentStep: 1,
    query: "",
    schemaData: null,
    userSchemaNotes: "",
    schemaTimestamp: null,
    aiPlan: null,
    userPlan: null,
    aiQueries: null,
    userQueries: null,
    executionResults: null,
    sqlErrorLog: [],
    dashboardConfig: null,
    isProcessing: false,
    error: null,
    staleStep: null,
};

export const useWorkflowStore = create<WorkflowStore>()(
    devtools(
        persist(
            immer((set) => ({
                ...initialWorkflowState,

                setStep: (step) => set((state) => {
                    state.currentStep = step;
                }),

                setQuery: (query) => set((state) => {
                    state.query = query;
                }),

                setSchemaData: (data) => set((state) => {
                    // Optimization: If schema is identical, do not cascade clear
                    // This prevents accidental wipes if the discovery runs but returns same data
                    const isSame = JSON.stringify(data) === JSON.stringify(state.schemaData);
                    if (isSame && state.schemaData !== null) {
                        return;
                    }

                    state.schemaData = data;
                    state.schemaTimestamp = new Date().toISOString();
                    state.error = null;

                    // Cascade clear: New schema invalidates everything downstream
                    state.aiPlan = null;
                    state.userPlan = null;
                    state.aiQueries = null;
                    state.userQueries = null;
                    state.executionResults = null;
                    state.dashboardConfig = null;
                    state.staleStep = null;
                }),

                setUserSchemaNotes: (notes) => set((state) => {
                    state.userSchemaNotes = notes;
                }),

                setAiPlan: (plan) => set((state) => {
                    state.aiPlan = plan;
                    state.userPlan = plan; // Default user plan to AI plan
                    state.error = null;

                    // Mark downstream as stale, but preserve data so UI doesn't emptiness
                    // This fixes the issue where rerunning the plan appeared to wipe subsequent steps
                    state.staleStep = 3;

                    // Clear prior dashboard data so new plan doesn't render old widgets
                    state.executionResults = null;
                    state.dashboardConfig = null;

                    // Explicitly preserve downstream data (redundant with Immer but explicit for safety)
                    // state.aiQueries and state.executionResults remain untouched
                }),

                setUserPlan: (plan) => set((state) => {
                    state.userPlan = plan;
                    state.aiQueries = null;
                    state.userQueries = null;
                    state.executionResults = null;
                    state.dashboardConfig = null;
                    state.staleStep = 3;
                }),

                setAiQueries: (queries) => set((state) => {
                    state.aiQueries = queries;
                    state.userQueries = queries; // Default user queries to AI queries
                    state.error = null;

                    // Mark downstream as stale
                    state.staleStep = 4;
                }),

                setUserQueries: (queries) => set((state) => {
                    state.userQueries = queries;
                }),

                setExecutionResults: (results) => set((state) => {
                    state.executionResults = results;
                    state.error = null;

                    // Mark downstream as stale
                    state.staleStep = 5;
                }),

                addSqlError: (entry) => set((state) => {
                    const newEntry = {
                        id: entry.id,
                        title: entry.title,
                        sql: entry.sql,
                        error: entry.error,
                        timestamp: new Date().toISOString()
                    };
                    state.sqlErrorLog.unshift(newEntry);
                    state.sqlErrorLog = state.sqlErrorLog.slice(0, 15);
                }),

                setDashboardConfig: (config) => set((state) => {
                    state.dashboardConfig = config;
                }),

                setProcessing: (processing) => set((state) => {
                    state.isProcessing = processing;
                }),

                setError: (error) => set((state) => {
                    state.error = error;
                    state.isProcessing = false;
                }),

                setStaleStep: (step) => set((state) => {
                    state.staleStep = step;
                }),

                reset: () => set(() => initialWorkflowState),
            })),
            {
                name: 'workflow-store',
                partialize: (state) => ({
                    // Only persist lightweight state
                    currentStep: state.currentStep,
                    query: state.query,
                    userSchemaNotes: state.userSchemaNotes,
                    schemaTimestamp: state.schemaTimestamp,
                    aiPlan: state.aiPlan,
                    userPlan: state.userPlan,
                    aiQueries: state.aiQueries,
                    userQueries: state.userQueries,
                    sqlErrorLog: state.sqlErrorLog,
                    // EXCLUDE: schemaData (too big), executionResults (too big)
                })
            }
        ),
        { name: "workflow-store" }
    )
);

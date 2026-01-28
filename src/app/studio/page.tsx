"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
    PanelLeftClose,
    PanelLeft,
    PanelRightClose,
    PanelRight,
    Edit3,
    Eye,
    Save,
    Undo2,
    Redo2,
    Terminal,
    Share,
    ChevronDown
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { DashboardCanvas, DashboardCanvasSkeleton } from "@/components/canvas/DashboardCanvas";
import { FilterBar } from "@/components/canvas/FilterBar";
import { InspectorPanel } from "@/components/inspector/InspectorPanel";
import { DebugDrawer } from "@/components/debug/DebugDrawer";
import { useRunStore, useEditorStore, useDashboardStore } from "@/state/stores";
import type { WidgetSpec, LayoutItem } from "@/types/dashboard";
import styles from "./DashboardStudio.module.css";

type StudioTab = "build" | "data" | "quality" | "semantic" | "history";

export default function DashboardStudio() {
    // Panel visibility
    const [leftPanelOpen, setLeftPanelOpen] = useState(true);
    const [rightPanelOpen, setRightPanelOpen] = useState(true);
    const [isEditing, setIsEditing] = useState(true);

    // Stores
    const { isStreaming, partialDashboard, partialResults } = useRunStore();
    const {
        selectedWidgetId,
        selectWidget,
        undoStack,
        redoStack,
        undo,
        redo,
        localLayout,
        localWidgets,
        isDirty,
        markClean,
    } = useEditorStore();
    const { dashboard, setDashboard, isLoading } = useDashboardStore();

    // Merge partial dashboard updates during streaming
    useEffect(() => {
        if (partialDashboard) {
            setDashboard({
                id: partialDashboard.id || `dash_${Date.now()}`,
                name: partialDashboard.name || "New Dashboard",
                originalQuery: partialDashboard.originalQuery || "",
                createdAt: partialDashboard.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                widgets: partialDashboard.widgets || [],
                layout: partialDashboard.layout || [],
                filters: partialDashboard.filters || [],
                queries: partialDashboard.queries || [],
            });
        }
    }, [partialDashboard, setDashboard]);

    // Get current widgets and layout
    const widgets = useMemo(() => {
        if (!dashboard?.widgets) return [];
        return dashboard.widgets.map((w) => ({
            ...w,
            ...(localWidgets.get(w.id) || {}),
        }));
    }, [dashboard?.widgets, localWidgets]);

    const layout = useMemo(() => {
        return localLayout || dashboard?.layout || [];
    }, [localLayout, dashboard?.layout]);

    const handleSave = useCallback(async () => {
        console.log("Saving dashboard...");
        markClean();
    }, [markClean]);

    const getWidgetData = useCallback((widgetId: string) => {
        const streamResults = partialResults.get(`q_${widgetId}`) || partialResults.get(widgetId);
        if (streamResults) return streamResults;
        const query = dashboard?.queries.find(q => q.widgetIds.includes(widgetId));
        if (query?.id && partialResults.has(query.id)) {
            return partialResults.get(query.id);
        }
        return undefined;
    }, [dashboard?.queries, partialResults]);

    return (
        <div className={styles.studio}>
            {/* Top Navigation Bar - AntD Pro style */}
            <header className={styles.navBar}>
                <div className={styles.navLeft}>
                    <div className={styles.logo}>
                        <Share size={18} className={styles.logoIcon} />
                        <span>AutoDash AI</span>
                    </div>
                    <div className={styles.breadcrumbs}>
                        <span className={styles.breadcrumbItem}>Workspaces</span>
                        <ChevronDown size={14} />
                        <span className={styles.breadcrumbItem}>Sales Team</span>
                        <ChevronDown size={14} />
                        <span className={`${styles.breadcrumbItem} ${styles.active}`}>Q3 Performance</span>
                    </div>
                </div>

                <div className={styles.navRight}>
                    <div className={styles.modeToggle}>
                        <button
                            className={`${styles.navButton} ${isEditing ? styles.active : ""}`}
                            onClick={() => setIsEditing(true)}
                        >
                            Design
                        </button>
                        <button
                            className={`${styles.navButton} ${!isEditing ? styles.active : ""}`}
                            onClick={() => setIsEditing(false)}
                        >
                            Preview
                        </button>
                    </div>
                    <button className={styles.navButton}>
                        <Share size={16} />
                        <span>Share</span>
                    </button>
                    <button className={`${styles.navButton} ${styles.debugOn}`}>
                        <Terminal size={16} />
                        <span>Debug: ON</span>
                    </button>
                    <div className={styles.userAvatar} />
                </div>
            </header>

            <div className={styles.contentLayout}>
                {/* Left Panel - Filters */}
                <AnimatePresence>
                    {leftPanelOpen && (
                        <motion.aside
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: 280, opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            className={styles.leftPanel}
                        >
                            <div className={styles.panelHeader}>
                                <h3>Filters</h3>
                                <button className={styles.resetButton}>Reset All</button>
                            </div>
                            <div className={styles.panelContent}>
                                {dashboard && <FilterBar filters={dashboard.filters} />}
                                <button className={styles.applyFiltersBtn}>Apply Filters</button>
                            </div>
                        </motion.aside>
                    )}
                </AnimatePresence>

                {/* Main Content Area */}
                <main className={styles.main}>
                    {/* Dashboard Header Section */}
                    <div className={styles.dashboardHeader}>
                        <div className={styles.headerControls}>
                            <button
                                className={styles.panelToggle}
                                onClick={() => setLeftPanelOpen(!leftPanelOpen)}
                            >
                                {leftPanelOpen ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
                            </button>
                        </div>
                        <div className={styles.titleArea}>
                            <h1 className={styles.dashboardTitle}>{dashboard?.name || "Sales Performance Dashboard"}</h1>
                            <p className={styles.dashboardMeta}>
                                Real-time data aggregated from Postgres Production DB
                                <span className={styles.lastUpdated}>Last updated: 10:42 AM</span>
                            </p>
                        </div>
                        <div className={styles.headerActions}>
                            <button
                                className={styles.panelToggle}
                                onClick={() => setRightPanelOpen(!rightPanelOpen)}
                            >
                                {rightPanelOpen ? <PanelRightClose size={18} /> : <PanelRight size={18} />}
                            </button>
                        </div>
                    </div>

                    {/* Canvas Area */}
                    <div className={styles.canvasWrapper}>
                        {isLoading ? (
                            <DashboardCanvasSkeleton />
                        ) : (
                            <DashboardCanvas
                                widgets={widgets}
                                layout={layout}
                                isEditing={isEditing}
                                onLayoutChange={useEditorStore.getState().updateLayout}
                                onWidgetClick={(id) => isEditing && selectWidget(id)}
                                getWidgetData={getWidgetData}
                            />
                        )}
                    </div>
                </main>

                {/* Right Panel - Debugger */}
                <AnimatePresence>
                    {rightPanelOpen && (
                        <motion.aside
                            initial={{ width: 0, opacity: 0 }}
                            animate={{ width: 380, opacity: 1 }}
                            exit={{ width: 0, opacity: 0 }}
                            className={styles.rightPanel}
                        >
                            <DebugDrawer
                                dashboard={dashboard}
                                selectedWidgetId={selectedWidgetId}
                            />
                        </motion.aside>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}

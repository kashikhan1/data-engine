"use client";

import React, { useCallback, useState, useMemo } from "react";
import GridLayout from "react-grid-layout";
import { motion } from "framer-motion";
import { Maximize2, Minimize2, Sparkles, Database } from "lucide-react";
import { useEditorStore, useDashboardStore, useRunStore, useWorkflowStore, useConfigStore, useUIStore } from "@/state/stores";
import { WidgetRenderer } from "../widgets/WidgetRenderer";
import { AgentTimeline } from "../chat/AgentTimeline";
import AiInsightsWidget from "../studio/widgets/AiInsightsWidget";
import type { WidgetSpec, LayoutItem } from "@/types/dashboard";
import styles from "./DashboardCanvas.module.css";

// Import grid styles
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";

interface DashboardCanvasProps {
    widgets: WidgetSpec[];
    layout: LayoutItem[];
    isEditing?: boolean;
    onLayoutChange?: (layout: LayoutItem[]) => void;
    onWidgetClick?: (widgetId: string) => void;
    getWidgetData?: (widgetId: string) => any[] | undefined;
    getWidgetMeta?: (widgetId: string) => { totalRows?: number } | undefined;
}

const GRID_COLS = 12;
const ROW_HEIGHT = 40;
const MARGIN: [number, number] = [12, 12];

export function DashboardCanvas({
    widgets,
    layout,
    isEditing = false,
    onLayoutChange,
    onWidgetClick,
    getWidgetData,
    getWidgetMeta,
}: DashboardCanvasProps) {
    const [containerWidth, setContainerWidth] = useState(1200);
    const [isFullscreen, setIsFullscreen] = useState(false);

    const {
        selectedWidgetId,
        selectWidget,
        setDragging,
        setResizing,
        saveToUndoStack,
        updateLayout,
    } = useEditorStore();

    const { dashboard, activeFilters } = useDashboardStore();
    const { isStreaming, steps } = useRunStore();
    const { setStep, schemaData } = useWorkflowStore();
    const { dataSources, selectedDataSourceId, connectionStatus } = useConfigStore();
    const { setCurrentView } = useUIStore();

    const hasConnectedSqlSource = useMemo(() => {
        const selected = dataSources.find((ds) => ds.id === selectedDataSourceId);
        const connectedSql = (selected ? [selected] : dataSources).find((ds) => {
            const type = String(ds?.type || "").toLowerCase();
            const isSql = type.includes("postgres") || type.includes("mssql") || type.includes("sql");
            return isSql && String(ds?.status || "").toLowerCase() === "connected";
        });
        if (connectedSql) return true;
        return connectionStatus === "Connected";
    }, [dataSources, selectedDataSourceId, connectionStatus]);

    const hasSchema = useMemo(() => {
        if (!schemaData) return false;
        const tables = Array.isArray(schemaData?.tables) ? schemaData.tables : [];
        if (tables.length > 0) return true;
        const schemaInfo = schemaData?.schemaInfo;
        return !!schemaInfo && Object.keys(schemaInfo).length > 0;
    }, [schemaData]);

    const handleSetupRouting = useCallback(() => {
        if (!hasConnectedSqlSource) {
            setCurrentView("data-sources");
            return;
        }
        setCurrentView("schema");
        setStep(1);
    }, [hasConnectedSqlSource, setCurrentView, setStep]);

    const gridLayout = useMemo(() => {
        return layout.map((item) => {
            if (!item) return { i: "err", x: 0, y: 0, w: 2, h: 2 };
            return {
                i: item.i,
                x: item.x,
                y: item.y,
                w: item.w,
                h: item.h,
                minW: item.minW || 2,
                minH: item.minH || 2,
                maxW: item.maxW,
                maxH: item.maxH,
                static: item.static || !isEditing,
            };
        });
    }, [layout, isEditing]);

    // Handle layout changes
    const handleLayoutChange = useCallback(
        (newLayout: any[]) => {
            if (!Array.isArray(newLayout)) return;
            const converted: LayoutItem[] = newLayout
                .filter(item => !!item)
                .map((item) => ({
                    i: String(item.i),
                    x: Number(item.x) || 0,
                    y: Number(item.y) || 0,
                    w: Number(item.w) || 2,
                    h: Number(item.h) || 2,
                }));
            updateLayout(converted);
            onLayoutChange?.(converted);
        },
        [updateLayout, onLayoutChange]
    );

    // Drag handlers
    const handleDragStart = useCallback(() => {
        saveToUndoStack(layout);
        setDragging(true);
    }, [saveToUndoStack, setDragging, layout]);

    const handleDragStop = useCallback(() => {
        setDragging(false);
    }, [setDragging]);

    // Resize handlers
    const handleResizeStart = useCallback(() => {
        saveToUndoStack(layout);
        setResizing(true);
    }, [saveToUndoStack, setResizing, layout]);

    const handleResizeStop = useCallback(() => {
        setResizing(false);
    }, [setResizing]);

    // Widget click handler
    const handleWidgetClick = useCallback(
        (widgetId: string, e: React.MouseEvent) => {
            e.stopPropagation();
            if (isEditing) {
                selectWidget(widgetId);
            }
            onWidgetClick?.(widgetId);
        },
        [isEditing, selectWidget, onWidgetClick]
    );

    // Canvas click (deselect)
    const handleCanvasClick = useCallback(() => {
        if (isEditing) {
            selectWidget(null);
        }
    }, [isEditing, selectWidget]);

    // Container ref for width measurement
    const containerRef = useCallback((node: HTMLDivElement | null) => {
        if (node) {
            const observer = new ResizeObserver((entries) => {
                for (const entry of entries) {
                    setContainerWidth(entry.contentRect.width);
                }
            });
            observer.observe(node);
            return () => observer.disconnect();
        }
    }, []);

    return (
        <div
            ref={containerRef}
            className={`${styles.container} ${isFullscreen ? styles.fullscreen : ""}`}
            onClick={handleCanvasClick}
        >
            {/* Canvas Grid Background Overlay */}
            <div className={`absolute inset-0 grid-bg opacity-20 pointer-events-none`} />

            {/* Header Actions */}
            <div className={styles.canvasHeader}>
                <button
                    className={styles.iconButton}
                    onClick={() => setIsFullscreen(!isFullscreen)}
                    title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
                >
                    {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
                </button>
            </div>

            {/* Grid Layout */}
            <div className={styles.gridWrapper}>
                {widgets.length > 0 ? (
                    <div className="flex flex-col gap-6">
                        <div className="px-4">
                            <AiInsightsWidget insights={dashboard?.insights} />
                        </div>
                        <GridLayout {...({
                            className: styles.grid,
                            layout: gridLayout,
                            cols: GRID_COLS,
                            rowHeight: ROW_HEIGHT,
                            width: containerWidth - 32,
                            margin: MARGIN,
                            containerPadding: [0, 0],
                            isDraggable: isEditing,
                            isResizable: isEditing,
                            onLayoutChange: handleLayoutChange,
                            onDragStart: handleDragStart,
                            onDragStop: handleDragStop,
                            onResizeStart: handleResizeStart,
                            onResizeStop: handleResizeStop,
                            draggableHandle: ".widget-drag-handle"
                        } as any)}>
                            {widgets.map((widget) => (
                                <div
                                    key={widget.id}
                                    className={`${styles.widgetWrapper} ${selectedWidgetId === widget.id ? styles.selected : ""
                                        }`}
                                    onClick={(e) => handleWidgetClick(widget.id, e)}
                                >
                                    <WidgetRenderer
                                        widget={widget}
                                        isEditing={isEditing}
                                        isSelected={selectedWidgetId === widget.id}
                                        filters={Object.fromEntries(activeFilters)}
                                        data={getWidgetData?.(widget.id)}
                                        meta={getWidgetMeta?.(widget.id)}
                                    />
                                </div>
                            ))}
                        </GridLayout>
                    </div>
                ) : (
                    <div className={styles.emptyState}>
                        {/* Chat-first setup state */}
                        <div className={styles.searchContainer}>
                            <div className={styles.searchBox}>
                                <div className={styles.searchIcon}>
                                    <Sparkles size={24} />
                                </div>
                                <div className={styles.searchInputWrapper}>
                                    <div className="text-left">
                                        <h3 className="text-[18px] font-black tracking-tight text-white">
                                            Agent Pipeline Is Chat-Driven
                                        </h3>
                                        <p className="mt-2 text-sm text-slate-400">
                                            Use the chat panel to run the pipeline. We’ll route setup based on your connection state.
                                        </p>
                                    </div>
                                    <div className="mt-5 flex items-center gap-3">
                                        <button className={styles.actionChip} onClick={handleSetupRouting}>
                                            <Database size={16} className={`${styles.actionIcon} ${styles.green}`} />
                                            <span>{hasConnectedSqlSource ? "Open Schema Discovery" : "Open Data Sources"}</span>
                                        </button>
                                        {hasConnectedSqlSource && hasSchema && (
                                            <span className="text-xs text-slate-500">Schema detected. You can start from chat anytime.</span>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Agent Timeline during generation */}
                        {isStreaming && (
                            <div className={styles.timelineWrapper}>
                                <AgentTimeline steps={steps} isStreaming={isStreaming} />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// Skeleton loader for when dashboard is loading
export function DashboardCanvasSkeleton() {
    return (
        <div className={styles.container}>
            <div className={styles.skeletonGrid}>
                {[1, 2, 3, 4].map((i) => (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: i * 0.1 }}
                        className={styles.skeletonWidget}
                    >
                        <div className={styles.skeletonHeader} />
                        <div className={styles.skeletonChart} />
                    </motion.div>
                ))}
            </div>
        </div>
    );
}

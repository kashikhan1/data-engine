"use client";

import React from "react";
import {
    Settings,
    Database,
    Zap,
    X,
    Type,
    AlignLeft,
    BarChart3,
    Palette,
    MousePointer,
    Lock,
    Unlock,
    RefreshCw,
    Trash2
} from "lucide-react";
import { useEditorStore } from "@/state/stores";
import type { WidgetSpec, WidgetType } from "@/types/dashboard";
import styles from "./Inspector.module.css";

interface InspectorPanelProps {
    widget: WidgetSpec | null;
    onUpdate: (id: string, updates: Partial<WidgetSpec>) => void;
    onDelete: (id: string) => void;
    onRegenerate: (id: string) => void;
}

const WIDGET_TYPE_OPTIONS: { value: WidgetType; label: string }[] = [
    { value: "kpi", label: "KPI Card" },
    { value: "line", label: "Line Chart" },
    { value: "area", label: "Area Chart" },
    { value: "bar", label: "Bar Chart" },
    { value: "pie", label: "Pie Chart" },
    { value: "donut", label: "Donut Chart" },
    { value: "table", label: "Table" },
    { value: "cohort", label: "Cohort Table" },
    { value: "funnel", label: "Funnel Analysis" },
    { value: "map", label: "Geographic Map" },
    { value: "scatter", label: "Scatter Plot" },
];

export function InspectorPanel({ widget, onUpdate, onDelete, onRegenerate }: InspectorPanelProps) {
    const { inspectorTab, setInspectorTab, selectWidget } = useEditorStore();

    if (!widget) {
        return (
            <div className={styles.container}>
                <div className={styles.empty}>
                    <Settings size={32} />
                    <p>Select a widget to edit its properties</p>
                </div>
            </div>
        );
    }

    const handleChange = (field: string, value: any) => {
        onUpdate(widget.id, { [field]: value });
    };

    const handleEncodingChange = (axis: "x" | "y", field: string, value: any) => {
        onUpdate(widget.id, {
            encoding: {
                ...widget.encoding,
                [axis]: {
                    ...widget.encoding?.[axis],
                    [field]: value,
                },
            },
        });
    };

    const toggleLock = () => {
        onUpdate(widget.id, {
            ui: {
                ...widget.ui,
                locked: !widget.ui?.locked,
            },
        });
    };

    return (
        <div className={styles.container}>
            {/* Header */}
            <div className={styles.header}>
                <h3>Widget Properties</h3>
                <button className={styles.closeButton} onClick={() => selectWidget(null)}>
                    <X size={16} />
                </button>
            </div>

            {/* Tabs */}
            <div className={styles.tabs}>
                <button
                    className={`${styles.tab} ${inspectorTab === "properties" ? styles.active : ""}`}
                    onClick={() => setInspectorTab("properties")}
                >
                    <Settings size={14} />
                    <span>Properties</span>
                </button>
                <button
                    className={`${styles.tab} ${inspectorTab === "data" ? styles.active : ""}`}
                    onClick={() => setInspectorTab("data")}
                >
                    <Database size={14} />
                    <span>Data</span>
                </button>
                <button
                    className={`${styles.tab} ${inspectorTab === "interactions" ? styles.active : ""}`}
                    onClick={() => setInspectorTab("interactions")}
                >
                    <Zap size={14} />
                    <span>Actions</span>
                </button>
            </div>

            {/* Content */}
            <div className={styles.content}>
                {inspectorTab === "properties" && (
                    <>
                        {/* Title */}
                        <div className={styles.field}>
                            <label>
                                <Type size={14} />
                                <span>Title</span>
                            </label>
                            <input
                                type="text"
                                value={widget.title}
                                onChange={(e) => handleChange("title", e.target.value)}
                                className={styles.input}
                            />
                        </div>

                        {/* Description */}
                        <div className={styles.field}>
                            <label>
                                <AlignLeft size={14} />
                                <span>Description</span>
                            </label>
                            <textarea
                                value={widget.description || ""}
                                onChange={(e) => handleChange("description", e.target.value)}
                                className={styles.textarea}
                                rows={2}
                                placeholder="Optional description..."
                            />
                        </div>

                        {/* Chart Type */}
                        <div className={styles.field}>
                            <label>
                                <BarChart3 size={14} />
                                <span>Chart Type</span>
                            </label>
                            <select
                                value={widget.type}
                                onChange={(e) => handleChange("type", e.target.value)}
                                className={styles.select}
                            >
                                {WIDGET_TYPE_OPTIONS.map((opt) => (
                                    <option key={opt.value} value={opt.value}>
                                        {opt.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        {/* Encoding (for charts) */}
                        {!["kpi", "table"].includes(widget.type) && (
                            <>
                                <div className={styles.sectionTitle}>Encoding</div>

                                <div className={styles.fieldRow}>
                                    <div className={styles.field}>
                                        <label>X Axis Field</label>
                                        <input
                                            type="text"
                                            value={widget.encoding?.x?.field || ""}
                                            onChange={(e) => handleEncodingChange("x", "field", e.target.value)}
                                            className={styles.input}
                                            placeholder="date, category..."
                                        />
                                    </div>
                                    <div className={styles.field}>
                                        <label>Y Axis Field</label>
                                        <input
                                            type="text"
                                            value={widget.encoding?.y?.field || ""}
                                            onChange={(e) => handleEncodingChange("y", "field", e.target.value)}
                                            className={styles.input}
                                            placeholder="value, count..."
                                        />
                                    </div>
                                </div>
                            </>
                        )}
                    </>
                )}

                {inspectorTab === "data" && (
                    <>
                        <div className={styles.field}>
                            <label>
                                <Database size={14} />
                                <span>Query ID</span>
                            </label>
                            <input
                                type="text"
                                value={widget.queryId || ""}
                                disabled
                                className={`${styles.input} ${styles.disabled}`}
                            />
                        </div>

                        <div className={styles.infoBox}>
                            <p>This widget is bound to a query generated by the AI. To change the data source, regenerate the widget with a new prompt.</p>
                        </div>
                    </>
                )}

                {inspectorTab === "interactions" && (
                    <>
                        <div className={styles.field}>
                            <label>
                                <MousePointer size={14} />
                                <span>On Click Action</span>
                            </label>
                            <select
                                value={widget.interactions?.onClick || "none"}
                                onChange={(e) => handleChange("interactions", { ...widget.interactions, onClick: e.target.value })}
                                className={styles.select}
                            >
                                <option value="none">None</option>
                                <option value="filter">Filter Other Widgets</option>
                                <option value="drilldown">Drill Down</option>
                                <option value="link">Open Link</option>
                            </select>
                        </div>

                        <div className={styles.sectionTitle}>Lock & Protect</div>

                        <button
                            className={`${styles.toggleButton} ${widget.ui?.locked ? styles.active : ""}`}
                            onClick={toggleLock}
                        >
                            {widget.ui?.locked ? (
                                <>
                                    <Lock size={14} />
                                    <span>Widget Locked</span>
                                </>
                            ) : (
                                <>
                                    <Unlock size={14} />
                                    <span>Lock Widget</span>
                                </>
                            )}
                        </button>
                        <p className={styles.hint}>Locked widgets won't be changed by AI regeneration</p>
                    </>
                )}
            </div>

            {/* Actions */}
            <div className={styles.actions}>
                <button
                    className={styles.actionButton}
                    onClick={() => onRegenerate(widget.id)}
                >
                    <RefreshCw size={14} />
                    <span>Regenerate</span>
                </button>
                <button
                    className={`${styles.actionButton} ${styles.danger}`}
                    onClick={() => onDelete(widget.id)}
                >
                    <Trash2 size={14} />
                    <span>Delete</span>
                </button>
            </div>
        </div>
    );
}

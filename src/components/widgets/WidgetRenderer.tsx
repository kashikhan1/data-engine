"use client";

import React, { useMemo } from "react";
import dynamic from "next/dynamic";
import {
    GripVertical,
    MoreHorizontal,
    Maximize2,
    RefreshCw,
    Info,
    Lock,
    AlertCircle,
    CheckCircle2
} from "lucide-react";
import type { WidgetSpec } from "@/types/dashboard";
import { KPIWidget } from "./KPIWidget";
import { TableWidget } from "./TableWidget";
import { CohortWidget } from "./CohortWidget";
import { FunnelWidget } from "./FunnelWidget";
import { MapWidget } from "./MapWidget";
import { ScatterWidget } from "./ScatterWidget";
import styles from "./Widget.module.css";

// Dynamic import for Vega-Lite to avoid SSR issues
const VegaLite = dynamic(() => import("react-vega").then((mod) => mod.VegaLite), {
    ssr: false,
    loading: () => <div className={styles.chartLoading}>Loading chart...</div>,
});

interface WidgetRendererProps {
    widget: WidgetSpec;
    isEditing?: boolean;
    isSelected?: boolean;
    filters?: Record<string, any>;
    data?: any[];
    meta?: { totalRows?: number };
    onDrilldown?: (selection: any) => void;
    onRegenerate?: () => void;
}

export function WidgetRenderer({
    widget,
    isEditing = false,
    isSelected = false,
    filters = {},
    data,
    meta,
    onDrilldown,
    onRegenerate,
}: WidgetRendererProps) {
    const isLoading = widget.ui?.loading;
    const hasError = widget.ui?.error;
    const isLocked = widget.ui?.locked;

    // Get chart data
    const chartData = useMemo(() => {
        // Prioritize explicit data prop, then widget-embedded data
        const activeData = data || widget.data;

        const coerceNumber = (val: any) => {
            if (typeof val === 'number') return val;
            if (typeof val === 'string' && val.trim() !== '' && !isNaN(Number(val))) return Number(val);
            return val;
        };

        const normalizeRows = (rows: any[]) =>
            rows.map((row) => {
                const normalized: Record<string, any> = {};
                Object.entries(row || {}).forEach(([k, v]) => {
                    normalized[k] = coerceNumber(v);
                });
                return normalized;
            });

        // If we have data and it's not empty, normalize numeric-like strings to numbers.
        if (activeData && Array.isArray(activeData) && activeData.length > 0) {
            return { table: normalizeRows(activeData) };
        }

        // Explicitly return empty if data was provided but is empty (avoids mock data jitter)
        if (data !== undefined) {
            return { table: normalizeRows(activeData || []) };
        }

        // Default mock data based on widget type
        switch (widget.type) {
            case "kpi":
                return { table: [{ value: 1234, delta: 12.5 }] };
            case "line":
            case "area":
                return {
                    table: [
                        { date: "2024-01", value: 400 },
                        { date: "2024-02", value: 450 },
                        { date: "2024-03", value: 420 },
                        { date: "2024-04", value: 520 },
                        { date: "2024-05", value: 580 },
                        { date: "2024-06", value: 610 },
                    ],
                };
            case "bar":
                return {
                    table: [
                        { category: "Electronics", value: 1200 },
                        { category: "Apparel", value: 850 },
                        { category: "Home", value: 650 },
                        { category: "Sports", value: 420 },
                    ],
                };
            case "pie":
            case "donut":
                return {
                    table: [
                        { category: "Mobile", value: 45 },
                        { category: "Desktop", value: 35 },
                        { category: "Tablet", value: 20 },
                    ],
                };
            case "cohort":
                return {
                    table: [
                        { cohort: "2024-01-01", period: 0, value: 1.0 },
                        { cohort: "2024-01-01", period: 1, value: 0.8 },
                        { cohort: "2024-01-01", period: 2, value: 0.75 },
                        { cohort: "2024-01-08", period: 0, value: 1.0 },
                        { cohort: "2024-01-08", period: 1, value: 0.85 },
                    ]
                };
            case "funnel":
                return {
                    table: [
                        { step: "Visit", value: 1000 },
                        { step: "Sign Up", value: 400 },
                        { step: "Purchase", value: 120 },
                    ]
                };
            case "map":
                return {
                    table: [
                        { region: "US", value: 1000 },
                        { region: "PK", value: 850 },
                        { region: "GB", value: 620 },
                    ]
                };
            case "scatter":
                return {
                    table: [
                        { price: 10, quantity: 100 },
                        { price: 20, quantity: 80 },
                        { price: 30, quantity: 60 },
                        { price: 40, quantity: 40 },
                    ]
                };
            case "table":
                return {
                    table: [
                        { id: 1, name: "Sample Item", value: 100, status: "Active" },
                        { id: 2, name: "Another Item", value: 200, status: "Pending" },
                    ]
                };
            default:
                return { table: [] };
        }
    }, [data, widget.type]);

    // Helper to find best matching keys in data
    const getBestFields = (row: any) => {
        if (!row) return { x: 'category', y: 'value' };
        const keys = Object.keys(row);
        const y = keys.find(k => typeof row[k] === 'number') || 'value';
        const x = keys.find(k => k !== y && !['id', 'key', '__rowKey'].includes(k)) || 'category';
        return { x, y };
    };

    const formatFieldLabel = (field?: string) => {
        if (!field) return "";
        return field
            .replace(/_/g, " ")
            .replace(/\b\w/g, (m) => m.toUpperCase());
    };

    // Generate Vega-Lite spec if not provided
    const vegaSpec = useMemo(() => {
        if (widget.vegaSpec) return widget.vegaSpec;

        const row = chartData.table?.[0];
        const smartFields = getBestFields(row);

        const baseConfig = {
            $schema: "https://vega.github.io/schema/vega-lite/v5.json",
            width: "container",
            height: "container",
            padding: 0,
            autosize: { type: "fit", contains: "padding" },
            data: { name: "table" },
            background: "transparent",
            config: {
                background: "transparent",
                view: { stroke: "transparent" },
                font: "'Outfit', 'Inter', sans-serif",
                axis: {
                    domain: false,
                    ticks: false,
                    labelColor: "rgba(226, 232, 240, 0.7)",
                    labelFontSize: 11,
                    labelFontWeight: "bold",
                    titleColor: "rgba(226, 232, 240, 0.5)",
                    titleFontSize: 11,
                    titleFontWeight: "bold",
                    titlePadding: 15,
                    gridColor: "rgba(148, 163, 184, 0.15)",
                    gridDash: [4, 4],
                },
                legend: {
                    labelColor: "rgba(226, 232, 240, 0.7)",
                    titleColor: "rgba(226, 232, 240, 0.9)",
                    labelFontSize: 11,
                    titleFontSize: 11,
                    symbolType: "circle",
                    orient: "top",
                    padding: 20
                },
                range: {
                    category: [
                        "#135bec", // Power Blue
                        "#4f46e5", // Indigo
                        "#7c3aed", // Purple
                        "#ec4899", // Pink
                        "#f97316", // Orange
                        "#eab308", // Yellow
                        "#22c55e", // Green
                        "#06b6d4", // Cyan
                    ]
                }
            },
        };

        // Determine effective fields (Plan encoding OR Smart detection)
        const xField = widget.encoding?.x?.field && row && (widget.encoding.x.field in row)
            ? widget.encoding.x.field
            : smartFields.x;

        const yField = widget.encoding?.y?.field && row && (widget.encoding.y.field in row)
            ? widget.encoding.y.field
            : smartFields.y;

        const xTitle = formatFieldLabel(xField);
        const yTitle = formatFieldLabel(yField);

        switch (widget.type) {
            case "line":
                return {
                    ...baseConfig,
                    layer: [
                        {
                            mark: {
                                type: "line",
                                interpolate: "monotone",
                                strokeWidth: 3,
                                color: "#135bec",
                                shadow: { blur: 10, color: "rgba(19, 91, 236, 0.4)" }
                            }
                        },
                        {
                            mark: {
                                type: "point",
                                filled: true,
                                size: 80,
                                fill: "#135bec",
                                stroke: "#fff",
                                strokeWidth: 2
                            }
                        }
                    ],
                    encoding: {
                        x: { field: xField, type: widget.encoding?.x?.type || "ordinal", axis: { title: xTitle } },
                        y: { field: yField, type: "quantitative", axis: { title: yTitle } },
                        tooltip: [
                            { field: xField, type: widget.encoding?.x?.type || "ordinal", title: xTitle },
                            { field: yField, type: "quantitative", title: yTitle }
                        ]
                    },
                };

            case "area":
                return {
                    ...baseConfig,
                    mark: {
                        type: "area",
                        interpolate: "monotone",
                        line: { stroke: "#135bec", strokeWidth: 3 },
                        color: {
                            x1: 1,
                            y1: 1,
                            x2: 1,
                            y2: 0,
                            gradient: "linear",
                            stops: [
                                { offset: 0, color: "rgba(19, 91, 236, 0.4)" },
                                { offset: 1, color: "rgba(19, 91, 236, 0.02)" },
                            ],
                        },
                    },
                    encoding: {
                        x: {
                            field: xField,
                            type: widget.encoding?.x?.type || "ordinal",
                            axis: { labelAngle: 0, tickCount: 5, title: xTitle }
                        },
                        y: {
                            field: yField,
                            type: "quantitative",
                            axis: { grid: true, title: yTitle }
                        },
                        tooltip: [
                            { field: xField, type: widget.encoding?.x?.type || "ordinal", title: xTitle },
                            { field: yField, type: "quantitative", title: yTitle }
                        ]
                    },
                };

            case "bar":
                return {
                    ...baseConfig,
                    mark: {
                        type: "bar",
                        cornerRadiusTop: 10,
                        fill: {
                            x1: 1, y1: 1, x2: 1, y2: 0,
                            gradient: "linear",
                            stops: [
                                { offset: 0, color: "rgba(19, 91, 236, 0.8)" },
                                { offset: 1, color: "rgba(79, 70, 229, 0.8)" }
                            ]
                        }
                    },
                    encoding: {
                        x: {
                            field: xField,
                            type: "nominal",
                            axis: { labelAngle: -30, title: xTitle },
                            sort: "-y",
                        },
                        y: {
                            field: yField,
                            type: "quantitative",
                            axis: { title: yTitle }
                        }
                    },
                };

            case "pie":
            case "donut":
                return {
                    ...baseConfig,
                    mark: {
                        type: "arc",
                        innerRadius: widget.type === "donut" ? 60 : 0,
                        stroke: "#0d1117",
                        strokeWidth: 2,
                        cornerRadius: 4
                    },
                    encoding: {
                        theta: {
                            field: yField,
                            type: "quantitative",
                        },
                        color: {
                            field: xField,
                            type: "nominal",
                            legend: { orient: "right", title: xTitle }
                        },
                        tooltip: [
                            { field: xField, type: "nominal", title: xTitle },
                            { field: yField, type: "quantitative", title: yTitle }
                        ]
                    },
                };

            default:
                return null;
        }
    }, [widget, chartData]);

    // Render widget content based on type
    const renderContent = () => {
        if (isLoading) {
            return (
                <div className={styles.loading}>
                    <div className={styles.spinner} />
                    <span>Loading...</span>
                </div>
            );
        }

        if (hasError) {
            return (
                <div className={styles.error}>
                    <AlertCircle size={24} />
                    <span>{widget.ui?.error}</span>
                </div>
            );
        }

        // Smart KPI Value Detection
        const getKpiValue = () => {
            const row = chartData.table?.[0];
            if (!row) return 0;
            const coerceNumber = (val: any) => {
                if (typeof val === 'number') return val;
                if (typeof val === 'string' && val.trim() !== '' && !isNaN(Number(val))) return Number(val);
                return null;
            };
            const valueFromValueField = widget.kpiConfig?.valueField && widget.kpiConfig.valueField in row
                ? coerceNumber((row as any)[widget.kpiConfig.valueField])
                : null;
            if (valueFromValueField !== null) return valueFromValueField;

            if ('value' in row) {
                const coerced = coerceNumber((row as any).value);
                if (coerced !== null) return coerced;
            }

            // Fallback: First numeric value
            for (const v of Object.values(row)) {
                const coerced = coerceNumber(v);
                if (coerced !== null) return coerced;
            }
            return 0;
        };

        switch (widget.type) {
            case "kpi":
                return (
                    <KPIWidget
                        title={widget.title}
                        value={getKpiValue()}
                        delta={chartData.table[0]?.delta}
                        config={widget.kpiConfig}
                    />
                );

            case "table":
                return (
                    <TableWidget
                        data={chartData.table}
                        columns={widget.tableConfig?.columns || []}
                        widgetId={widget.id}
                        respectColumnToggles={true}
                        totalRows={meta?.totalRows}
                    />
                );

            case "cohort":
                return (
                    <CohortWidget
                        data={chartData.table as any}
                        valueFormat="percent"
                        periodLabel="Week"
                    />
                );

            case "funnel":
                return (
                    <FunnelWidget
                        data={chartData.table as any}
                        showConversionRates={true}
                        showDropoff={true}
                    />
                );

            case "map":
                return (
                    <MapWidget
                        data={chartData.table as any}
                        mapType="bubble"
                        valueFormat="number"
                    />
                );

            case "scatter":
                return (
                    <ScatterWidget
                        data={chartData.table as any}
                        xLabel={widget.encoding?.x?.field || "X"}
                        yLabel={widget.encoding?.y?.field || "Y"}
                        showTrendline={true}
                    />
                );

            case "line":
            case "area":
            case "bar":
            case "pie":
            case "donut":
                if (!chartData.table || chartData.table.length === 0) {
                    return <div className={styles.noData}>No data to display</div>;
                }
                if (!vegaSpec) return <div className={styles.noData}>No chart configuration</div>;
                return (
                    <VegaLite
                        spec={vegaSpec as any}
                        data={chartData}
                        actions={false}
                        className={styles.chart}
                    />
                );

            default:
                return <div className={styles.noData}>Unsupported widget type: {widget.type}</div>;
        }
    };

    return (
        <div className={styles.widget}>
            {/* Header */}
            <div className={styles.header}>
                {isEditing && (
                    <div className={`${styles.dragHandle} widget-drag-handle`}>
                        <GripVertical size={14} />
                    </div>
                )}

                <div className={styles.titleSection}>
                    <h3 className={styles.title}>{widget.title}</h3>
                    {widget.goal && <span className={styles.subtitle}>{widget.goal}</span>}
                </div>
                {isLocked && <Lock size={12} className={styles.lockIcon} />}

                <div className={styles.actions}>
                    {isEditing && onRegenerate && (
                        <button className={styles.actionButton} onClick={onRegenerate} title="Regenerate">
                            <RefreshCw size={14} />
                        </button>
                    )}
                    <button className={styles.actionButton} title="Widget Info">
                        <Info size={14} />
                    </button>
                    <button className={styles.actionButton} title="Expand">
                        <Maximize2 size={14} />
                    </button>
                    <button className={styles.actionButton} title="More">
                        <MoreHorizontal size={14} />
                    </button>
                </div>
            </div>

            {/* Content */}
            <div className={styles.content}>
                {renderContent()}
            </div>

            {/* Insight (if available) */}
            {widget.insight && (
                <div className={styles.insight}>
                    <CheckCircle2 size={12} />
                    <span>{widget.insight}</span>
                </div>
            )}
        </div>
    );
}

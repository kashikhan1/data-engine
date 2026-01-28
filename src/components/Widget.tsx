"use client";

import React from "react";
import dynamic from "next/dynamic";
import styles from "../app/page.module.css";
import { Maximize2, MoreHorizontal } from "lucide-react";

// Use dynamic import for VegaLite to avoid SSR and potential React 19 serialization issues
const VegaLite = dynamic(() => import("react-vega").then(mod => mod.VegaLite), {
    ssr: false,
    loading: () => <div style={{ height: "150px", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted-foreground)" }}>Loading...</div>
});

interface WidgetProps {
    title: string;
    type: string;
    data?: any;
    spec?: any;
}

export const Widget: React.FC<WidgetProps> = ({ title, type, data, spec }) => {
    // Default Vega-Lite spec if none provided
    const config = {
        background: "transparent",
        view: { stroke: "transparent" },
        axis: {
            domain: false,
            ticks: false,
            labelColor: "#94a3b8",
            gridColor: "rgba(255,255,255,0.05)",
            title: null
        }
    };

    const finalSpec: any = spec ? {
        ...spec,
        width: "container",
        padding: spec.padding ?? 10,
        config: { ...config, ...spec.config }
    } : {
        width: "container",
        height: 150,
        autosize: { type: "fit", contains: "padding" },
        mark: type === "line" ? { type: "line", interpolate: "monotone", color: "#6366f1", strokeWidth: 3 } : { type: "bar", color: "#6366f1", cornerRadiusTop: 4 },
        encoding: {
            x: { field: "name", type: "nominal", axis: { labelAngle: 0 } },
            y: { field: "value", type: "quantitative" },
        },
        config
    };

    const chartData = {
        table: data || [
            { name: "Week 1", value: 45 },
            { name: "Week 2", value: 52 },
            { name: "Week 3", value: 48 },
            { name: "Week 4", value: 61 },
        ]
    };

    return (
        <div className={styles.widgetCard}>
            <div className={styles.widgetHeader}>
                <span className={styles.widgetTitle}>{title}</span>
                <div style={{ display: 'flex', gap: '8px' }}>
                    <Maximize2 size={14} className="text-muted-foreground" />
                    <MoreHorizontal size={14} className="text-muted-foreground" />
                </div>
            </div>

            {type === "kpi" ? (
                <div className={styles.widgetValue}>
                    {chartData.table[chartData.table.length - 1].value}%
                </div>
            ) : (
                <div style={{ width: '100%', height: '150px', marginTop: '0.5rem' }}>
                    <VegaLite spec={finalSpec} data={chartData} actions={false} style={{ width: '100%' }} />
                </div>
            )}
        </div>
    );
};

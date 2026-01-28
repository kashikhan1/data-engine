"use client";

import React, { useMemo } from "react";
import dynamic from "next/dynamic";
import styles from "./ScatterWidget.module.css";

// Dynamic import for Vega-Lite
const VegaLite = dynamic(() => import("react-vega").then((mod) => mod.VegaLite), {
    ssr: false,
    loading: () => <div className={styles.loading}>Loading scatter plot...</div>,
});

interface ScatterDataPoint {
    x: number;
    y: number;
    label?: string;
    category?: string;
    size?: number;
}

interface ScatterWidgetProps {
    data: ScatterDataPoint[];
    xLabel?: string;
    yLabel?: string;
    xFormat?: string;
    yFormat?: string;
    showTrendline?: boolean;
    colorByCategory?: boolean;
    colorScheme?: string;
}

export function ScatterWidget({
    data,
    xLabel = "X",
    yLabel = "Y",
    xFormat,
    yFormat,
    showTrendline = false,
    colorByCategory = true,
    colorScheme = "category10",
}: ScatterWidgetProps) {
    // Use mock data if none provided
    const scatterData = useMemo(() => {
        // Filter out any null/undefined data points
        const filteredData = data ? data.filter(d => !!d) : [];

        if (filteredData.length > 0) return filteredData;

        // Generate mock correlation data if no valid data is provided
        const categories = ["Product A", "Product B", "Product C"];
        const points: ScatterDataPoint[] = [];

        categories.forEach((category) => {
            for (let i = 0; i < 20; i++) {
                const x = Math.random() * 1000;
                const y = x * (0.5 + Math.random() * 0.5) + (Math.random() - 0.5) * 200;
                points.push({
                    x: Math.round(x),
                    y: Math.round(Math.max(0, y)),
                    category,
                    label: `${category} #${i + 1}`,
                });
            }
        });

        return points;
    }, [data]);

    // Calculate correlation
    const correlation = useMemo(() => {
        if (scatterData.length < 2) return 0;

        const n = scatterData.length;
        const sumX = scatterData.reduce((s, d) => s + d.x, 0);
        const sumY = scatterData.reduce((s, d) => s + d.y, 0);
        const sumXY = scatterData.reduce((s, d) => s + d.x * d.y, 0);
        const sumX2 = scatterData.reduce((s, d) => s + d.x * d.x, 0);
        const sumY2 = scatterData.reduce((s, d) => s + d.y * d.y, 0);

        const numerator = n * sumXY - sumX * sumY;
        const denominator = Math.sqrt(
            (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
        );

        return denominator === 0 ? 0 : numerator / denominator;
    }, [scatterData]);

    // Generate Vega-Lite spec
    const vegaSpec = useMemo(() => {
        const layers: any[] = [
            // Scatter points
            {
                mark: {
                    type: "circle",
                    opacity: 0.7,
                    size: 80,
                },
                encoding: {
                    x: {
                        field: "x",
                        type: "quantitative",
                        title: xLabel,
                        axis: {
                            labelColor: "#94a3b8",
                            titleColor: "#94a3b8",
                            format: xFormat,
                        },
                    },
                    y: {
                        field: "y",
                        type: "quantitative",
                        title: yLabel,
                        axis: {
                            labelColor: "#94a3b8",
                            titleColor: "#94a3b8",
                            format: yFormat,
                        },
                    },
                    color: colorByCategory
                        ? {
                            field: "category",
                            type: "nominal",
                            scale: { scheme: colorScheme },
                            legend: {
                                labelColor: "#94a3b8",
                                titleColor: "#94a3b8",
                            },
                        }
                        : { value: "#137fec" },
                    tooltip: [
                        { field: "label", type: "nominal", title: "Label" },
                        { field: "x", type: "quantitative", title: xLabel },
                        { field: "y", type: "quantitative", title: yLabel },
                        { field: "category", type: "nominal", title: "Category" },
                    ],
                },
            },
        ];

        // Add trendline
        if (showTrendline) {
            layers.push({
                mark: { type: "line", color: "#ef4444", strokeWidth: 2, opacity: 0.5 },
                transform: [{ regression: "y", on: "x" }],
                encoding: {
                    x: { field: "x", type: "quantitative" },
                    y: { field: "y", type: "quantitative" },
                },
            });
        }

        return {
            $schema: "https://vega.github.io/schema/vega-lite/v5.json",
            width: "container",
            height: 200,
            padding: 10,
            data: { name: "table" },
            layer: layers,
            config: {
                background: "transparent",
                view: { stroke: "transparent" },
                axis: {
                    domain: false,
                    gridColor: "rgba(255,255,255,0.05)",
                },
            },
        };
    }, [xLabel, yLabel, xFormat, yFormat, showTrendline, colorByCategory, colorScheme]);

    return (
        <div className={styles.container}>
            {/* Stats */}
            <div className={styles.statsBar}>
                <div className={styles.stat}>
                    <span className={styles.statLabel}>Points</span>
                    <span className={styles.statValue}>{scatterData.length}</span>
                </div>
                <div className={styles.stat}>
                    <span className={styles.statLabel}>Correlation</span>
                    <span className={`${styles.statValue} ${correlation > 0.5 ? styles.positive : correlation < -0.5 ? styles.negative : ""}`}>
                        {correlation.toFixed(2)}
                    </span>
                </div>
            </div>

            {/* Chart */}
            <div className={styles.chartWrapper}>
                <VegaLite
                    spec={vegaSpec as any}
                    data={{ table: scatterData }}
                    actions={false}
                />
            </div>
        </div>
    );
}

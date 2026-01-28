"use client";

import React, { useMemo } from "react";
import dynamic from "next/dynamic";
import styles from "./CohortWidget.module.css";

// Dynamic import for Vega-Lite
const VegaLite = dynamic(() => import("react-vega").then((mod) => mod.VegaLite), {
    ssr: false,
    loading: () => <div className={styles.loading}>Loading cohort chart...</div>,
});

interface CohortData {
    cohort: string;       // e.g., "2024-W01"
    period: number;       // Weeks/days since signup (0, 1, 2, ...)
    value: number;        // Retention rate or count
    users?: number;       // Original cohort size
    displayValue?: number;
}

interface CohortWidgetProps {
    data: CohortData[];
    valueFormat?: "percent" | "count";
    periodLabel?: string; // "Week", "Day", "Month"
    cohortLabel?: string; // "Cohort", "Signup Week"
    colorScheme?: string;
}

export function CohortWidget({
    data,
    valueFormat = "percent",
    periodLabel = "Week",
    cohortLabel = "Cohort",
    colorScheme = "teals",
}: CohortWidgetProps) {
    // Transform data for display
    const transformedData = useMemo(() => {
        if (!data || data.length === 0) {
            // Mock data for demonstration
            return generateMockCohortData();
        }
        return data
            .filter(d => !!d)
            .map((d) => ({
                ...d,
                displayValue: valueFormat === "percent" ? (d.value || 0) * 100 : (d.value || 0),
            }));
    }, [data, valueFormat]);

    // Generate Vega-Lite spec for heatmap
    const vegaSpec = useMemo(() => ({
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        width: "container",
        height: 250,
        padding: 10,
        data: { name: "table" },
        mark: { type: "rect" as const, cornerRadius: 2 },
        encoding: {
            x: {
                field: "period",
                type: "ordinal",
                title: periodLabel,
                axis: {
                    labelAngle: 0,
                    labelColor: "#94a3b8",
                    titleColor: "#94a3b8",
                },
            },
            y: {
                field: "cohort",
                type: "ordinal",
                title: cohortLabel,
                sort: "descending",
                axis: {
                    labelColor: "#94a3b8",
                    titleColor: "#94a3b8",
                },
            },
            color: {
                field: "displayValue",
                type: "quantitative",
                title: valueFormat === "percent" ? "Retention %" : "Users",
                scale: { scheme: colorScheme },
                legend: {
                    labelColor: "#94a3b8",
                    titleColor: "#94a3b8",
                },
            },
            tooltip: [
                { field: "cohort", type: "nominal", title: cohortLabel },
                { field: "period", type: "ordinal", title: periodLabel },
                {
                    field: "displayValue",
                    type: "quantitative",
                    title: valueFormat === "percent" ? "Retention" : "Users",
                    format: valueFormat === "percent" ? ".1f" : ",",
                },
                { field: "users", type: "quantitative", title: "Cohort Size" },
            ],
        },
        config: {
            background: "transparent",
            view: { stroke: "transparent" },
            axis: { domain: false, ticks: false, gridColor: "rgba(255,255,255,0.05)" },
        },
    }), [periodLabel, cohortLabel, valueFormat, colorScheme]);

    // Calculate summary stats
    const stats = useMemo(() => {
        if (transformedData.length === 0) return null;

        const week1Retention = (transformedData
            .filter(d => d.period === 1)
            .reduce((sum, d) => sum + (d.displayValue || 0), 0) /
            (transformedData.filter(d => d.period === 1).length || 1));

        const latestCohort = transformedData.find(d => d.period === 0);

        return {
            avgWeek1Retention: week1Retention,
            latestCohortSize: latestCohort?.users || 0,
        };
    }, [transformedData]);

    return (
        <div className={styles.container}>
            {/* Stats bar */}
            {stats && (
                <div className={styles.statsBar}>
                    <div className={styles.stat}>
                        <span className={styles.statLabel}>Avg {periodLabel} 1 Retention</span>
                        <span className={styles.statValue}>
                            {stats.avgWeek1Retention.toFixed(1)}%
                        </span>
                    </div>
                    <div className={styles.stat}>
                        <span className={styles.statLabel}>Latest Cohort</span>
                        <span className={styles.statValue}>
                            {stats.latestCohortSize.toLocaleString()} users
                        </span>
                    </div>
                </div>
            )}

            {/* Heatmap */}
            <div className={styles.chartWrapper}>
                <VegaLite
                    spec={vegaSpec as any}
                    data={{ table: transformedData }}
                    actions={false}
                />
            </div>

            {/* Legend hint */}
            <div className={styles.legendHint}>
                <span className={styles.legendLow}>Low</span>
                <div className={styles.legendGradient} />
                <span className={styles.legendHigh}>High</span>
            </div>
        </div>
    );
}

// Generate mock cohort data
function generateMockCohortData(): CohortData[] {
    const cohorts = [
        "2024-W48", "2024-W49", "2024-W50", "2024-W51", "2024-W52", "2025-W01"
    ];
    const data: CohortData[] = [];

    cohorts.forEach((cohort, cohortIndex) => {
        const cohortSize = 500 + Math.floor(Math.random() * 500);
        const maxPeriods = cohorts.length - cohortIndex;

        for (let period = 0; period < maxPeriods; period++) {
            // Retention typically drops sharply, then stabilizes
            const baseRetention = period === 0 ? 1 : 0.6 * Math.pow(0.85, period - 1);
            const noise = (Math.random() - 0.5) * 0.1;
            const retention = Math.max(0.05, Math.min(1, baseRetention + noise));

            data.push({
                cohort,
                period,
                value: retention,
                users: cohortSize,
                displayValue: retention * 100,
            });
        }
    });

    return data;
}

"use client";

import React from "react";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import type { WidgetSpec } from "@/types/dashboard";
import styles from "./KPIWidget.module.css";

interface KPIWidgetProps {
    title?: string;
    value?: number;
    delta?: number;
    config?: WidgetSpec["kpiConfig"];
}

export function KPIWidget({ title, value = 0, delta, config }: KPIWidgetProps) {
    const format = config?.format || "number";
    const prefix = config?.prefix || "";
    const suffix = config?.suffix || "";
    const showDelta = config?.comparison?.showDelta ?? true;

    // Format value
    const formatValue = (val: number): string => {
        switch (format) {
            case "currency":
                return new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: "USD",
                    minimumFractionDigits: 0,
                    maximumFractionDigits: 0,
                }).format(val);
            case "percent":
                return `${val.toFixed(1)}%`;
            case "compact":
                return new Intl.NumberFormat("en-US", {
                    notation: "compact",
                    compactDisplay: "short",
                }).format(val);
            default:
                return new Intl.NumberFormat("en-US").format(val);
        }
    };

    const getTrendClass = () => {
        if (delta === undefined || delta === 0) return styles.neutral;
        return delta > 0 ? styles.positive : styles.negative;
    };

    return (
        <div className={styles.container}>
            <div className={styles.main}>
                <div className={styles.header}>
                    <span className={styles.label}>{title || "Key Metric"}</span>
                    <h4 className={styles.value}>
                        {prefix}{formatValue(value)}{suffix}
                    </h4>
                </div>

                {showDelta && delta !== undefined && (
                    <div className={styles.trendRow}>
                        <div className={`${styles.trendBadge} ${getTrendClass()}`}>
                            {delta > 0 ? (
                                <TrendingUp size={12} strokeWidth={3} />
                            ) : (
                                <TrendingDown size={12} strokeWidth={3} />
                            )}
                            <span>{delta > 0 ? "+" : ""}{delta.toFixed(1)}%</span>
                        </div>
                        <span className={styles.trendLabel}>vs previous period</span>
                    </div>
                )}
            </div>

            {/* Sparkline Visualization */}
            <div className={styles.sparklineSection}>
                <div className={styles.sparklineWrapper}>
                    <svg className={styles.sparklineSvg} preserveAspectRatio="none" viewBox="0 0 100 40">
                        <defs>
                            <linearGradient id="gradient" x1="0%" y1="0%" x2="0%" y2="100%">
                                <stop offset="0%" stopColor="#135bec" stopOpacity="0.2" />
                                <stop offset="100%" stopColor="#135bec" stopOpacity="0" />
                            </linearGradient>
                        </defs>
                        <path
                            d="M 0 40 L 0 35 C 10 32, 20 38, 30 30 C 40 22, 50 25, 60 15 C 70 5, 80 12, 100 2 L 100 40 Z"
                            fill="url(#gradient)"
                        />
                        <path
                            d="M 0 35 C 10 32, 20 38, 30 30 C 40 22, 50 25, 60 15 C 70 5, 80 12, 100 2"
                            fill="none"
                            stroke="#135bec"
                            strokeWidth="3"
                            strokeLinecap="round"
                        />
                    </svg>
                </div>
            </div>
        </div>
    );
};

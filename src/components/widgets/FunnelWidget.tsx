"use client";

import React, { useMemo } from "react";
import { motion } from "framer-motion";
import { TrendingDown, Users } from "lucide-react";
import styles from "./FunnelWidget.module.css";

interface FunnelStep {
    name: string;
    count: number;
    label?: string;
}

interface FunnelWidgetProps {
    data: FunnelStep[];
    showConversionRates?: boolean;
    showDropoff?: boolean;
    colorScheme?: "default" | "gradient" | "rainbow";
}

const STEP_COLORS = [
    "#6366f1", // Indigo
    "#8b5cf6", // Purple
    "#a855f7", // Violet
    "#d946ef", // Fuchsia
    "#ec4899", // Pink
    "#f43f5e", // Rose
];

const GRADIENT_COLORS = [
    "linear-gradient(135deg, #137fec, #3b82f6)", // Primary Blue
    "linear-gradient(135deg, #0ea5e9, #38bdf8)", // Light Blue
    "linear-gradient(135deg, #06b6d4, #22d3ee)", // Cyan
    "linear-gradient(135deg, #14b8a6, #2dd4bf)", // Teal
    "linear-gradient(135deg, #10b981, #34d399)", // Emerald
];

export function FunnelWidget({
    data,
    showConversionRates = true,
    showDropoff = true,
    colorScheme = "gradient",
}: FunnelWidgetProps) {
    // Use mock data if none provided
    const funnelData = useMemo(() => {
        if (data && data.length > 0) return data;

        return [
            { name: "Page View", count: 10000, label: "Homepage visitors" },
            { name: "Sign Up Started", count: 4200, label: "Started registration" },
            { name: "Email Verified", count: 2800, label: "Verified email" },
            { name: "Onboarding Complete", count: 1500, label: "Finished setup" },
            { name: "First Purchase", count: 680, label: "Made first purchase" },
        ];
    }, [data]);

    // Calculate metrics
    const metrics = useMemo(() => {
        const total = funnelData[0]?.count || 0;

        return funnelData.map((step, i) => {
            const prevCount = i > 0 ? funnelData[i - 1].count : step.count;
            const conversionFromPrev = i > 0 ? (step.count / prevCount) * 100 : 100;
            const conversionFromTop = (step.count / total) * 100;
            const dropoff = prevCount - step.count;
            const dropoffPercent = i > 0 ? (dropoff / prevCount) * 100 : 0;

            return {
                ...step,
                widthPercent: (step.count / total) * 100,
                conversionFromPrev,
                conversionFromTop,
                dropoff,
                dropoffPercent,
            };
        });
    }, [funnelData]);

    // Overall conversion rate
    const overallConversion = useMemo(() => {
        if (funnelData.length < 2) return 0;
        return ((funnelData[funnelData.length - 1].count / funnelData[0].count) * 100);
    }, [funnelData]);

    const getStepColor = (index: number) => {
        if (colorScheme === "gradient") {
            return GRADIENT_COLORS[index % GRADIENT_COLORS.length];
        }
        return STEP_COLORS[index % STEP_COLORS.length];
    };

    return (
        <div className={styles.container}>
            {/* Summary header */}
            <div className={styles.summary}>
                <div className={styles.summaryItem}>
                    <Users size={16} />
                    <span>{funnelData[0]?.count?.toLocaleString() ?? "0"} entered</span>
                </div>
                <div className={styles.summaryItem}>
                    <TrendingDown size={16} />
                    <span>{overallConversion?.toFixed(1) ?? "0"}% converted</span>
                </div>
            </div>

            {/* Funnel visualization */}
            <div className={styles.funnel}>
                {metrics.map((step, index) => (
                    <div key={`${step.name}-${index}`} className={styles.stepWrapper}>
                        {/* Dropoff indicator */}
                        {showDropoff && index > 0 && step.dropoff > 0 && (
                            <div className={styles.dropoff}>
                                <div className={styles.dropoffLine} />
                                <span className={styles.dropoffValue}>
                                    -{step.dropoff?.toLocaleString() ?? "0"} ({step.dropoffPercent?.toFixed(1) ?? "0"}%)
                                </span>
                            </div>
                        )}

                        {/* Step bar */}
                        <motion.div
                            initial={{ width: 0, opacity: 0 }}
                            animate={{
                                width: `${Math.max(step.widthPercent, 15)}%`,
                                opacity: 1
                            }}
                            transition={{ delay: index * 0.1, duration: 0.4, ease: "easeOut" }}
                            className={styles.step}
                            style={{
                                background: colorScheme === "gradient"
                                    ? getStepColor(index)
                                    : getStepColor(index),
                            }}
                        >
                            <div className={styles.stepContent}>
                                <div className={styles.stepInfo}>
                                    <span className={styles.stepName}>{step.name}</span>
                                    <span className={styles.stepCount}>
                                        {step.count?.toLocaleString() ?? "0"}
                                    </span>
                                </div>

                                {showConversionRates && (
                                    <div className={styles.stepConversion}>
                                        <span className={styles.conversionPct}>
                                            {step.conversionFromTop.toFixed(1)}%
                                        </span>
                                    </div>
                                )}
                            </div>
                        </motion.div>

                        {/* Step label */}
                        {step.label && (
                            <p className={styles.stepLabel}>{step.label}</p>
                        )}
                    </div>
                ))}
            </div>

            {/* Conversion breakdown */}
            {showConversionRates && (
                <div className={styles.breakdown}>
                    <h4>Step-by-Step Conversion</h4>
                    <div className={styles.breakdownList}>
                        {metrics.slice(1).map((step, i) => (
                            <div key={`breakdown-${step.name}-${i}`} className={styles.breakdownItem}>
                                <span className={styles.breakdownLabel}>
                                    {metrics[i].name} → {step.name}
                                </span>
                                <span className={styles.breakdownValue}>
                                    {step.conversionFromPrev.toFixed(1)}%
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

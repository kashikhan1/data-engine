"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import {
    CheckCircle2,
    Circle,
    AlertCircle,
    XCircle,
    Loader2,
    Brain,
    Shield,
    Database,
    Code2,
    FlaskConical,
    CheckCheck,
    BarChart3,
    FileText,
    Save
} from "lucide-react";
import type { StepState } from "@/state/stores";
import type { AgentStep, StepStatus } from "@/types/dashboard";
import styles from "./AgentTimeline.module.css";

interface AgentTimelineProps {
    steps: StepState[];
    isStreaming: boolean;
    onStepSelect?: (step: StepState) => void;
}

const STEP_CONFIG: Record<AgentStep, { label: string; icon: React.ComponentType<any> }> = {
    schema: { label: "Schema Discovery", icon: Database },
    kpi: { label: "KPI Profiling", icon: CheckCheck },
    plan: { label: "Planning", icon: Brain },
    policy: { label: "Security Check", icon: Shield },
    semantic: { label: "Resolving Metrics", icon: Database },
    sql: { label: "Generating SQL", icon: Code2 },
    sample: { label: "Sampling Data", icon: FlaskConical },
    qa: { label: "Quality Check", icon: CheckCheck },
    execute: { label: "Executing Query", icon: Database },
    viz: { label: "Designing Charts", icon: BarChart3 },
    narrative: { label: "Writing Insights", icon: FileText },
    persist: { label: "Saving", icon: Save },
};

const STATUS_ICONS: Record<StepStatus, React.ComponentType<any>> = {
    queued: Circle,
    running: Loader2,
    done: CheckCircle2,
    warn: AlertCircle,
    fail: XCircle,
};

const STATUS_COLORS: Record<StepStatus, string> = {
    queued: "var(--text-muted)",
    running: "var(--primary)",
    done: "#10b981",
    warn: "#f59e0b",
    fail: "#ef4444",
};

export function AgentTimeline({ steps, isStreaming, onStepSelect }: AgentTimelineProps) {
    if (steps.length === 0 && !isStreaming) return null;

    const [expandedSteps, setExpandedSteps] = useState<Record<string, boolean>>({});

    return (
        <div className={styles.container}>
            <div className={styles.header}>
                <span>Agent Pipeline</span>
                {isStreaming && <div className={styles.streamingDot} />}
            </div>

            <div className={styles.timeline}>
                {steps.map((step, index) => {
                    const config = STEP_CONFIG[step.step];
                    const StatusIcon = STATUS_ICONS[step.status];
                    const StepIcon = config?.icon || Circle;
                    const logs = step.logs || [];
                    const isExpanded = Boolean(expandedSteps[step.step]);

                    return (
                        <motion.div
                            key={step.step}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: index * 0.05 }}
                            className={`${styles.step} ${styles[step.status]}`}
                        >
                            {/* Connector Line */}
                            {index > 0 && (
                                <div
                                    className={styles.connector}
                                    style={{
                                        background: step.status === "done" || step.status === "warn"
                                            ? STATUS_COLORS[step.status]
                                            : "var(--border)"
                                    }}
                                />
                            )}

                            {/* Step Icon */}
                            <div
                                className={styles.stepIcon}
                                style={{
                                    borderColor: STATUS_COLORS[step.status],
                                    background: step.status === "done" ? "rgba(16, 185, 129, 0.1)" :
                                        step.status === "running" ? "rgba(99, 102, 241, 0.1)" :
                                            step.status === "warn" ? "rgba(245, 158, 11, 0.1)" :
                                                step.status === "fail" ? "rgba(239, 68, 68, 0.1)" :
                                                    "transparent"
                                }}
                            >
                                <StepIcon
                                    size={14}
                                    style={{ color: STATUS_COLORS[step.status] }}
                                />
                            </div>

                            {/* Content */}
                            <div className={styles.stepContent}>
                                <div className={styles.stepHeader}>
                                    <span className={styles.stepLabel}>
                                        {config?.label || step.step}
                                    </span>
                                    <div className={styles.stepHeaderRight}>
                                        {onStepSelect && (
                                            <button
                                                type="button"
                                                className={styles.viewOutput}
                                                onClick={() => onStepSelect(step)}
                                            >
                                                View output
                                            </button>
                                        )}
                                        <StatusIcon
                                            size={14}
                                            className={step.status === "running" ? styles.spinning : ""}
                                            style={{ color: STATUS_COLORS[step.status] }}
                                        />
                                    </div>
                                </div>

                                {step.message && (
                                    <p className={`${styles.stepMessage} ${isExpanded ? styles.stepMessageExpanded : ""}`}>
                                        {step.message}
                                    </p>
                                )}

                                {logs.length > 0 && (
                                    <button
                                        type="button"
                                        className={styles.logsToggle}
                                        onClick={() => setExpandedSteps(prev => ({ ...prev, [step.step]: !prev[step.step] }))}
                                    >
                                        {isExpanded ? "Hide logs" : `Show logs (${logs.length})`}
                                    </button>
                                )}

                                {isExpanded && logs.length > 0 && (
                                    <div className={styles.logs}>
                                        {logs.map((log, logIndex) => (
                                            <div key={`${step.step}-log-${logIndex}`} className={styles.logLine}>
                                                {log}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </motion.div>
                    );
                })}

                {/* Loading placeholder for next step */}
                {isStreaming && steps.length > 0 && steps[steps.length - 1].status === "done" && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 0.5 }}
                        className={`${styles.step} ${styles.queued}`}
                    >
                        <div className={styles.connector} style={{ background: "var(--border)" }} />
                        <div className={styles.stepIcon}>
                            <Loader2 size={14} className={styles.spinning} style={{ color: "var(--text-muted)" }} />
                        </div>
                        <div className={styles.stepContent}>
                            <span className={styles.stepLabel}>Processing...</span>
                        </div>
                    </motion.div>
                )}
            </div>
        </div>
    );
}

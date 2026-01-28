"use client";

import React, { useState } from "react";
import {
    X,
    Terminal,
    Code2,
    Settings2,
    AlertTriangle,
    GitBranch,
    Table,
    Copy,
    Check,
    Play,
    ExternalLink
} from "lucide-react";
import { useEditorStore } from "@/state/stores";
import type { Dashboard, QACheck } from "@/types/dashboard";
import styles from "./DebugDrawer.module.css";

interface DebugDrawerProps {
    dashboard: Dashboard | null;
    selectedWidgetId?: string | null;
}

export function DebugDrawer({ dashboard, selectedWidgetId }: DebugDrawerProps) {
    const { debugDrawerOpen, debugDrawerTab, setDebugDrawerOpen, setDebugDrawerTab } = useEditorStore();
    const [copiedId, setCopiedId] = useState<string | null>(null);

    if (!debugDrawerOpen) return null;

    const queries = dashboard?.queries || [];
    const qaChecks = dashboard?.qaChecks || [];

    // Filter queries for selected widget
    const relevantQueries = selectedWidgetId
        ? queries.filter(q => q.widgetIds.includes(selectedWidgetId))
        : queries;

    const handleCopy = async (text: string, id: string) => {
        await navigator.clipboard.writeText(text);
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 2000);
    };

    const highlightSQL = (sql: string) => {
        const keywords = /\b(SELECT|FROM|WHERE|AND|OR|GROUP BY|ORDER BY|HAVING|LIMIT|AS|JOIN|LEFT|RIGHT|INNER|ON|WITH|UNION|CASE|WHEN|THEN|ELSE|END|DESC|ASC)\b/gi;
        const functions = /\b(SUM|COUNT|AVG|MIN|MAX|date_trunc|COALESCE|NOW)\b/gi;
        const strings = /'(.*?)'/g;
        const numbers = /\b(\d+)\b/g;

        return sql
            .replace(keywords, `<span class="${styles.keyword}">$1</span>`)
            .replace(functions, `<span class="${styles.function}">$1</span>`)
            .replace(strings, `<span class="${styles.string}">'$1'</span>`)
            .replace(numbers, `<span class="${styles.number}">$1</span>`);
    };

    return (
        <div className={styles.container}>
            {/* Header */}
            <div className={styles.header}>
                <div className={styles.headerTop}>
                    <div className={styles.headerTitle}>
                        <Terminal size={18} />
                        <span>Query Debugger</span>
                    </div>
                    <div className={styles.toolbarSection}>
                        <button className={styles.closeButton} title="Open in New Tab">
                            <ExternalLink size={14} />
                        </button>
                        <button className={styles.closeButton} onClick={() => setDebugDrawerOpen(false)}>
                            <X size={16} />
                        </button>
                    </div>
                </div>
                <div className={styles.tabs}>
                    <button
                        className={`${styles.tab} ${debugDrawerTab === "sql" ? styles.active : ""}`}
                        onClick={() => setDebugDrawerTab("sql")}
                    >
                        <span>Generated SQL</span>
                    </button>
                    <button
                        className={`${styles.tab} ${debugDrawerTab === "params" ? styles.active : ""}`}
                        onClick={() => setDebugDrawerTab("params")}
                    >
                        <span>Query Plan</span>
                    </button>
                    <button
                        className={`${styles.tab} ${debugDrawerTab === "qa" ? styles.active : ""}`}
                        onClick={() => setDebugDrawerTab("qa")}
                    >
                        <span>QA Checks</span>
                    </button>
                </div>
            </div>

            {/* Content Area */}
            <div className={styles.content}>
                {debugDrawerTab === "sql" && (
                    <div className={styles.sqlTab}>
                        <div className={styles.lineNumberSidebar}>
                            {Array.from({ length: 15 }).map((_, i) => (
                                <span key={i}>{i + 1}</span>
                            ))}
                        </div>
                        <div className={styles.codeArea}>
                            {relevantQueries.length > 0 ? (
                                <pre className={styles.sqlCode}>
                                    <code dangerouslySetInnerHTML={{ __html: highlightSQL(relevantQueries[0].sql) }} />
                                </pre>
                            ) : (
                                <div className={styles.empty}>
                                    <Code2 size={40} />
                                    <p>No queries generated yet</p>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {debugDrawerTab !== "sql" && (
                    <div className={styles.empty}>
                        <Settings2 size={40} />
                        <p>{debugDrawerTab.toUpperCase()} View Coming Soon</p>
                    </div>
                )}
            </div>

            {/* Footer / QA Section */}
            <div className={styles.footer}>
                <h4 className={styles.footerTitle}>QA Checks & Metadata</h4>
                <div className={styles.qaList}>
                    {qaChecks.slice(0, 2).map((check, idx) => (
                        <div key={idx} className={styles.qaItem}>
                            {check.status === "pass" ? (
                                <Check size={14} className={styles.qaPass} />
                            ) : (
                                <AlertTriangle size={14} className={styles.qaWarn} />
                            )}
                            <span>{check.message}</span>
                        </div>
                    ))}
                    {qaChecks.length === 0 && (
                        <div className={styles.qaItem}>
                            <Check size={14} className={styles.qaPass} />
                            <span>No issues detected in generated queries</span>
                        </div>
                    )}
                </div>

                <div className={styles.actions}>
                    <button
                        className={`${styles.actionButton} ${styles.secondary}`}
                        onClick={() => relevantQueries[0] && handleCopy(relevantQueries[0].sql, "debug")}
                    >
                        <Copy size={16} />
                        <span>{copiedId === "debug" ? "Copied" : "Copy"}</span>
                    </button>
                    <button className={`${styles.actionButton} ${styles.primary}`}>
                        <Play size={16} fill="currentColor" />
                        <span>Run Query</span>
                    </button>
                </div>
            </div>
        </div>
    );
}

// Simple SQL formatter helper (internal)
function formatSQL(sql: string): string {
    const keywords = [
        "SELECT", "FROM", "WHERE", "AND", "OR", "ORDER BY", "GROUP BY",
        "HAVING", "JOIN", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN",
        "ON", "AS", "LIMIT", "OFFSET", "WITH", "UNION", "CASE", "WHEN",
        "THEN", "ELSE", "END"
    ];

    let formatted = sql;
    keywords.forEach((kw) => {
        formatted = formatted.replace(
            new RegExp(`\\b${kw}\\b`, "gi"),
            `\n${kw}`
        );
    });

    return formatted.trim();
}

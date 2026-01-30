"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./TableWidget.module.css";

interface Column {
    field: string;
    header: string;
    width?: number;
    format?: string;
    sortable?: boolean;
}

interface TableWidgetProps {
    data: any[];
    columns: Column[];
    pageSize?: number;
}

export function TableWidget({ data, columns, pageSize = 10 }: TableWidgetProps) {
    const [sortField, setSortField] = useState<string | null>(null);
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
    const [currentPage, setCurrentPage] = useState(0);
    const [columnToggles] = useState(() => {
        if (typeof window === "undefined") return null;
        try {
            const raw = localStorage.getItem("schema_column_toggles");
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    });

    // Auto-generate columns if not provided
    const finalColumns = useMemo(() => {
        if (columns.length > 0) return columns;
        if (data.length === 0) return [];

        return Object.keys(data[0]).filter(k => k !== '__rowKey').map((key) => ({
            field: key,
            header: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "),
            sortable: true,
            format: undefined,
            width: undefined,
        } as Column));
    }, [columns, data]);

    const allowedColumns = useMemo(() => {
        if (!columnToggles || data.length === 0) return null;
        const dataKeys = Object.keys(data[0] || {}).filter(k => k !== "__rowKey");
        let best: { table: string; overlap: number } | null = null;
        Object.entries(columnToggles as Record<string, any>).forEach(([table, cols]) => {
            const visibleCols = Object.entries(cols || {})
                .filter(([, settings]: any) => settings?.show !== false)
                .map(([name]) => name);
            const overlap = visibleCols.filter((col) => dataKeys.includes(col)).length;
            if (overlap > 0 && (!best || overlap > best.overlap)) {
                best = { table, overlap };
            }
        });
        if (!best) return null;
        const bestTable = (best as { table: string; overlap: number }).table;
        const visible = Object.entries((columnToggles as Record<string, any>)[bestTable] || {})
            .filter(([, settings]: any) => settings?.show !== false)
            .map(([name]) => name);
        return new Set(visible);
    }, [columnToggles, data]);

    const filteredColumns = useMemo(() => {
        if (!allowedColumns) return finalColumns;
        return finalColumns.filter((col) => allowedColumns.has(col.field));
    }, [allowedColumns, finalColumns]);

    const visibleColumns = filteredColumns.length > 0 ? filteredColumns : finalColumns;

    useEffect(() => {
        if (!sortField) return;
        if (!visibleColumns.some((col) => col.field === sortField)) {
            setSortField(null);
        }
    }, [sortField, visibleColumns]);

    // Sort data
    const sortedData = useMemo(() => {
        if (!sortField) return data;

        return [...data].sort((a, b) => {
            const aVal = a[sortField];
            const bVal = b[sortField];

            if (typeof aVal === "number" && typeof bVal === "number") {
                return sortDirection === "asc" ? aVal - bVal : bVal - aVal;
            }

            const aStr = String(aVal).toLowerCase();
            const bStr = String(bVal).toLowerCase();

            if (sortDirection === "asc") {
                return aStr.localeCompare(bStr);
            }
            return bStr.localeCompare(aStr);
        });
    }, [data, sortField, sortDirection]);

    // Paginate data
    const paginatedData = useMemo(() => {
        const start = currentPage * pageSize;
        return sortedData.slice(start, start + pageSize);
    }, [sortedData, currentPage, pageSize]);

    const totalPages = Math.ceil(data.length / pageSize);

    // Handle sort
    const handleSort = (field: string) => {
        if (sortField === field) {
            setSortDirection(sortDirection === "asc" ? "desc" : "asc");
        } else {
            setSortField(field);
            setSortDirection("asc");
        }
    };

    // Format cell value
    const formatValue = (value: any, format?: string): string => {
        if (value === null || value === undefined) return "-";

        if (format === "currency") {
            return new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: "USD",
            }).format(value);
        }

        if (format === "percent") {
            return `${(value * 100).toFixed(1)}%`;
        }

        if (format === "number") {
            return new Intl.NumberFormat("en-US").format(value);
        }

        if (typeof value === "number") {
            return new Intl.NumberFormat("en-US").format(value);
        }

        return String(value);
    };

    if (data.length === 0) {
        return (
            <div className={styles.empty}>
                <p>No data available</p>
            </div>
        );
    }

    return (
        <div className={styles.container}>
            <div className={styles.tableWrapper}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            {visibleColumns.map((col) => (
                                <th
                                    key={col.field}
                                    className={col.sortable !== false ? styles.sortable : ""}
                                    onClick={() => col.sortable !== false && handleSort(col.field)}
                                    style={{ width: col.width ? `${col.width}px` : undefined }}
                                >
                                    <div className={styles.headerCell}>
                                        <span>{col.header}</span>
                                        {sortField === col.field && (
                                            <span className={styles.sortIcon}>
                                                {sortDirection === "asc" ? (
                                                    <ChevronUp size={14} />
                                                ) : (
                                                    <ChevronDown size={14} />
                                                )}
                                            </span>
                                        )}
                                    </div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {paginatedData.map((row, i) => (
                            <tr key={i}>
                                {visibleColumns.map((col) => {
                                    const value = row[col.field];
                                    const isNumeric = typeof value === "number" || col.format === "currency" || col.format === "percent" || col.format === "number";
                                    const isGrowth = col.field.toLowerCase().includes("growth") || col.field.toLowerCase().includes("delta");

                                    let cellClass = isNumeric ? styles.numeric : "";
                                    if (isGrowth) {
                                        cellClass += ` ${styles.growth} ${Number(value) >= 0 ? styles.positive : styles.negative}`;
                                    }

                                    return (
                                        <td key={col.field} className={cellClass}>
                                            {formatValue(value, col.format)}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
                <div className={styles.pagination}>
                    <span className={styles.pageInfo}>
                        {currentPage * pageSize + 1} - {Math.min((currentPage + 1) * pageSize, data.length)} of {data.length}
                    </span>
                    <div className={styles.pageControls}>
                        <button
                            className={styles.pageButton}
                            onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
                            disabled={currentPage === 0}
                        >
                            <ChevronLeft size={16} />
                        </button>
                        <button
                            className={styles.pageButton}
                            onClick={() => setCurrentPage(Math.min(totalPages - 1, currentPage + 1))}
                            disabled={currentPage >= totalPages - 1}
                        >
                            <ChevronRight size={16} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

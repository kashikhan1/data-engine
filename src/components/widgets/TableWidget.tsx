"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import styles from "./TableWidget.module.css";
import { useDashboardStore, useWorkflowStore } from "@/state/stores";
import type { Filter } from "@/types/dashboard";

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
    widgetId?: string;
    respectColumnToggles?: boolean;
    totalRows?: number;
}

export function TableWidget({ data, columns, pageSize = 10, widgetId, respectColumnToggles = false, totalRows }: TableWidgetProps) {
    const { dashboard, activeFilters, setFilter, markFiltersActivated } = useDashboardStore();
    const { setStaleStep } = useWorkflowStore();
    const searchDimension = useMemo(() => {
        const filters = (dashboard?.filters || []) as Filter[];
        const firstSearch = filters.find((f) => f?.type === "search" && typeof f?.dimension === "string");
        return firstSearch?.dimension || null;
    }, [dashboard?.filters]);
    const pageKey = widgetId ? `__page:${widgetId}` : null;
    const pageSizeKey = widgetId ? `__pageSize:${widgetId}` : null;
    const offsetKey = widgetId ? `__offset:${widgetId}` : null;
    const serverSearchKey = widgetId ? (searchDimension || "__search") : searchDimension;
    const searchColumnKey = widgetId ? "__searchColumn" : null;
    const widgetSearchColumnKey = widgetId ? `__searchColumn:${widgetId}` : null;
    const columnPrefsStorageKey = widgetId ? `table_widget_columns:${widgetId}` : null;
    const sortColKey = widgetId ? `__sort_col:${widgetId}` : null;
    const sortDirKey = widgetId ? `__sort_dir:${widgetId}` : null;
    const [sortField, setSortField] = useState<string | null>(() => {
        if (!sortColKey) return null;
        const v = activeFilters.get(sortColKey);
        return typeof v === "string" && v.trim() ? v.trim() : null;
    });
    const [sortDirection, setSortDirection] = useState<"asc" | "desc">(() => {
        if (!sortDirKey) return "asc";
        const v = activeFilters.get(sortDirKey);
        return String(v || "").toLowerCase() === "desc" ? "desc" : "asc";
    });
    const [currentPage, setCurrentPage] = useState(() => {
        if (!pageKey) return 0;
        const raw = Number(activeFilters.get(pageKey) ?? 0);
        return Number.isFinite(raw) && raw >= 0 ? raw : 0;
    });
    const [pageSizeState, setPageSizeState] = useState(() => {
        if (!pageSizeKey) return pageSize;
        const raw = Number(activeFilters.get(pageSizeKey) ?? pageSize);
        // Enforce minimum page size of 5 to avoid "1 row" UI issues
        return Number.isFinite(raw) && raw >= 5 ? raw : (pageSize >= 5 ? pageSize : 10);
    });
    const [searchDraft, setSearchDraft] = useState(() => {
        if (!serverSearchKey) return "";
        const current = activeFilters.get(serverSearchKey);
        return typeof current === "string" ? current : "";
    });
    const [searchColumn, setSearchColumn] = useState(() => {
        const fromWidget = widgetSearchColumnKey ? activeFilters.get(widgetSearchColumnKey) : undefined;
        if (typeof fromWidget === "string" && fromWidget.trim()) return fromWidget;
        const fromGlobal = searchColumnKey ? activeFilters.get(searchColumnKey) : undefined;
        if (typeof fromGlobal === "string" && fromGlobal.trim()) return fromGlobal;
        return "__all";
    });

    // Define isServerPaginated early as it's used in state init or render
    const isServerPaginated = Boolean(widgetId);
    const pageOptions = [10, 25, 50, 100];

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
        if (data.length === 0) return columns;
        const dataKeys = Object.keys(data[0] || {}).filter((k) => k !== "__rowKey");
        if (columns.length === 0) {
            return dataKeys.map((key) => ({
                field: key,
                header: key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " "),
                sortable: true,
                format: undefined,
                width: undefined,
            } as Column));
        }

        const existingByField = new Map<string, Column>();
        columns.forEach((col) => {
            const field = String(col?.field || "").trim();
            if (!field) return;
            existingByField.set(field, col);
        });
        const mergedFields = [
            ...columns.map((col) => String(col?.field || "").trim()).filter(Boolean),
            ...dataKeys.filter((field) => !existingByField.has(field))
        ];
        return mergedFields.map((field) => {
            const existing = existingByField.get(field);
            if (existing) return existing;
            return {
                field,
                header: field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, " "),
                sortable: true,
                format: undefined,
                width: undefined,
            } as Column;
        });
    }, [columns, data]);

    const allowedColumns = useMemo(() => {
        if (!respectColumnToggles || !columnToggles || data.length === 0) return null;
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
            .map(([name]) => name)
            .filter((name) => dataKeys.includes(name));
        if (visible.length === 0) return null;
        if (visible.length <= 1 && dataKeys.length > 3) return null;
        return new Set(visible);
    }, [respectColumnToggles, columnToggles, data]);

    // Initialize visibility based on localStorage OR global prefs (allowedColumns)
    const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(() => {
        // 1. Try Widget-specific LocalStorage
        if (columnPrefsStorageKey && typeof window !== "undefined") {
            try {
                const raw = localStorage.getItem(columnPrefsStorageKey);
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === "object") return parsed;
                }
            } catch { }
        }

        // 2. Fallback to Global Schema Preferences (if applicable)
        // We compute the initial visibility map here instead of filtering columns out completely
        if (allowedColumns && data.length > 0) {
            const dataKeys = Object.keys(data[0] || {}).filter(k => k !== "__rowKey");
            const initialMap: Record<string, boolean> = {};
            dataKeys.forEach(key => {
                // If it's in the allowed set, it's true. If not, it's false.
                initialMap[key] = allowedColumns.has(key);
            });
            return initialMap;
        }

        return {};
    });

    // visibleColumns should be ALL columns so the user can toggle them back on
    const visibleColumns = finalColumns;

    const displayColumns = useMemo(() => {
        // If visibility map is empty, show everything (default)
        if (Object.keys(columnVisibility).length === 0) return visibleColumns;

        const selected = visibleColumns.filter((col) => columnVisibility[col.field] !== false);
        // If user hid everything, show at least one or show empty
        return selected.length > 0 ? selected : [];
    }, [visibleColumns, columnVisibility]);

    const effectiveSortField = sortField && displayColumns.some((col) => col.field === sortField)
        ? sortField
        : null;
    const effectiveSearchColumn = searchColumn === "__all" || visibleColumns.some((col) => col.field === searchColumn)
        ? searchColumn
        : "__all";

    useEffect(() => {
        if (!columnPrefsStorageKey || typeof window === "undefined") return;
        try {
            localStorage.setItem(columnPrefsStorageKey, JSON.stringify(columnVisibility));
        } catch {
            // ignore localStorage write failures
        }
    }, [columnPrefsStorageKey, columnVisibility]);

    // Sort data
    const sortedData = useMemo(() => {
        if (!effectiveSortField) return data;

        return [...data].sort((a, b) => {
            const aVal = a[effectiveSortField];
            const bVal = b[effectiveSortField];

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
    }, [data, effectiveSortField, sortDirection]);

    // Paginate data
    const paginatedData = useMemo(() => {
        if (isServerPaginated) {
            return sortedData;
        }
        const start = currentPage * pageSizeState;
        return sortedData.slice(start, start + pageSizeState);
    }, [sortedData, currentPage, pageSizeState, isServerPaginated]);

    const totalServerRows = typeof totalRows === "number" && Number.isFinite(totalRows) && totalRows >= 0
        ? totalRows
        : null;
    const debugOffset = currentPage * pageSizeState;
    const debugStorePage = pageKey ? activeFilters.get(pageKey) : undefined;
    const debugStoreSize = pageSizeKey ? activeFilters.get(pageSizeKey) : undefined;
    const totalPages = isServerPaginated
        ? (totalServerRows !== null ? Math.max(1, Math.ceil(totalServerRows / pageSizeState)) : 0)
        : Math.ceil(data.length / pageSizeState);
    const hasNextServerPage = isServerPaginated
        ? (totalServerRows !== null ? (currentPage + 1) * pageSizeState < totalServerRows : data.length >= pageSizeState)
        : false;
    const showPagination = isServerPaginated
        ? (currentPage > 0 || hasNextServerPage || (totalServerRows !== null && totalServerRows > pageSizeState))
        : totalPages > 1;

    const searchedData = useMemo(() => {
        const term = searchDraft.trim().toLowerCase();
        if (!term) return paginatedData;
        const searchableFields = effectiveSearchColumn === "__all"
            ? displayColumns.map((col) => col.field)
            : [effectiveSearchColumn];
        if (serverSearchKey && effectiveSearchColumn === "__all") return paginatedData;
        return paginatedData.filter((row) =>
            searchableFields.some((field) => String(row?.[field] ?? "").toLowerCase().includes(term))
        );
    }, [paginatedData, searchDraft, serverSearchKey, effectiveSearchColumn, displayColumns]);
    const debugRowsOnPage = Array.isArray(searchedData) ? searchedData.length : 0;

    // Handle sort — persist to activeFilters so server re-executes with new ORDER BY
    const handleSort = (field: string) => {
        const newDir: "asc" | "desc" = effectiveSortField === field
            ? (sortDirection === "asc" ? "desc" : "asc")
            : "asc";
        setSortField(field);
        setSortDirection(newDir);
        if (widgetId && isServerPaginated) {
            if (sortColKey) setFilter(sortColKey, field);
            if (sortDirKey) setFilter(sortDirKey, newDir);
            // Reset to page 0 on sort change
            setCurrentPage(0);
            persistPaging(0, pageSizeState);
            markFiltersActivated();
            setStaleStep(4);
        }
    };

    const persistPaging = (nextPage: number, nextPageSize: number) => {
        if (!widgetId) return;
        const nextOffset = nextPage * nextPageSize;
        console.log("[PAGINATION_DEBUG][UI] persistPaging", {
            widgetId,
            nextPage,
            nextPageSize,
            computedOffset: nextOffset
        });
        setFilter(`__page:${widgetId}`, nextPage);
        setFilter(`__pageSize:${widgetId}`, nextPageSize);
        setFilter(`__offset:${widgetId}`, nextOffset);
        markFiltersActivated();
        setStaleStep(4);
    };

    useEffect(() => {
        if (!pageKey) return;
        const raw = Number(activeFilters.get(pageKey) ?? 0);
        const next = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
        if (next !== currentPage) {
            setCurrentPage(next);
        }
    }, [activeFilters, pageKey, currentPage]);

    useEffect(() => {
        if (!pageSizeKey) return;
        const raw = Number(activeFilters.get(pageSizeKey) ?? pageSize);
        // Enforce minimum page size of 5 here too
        const next = Number.isFinite(raw) && raw >= 5 ? Math.floor(raw) : (pageSize >= 5 ? pageSize : 10);
        if (next !== pageSizeState) {
            setPageSizeState(next);
        }
    }, [activeFilters, pageSizeKey, pageSize, pageSizeState]);

    useEffect(() => {
        if (!widgetId) return;
        const hasPage = pageKey ? activeFilters.has(pageKey) : false;
        const hasPageSize = pageSizeKey ? activeFilters.has(pageSizeKey) : false;
        const hasOffset = offsetKey ? activeFilters.has(offsetKey) : false;
        if (hasPage && hasPageSize && hasOffset) return;
        persistPaging(currentPage, pageSizeState);
    }, [widgetId, pageKey, pageSizeKey, offsetKey, activeFilters, currentPage, pageSizeState]);

    useEffect(() => {
        if (!serverSearchKey) return;
        const timer = setTimeout(() => {
            const current = activeFilters.get(serverSearchKey);
            const currentText = typeof current === "string" ? current : "";
            const normalizedSearchColumn = effectiveSearchColumn === "__all" ? "" : effectiveSearchColumn;
            const currentGlobalColumn = searchColumnKey ? activeFilters.get(searchColumnKey) : undefined;
            const currentWidgetColumn = widgetSearchColumnKey ? activeFilters.get(widgetSearchColumnKey) : undefined;
            const globalColumnText = typeof currentGlobalColumn === "string" ? currentGlobalColumn : "";
            const widgetColumnText = typeof currentWidgetColumn === "string" ? currentWidgetColumn : "";
            if (
                currentText === searchDraft &&
                globalColumnText === normalizedSearchColumn &&
                widgetColumnText === normalizedSearchColumn
            ) {
                return;
            }
            setFilter(serverSearchKey, searchDraft);
            if (searchColumnKey) {
                setFilter(searchColumnKey, normalizedSearchColumn);
            }
            if (widgetSearchColumnKey) {
                setFilter(widgetSearchColumnKey, normalizedSearchColumn);
            }
            markFiltersActivated();
            setStaleStep(4);
        }, 350);
        return () => clearTimeout(timer);
    }, [
        serverSearchKey,
        searchDraft,
        effectiveSearchColumn,
        searchColumnKey,
        widgetSearchColumnKey,
        activeFilters,
        setFilter,
        markFiltersActivated,
        setStaleStep
    ]);

    const toggleColumnVisibility = (field: string) => {
        setColumnVisibility((prev) => {
            const currentVisible = visibleColumns.filter((col) => prev[col.field] !== false);
            const isCurrentlyVisible = prev[field] !== false;
            if (isCurrentlyVisible && currentVisible.length <= 1) {
                return prev;
            }
            return {
                ...prev,
                [field]: !isCurrentlyVisible
            };
        });
    };

    const resetVisibleColumns = () => {
        setColumnVisibility({});
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
            <div className={styles.toolbar}>
                <select
                    className={styles.searchFieldSelect}
                    value={effectiveSearchColumn}
                    onChange={(e) => setSearchColumn(e.target.value || "__all")}
                    title="Search by column"
                >
                    <option value="__all">All columns</option>
                    {displayColumns.map((col) => (
                        <option key={col.field} value={col.field}>
                            {col.header}
                        </option>
                    ))}
                </select>
                <input
                    className={styles.searchInput}
                    type="search"
                    value={searchDraft}
                    placeholder={serverSearchKey ? "Search table" : "Search current rows"}
                    onChange={(e) => setSearchDraft(e.target.value)}
                />
                <details className={styles.columnPicker}>
                    <summary className={styles.columnPickerSummary}>
                        Columns {displayColumns.length}/{visibleColumns.length}
                    </summary>
                    <div className={styles.columnPickerMenu}>
                        <button
                            type="button"
                            className={styles.resetColumnsButton}
                            onClick={resetVisibleColumns}
                        >
                            Reset
                        </button>
                        {visibleColumns.map((col) => {
                            const checked = columnVisibility[col.field] !== false;
                            return (
                                <label key={col.field} className={styles.columnOption}>
                                    <input
                                        type="checkbox"
                                        checked={checked}
                                        onChange={() => toggleColumnVisibility(col.field)}
                                    />
                                    <span>{col.header}</span>
                                </label>
                            );
                        })}
                    </div>
                </details>
            </div>
            <div className={styles.tableWrapper}>
                <table className={styles.table}>
                    <thead>
                        <tr>
                            {displayColumns.map((col) => (
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
                        {searchedData.map((row, i) => (
                            <tr key={i}>
                                {displayColumns.map((col) => {
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
            {showPagination && (
                <div className={styles.pagination}>
                    <span className={styles.pageInfo}>
                        {isServerPaginated
                            ? (totalServerRows !== null
                                ? `Page ${currentPage + 1} of ${totalPages} • ${totalServerRows} rows`
                                : `Page ${currentPage + 1} • ${data.length} rows`)
                            : `${currentPage * pageSizeState + 1} - ${Math.min((currentPage + 1) * pageSizeState, data.length)} of ${data.length}`}
                    </span>
                    {isServerPaginated && (
                        <span className={styles.pageInfo} style={{ opacity: 0.75 }}>
                            page={currentPage} size={pageSizeState} offset={debugOffset} rowsOnPage={debugRowsOnPage} total={totalServerRows ?? "?"} storePage={String(debugStorePage ?? "?")} storeSize={String(debugStoreSize ?? "?")}
                        </span>
                    )}
                    <div className={styles.pageSize}>
                        <span className={styles.pageSizeLabel}>Rows</span>
                        <select
                            className={styles.pageSizeSelect}
                            value={pageSizeState}
                            onChange={(e) => {
                                const nextSize = Number(e.target.value) || pageSizeState;
                                setCurrentPage(0);
                                setPageSizeState(nextSize);
                                persistPaging(0, nextSize);
                            }}
                        >
                            {pageOptions.map((opt) => (
                                <option key={opt} value={opt}>{opt}</option>
                            ))}
                        </select>
                    </div>
                    <div className={styles.pageControls}>
                        <button
                            className={styles.pageButton}
                            onClick={() => {
                                const nextPage = Math.max(0, currentPage - 1);
                                setCurrentPage(nextPage);
                                persistPaging(nextPage, pageSizeState);
                            }}
                            disabled={currentPage === 0}
                        >
                            <ChevronLeft size={16} />
                        </button>
                        <button
                            className={styles.pageButton}
                            onClick={() => {
                                const nextPage = currentPage + 1;
                                setCurrentPage(nextPage);
                                persistPaging(nextPage, pageSizeState);
                            }}
                            disabled={isServerPaginated ? !hasNextServerPage : currentPage >= totalPages - 1}
                        >
                            <ChevronRight size={16} />
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

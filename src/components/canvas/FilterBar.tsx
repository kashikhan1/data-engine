"use client";

import React, { useEffect, useMemo } from "react";
import { Select, Input } from "antd";
import {
    Calendar,
    MapPin,
    Layers,
    Clock,
    Search
} from "lucide-react";
import styles from "./FilterBar.module.css";
import type { Filter } from "@/types/dashboard";
import { useDashboardStore, useWorkflowStore } from "@/state/stores";
import { normalizeFilterSet } from "@/lib/filter-contract";

interface FilterBarProps {
    filters?: Filter[];
    variant?: "panel" | "compact";
}

export function FilterBar({ filters = [], variant = "panel" }: FilterBarProps) {
    const { activeFilters, setFilter, clearFilter, clearAllFilters, markFiltersActivated } = useDashboardStore();
    const { setStaleStep } = useWorkflowStore();
    const isCompact = variant === "compact";

    const resolvedFilters = useMemo<Filter[]>(() => normalizeFilterSet(filters || []) as Filter[], [filters]);
        const activeCount = useMemo(() => {
        let count = 0;
        resolvedFilters.forEach((f) => {
            const value = activeFilters.get(f.dimension);
            if (Array.isArray(value)) {
                if (value.length > 0) count += 1;
                return;
            }
            if (value && value !== "All") count += 1;
        });
        return count;
    }, [resolvedFilters, activeFilters]);

    // Seed provided filters into store on first render (per dimension)
    useEffect(() => {
        // clear filters not in current set
        const allowed = new Set(resolvedFilters.map(f => f.dimension));
        activeFilters.forEach((_v, key) => {
            if (key.startsWith("__page:") || key.startsWith("__pageSize:") || key.startsWith("__offset:")) return;
            if (!allowed.has(key)) {
                clearFilter(key);
            }
        });

        resolvedFilters.forEach((f) => {
            const existing = activeFilters.get(f.dimension);
            if (existing === undefined) {
                const initialValue =
                    f.value !== undefined
                        ? f.value
                        : f.type === "multi-select"
                            ? (f.options || []).map(o => o.value)
                            : f.type === "select"
                                ? null
                                : (f.options || [])[0]?.value;
                if (initialValue !== undefined) {
                    setFilter(f.dimension, initialValue);
                }
            }
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resolvedFilters]);

    const updateFilter = (dimension: string, value: any) => {
        setFilter(dimension, value);
        markFiltersActivated();
        setStaleStep(4); // mark query generation stale so SQL regenerates with new filters
    };

    const renderValue = (dimension: string) => activeFilters.get(dimension);
    const formatValue = (value: any) => {
        if (value && typeof value === "object" && ("from" in value || "to" in value)) {
            const from = value.from ? String(value.from) : "";
            const to = value.to ? String(value.to) : "";
            if (from && to) return `${from} → ${to}`;
            if (from) return `From ${from}`;
            if (to) return `Until ${to}`;
        }
        if (Array.isArray(value)) {
            if (value.length === 0) return "All";
            if (value.length === 1) return String(value[0]);
            return `${value.length} selected`;
        }
        if (value === undefined || value === null || value === "") return "All";
        return String(value);
    };

    return (
        <div className={`${styles.container} ${isCompact ? styles.compactContainer : ""}`}>
            {!isCompact && (
                <div className={styles.headerRow}>
                    <div className={styles.headerTitle}>
                        <Clock size={14} />
                        <span>Filters</span>
                        <span className={styles.headerCount}>{activeCount}</span>
                    </div>
                    <button
                        className={styles.clearButton}
                        onClick={() => {
                            clearAllFilters();
                            markFiltersActivated();
                            setStaleStep(4);
                        }}
                    >
                        Clear All
                    </button>
                </div>
            )}
            {resolvedFilters.map((f) => {
                const value = renderValue(f.dimension);
                const isActive = Array.isArray(value) ? value.length > 0 : Boolean(value);
            if (f.type === "date-range") {
                const options = f.options || [];
                const preset = typeof value === "string" ? value : value?.preset;
                const currentIndex = Math.max(0, options.findIndex(o => o.value === preset));
                const current = options[currentIndex] || options[0];
                const rangeValue = typeof value === "object" ? value : {};
                return (
                    <div
                        key={f.id}
                        className={`${styles.filterSection} ${isActive ? styles.filterSectionActive : ""} ${isCompact ? styles.compactSection : ""}`}
                    >
                        <div className={styles.sectionHeader}>
                            <div className={styles.sectionTitle}>
                                <Calendar size={16} />
                                <span>{f.label || "Date Range"}</span>
                            </div>
                            {!isCompact && (
                                <span className={styles.valuePill}>
                                    {current?.value === "custom"
                                        ? formatValue(value)
                                        : formatValue(current?.label || current?.value || value)}
                                </span>
                            )}
                        </div>
                        <div className={`${styles.filterContent} ${isCompact ? styles.compactContent : ""}`}>
                            <Select
                                size="large"
                                value={current?.value || current?.label || "custom"}
                                options={options.map((opt) => ({
                                    label: opt.label || String(opt.value),
                                    value: opt.value
                                }))}
                                onChange={(nextValue) => {
                                    if (nextValue === "custom") {
                                        updateFilter(f.dimension, {
                                            preset: "custom",
                                            from: rangeValue?.from || "",
                                            to: rangeValue?.to || ""
                                        });
                                    } else {
                                        updateFilter(f.dimension, nextValue);
                                    }
                                }}
                            />
                            {current?.value === "custom" && (
                                <div className={styles.customDateRange}>
                                    <Input
                                        type="date"
                                        value={rangeValue?.from || ""}
                                        onChange={(e) => {
                                            updateFilter(f.dimension, {
                                                preset: "custom",
                                                from: e.target.value,
                                                to: rangeValue?.to || ""
                                            });
                                        }}
                                    />
                                    <Input
                                        type="date"
                                        value={rangeValue?.to || ""}
                                        onChange={(e) => {
                                            updateFilter(f.dimension, {
                                                preset: "custom",
                                                from: rangeValue?.from || "",
                                                to: e.target.value
                                            });
                                        }}
                                    />
                                </div>
                            )}
                        </div>
                    </div>
                );
            }

                if (f.type === "multi-select") {
                    return (
                        <div
                            key={f.id}
                            className={`${styles.filterSection} ${isActive ? styles.filterSectionActive : ""} ${isCompact ? styles.compactSection : ""}`}
                        >
                            <div className={styles.sectionHeader}>
                                <div className={styles.sectionTitle}>
                                    <MapPin size={16} />
                                    <span>{f.label || f.dimension}</span>
                                </div>
                                {!isCompact && (
                                    <span className={styles.valuePill}>
                                        {Array.isArray(value) ? `${value.length} selected` : formatValue(value)}
                                    </span>
                                )}
                            </div>
                            <div className={`${styles.filterContent} ${isCompact ? styles.compactContent : ""}`}>
                                <Select
                                    mode="multiple"
                                    size="large"
                                    value={Array.isArray(value) ? value : []}
                                    options={(f.options || []).map((opt) => ({
                                        label: opt.label,
                                        value: opt.value
                                    }))}
                                    onChange={(next) => updateFilter(f.dimension, next)}
                                    placeholder="Select values"
                                />
                            </div>
                        </div>
                    );
                }

                if (f.type === "select") {
                    const options = f.options || [];
                    const currentIndex = Math.max(0, options.findIndex(o => o.value === value));
                    const current = options[currentIndex] || options[0];
                    return (
                        <div
                            key={f.id}
                            className={`${styles.filterSection} ${isActive ? styles.filterSectionActive : ""} ${isCompact ? styles.compactSection : ""}`}
                        >
                            <div className={styles.sectionHeader}>
                                <div className={styles.sectionTitle}>
                                    <Layers size={16} />
                                    <span>{f.label || f.dimension}</span>
                                </div>
                                {!isCompact && (
                                    <span className={styles.valuePill}>{formatValue(current?.label || current?.value)}</span>
                                )}
                            </div>
                            <div className={`${styles.filterContent} ${isCompact ? styles.compactContent : ""}`}>
                                <Select
                                    size="large"
                                    value={current?.value}
                                    options={options.map((opt) => ({
                                        label: opt.label || String(opt.value),
                                        value: opt.value
                                    }))}
                                    onChange={(nextValue) => updateFilter(f.dimension, nextValue)}
                                />
                            </div>
                        </div>
                    );
                }

                if (f.type === "search") {
                    return (
                        <div
                            key={f.id}
                            className={`${styles.filterSection} ${isActive ? styles.filterSectionActive : ""} ${isCompact ? styles.compactSection : ""}`}
                        >
                            <div className={styles.sectionHeader}>
                                <div className={styles.sectionTitle}>
                                    <Search size={16} />
                                    <span>{f.label || "Search"}</span>
                                </div>
                                {!isCompact && (
                                    <span className={styles.valuePill}>{formatValue(value)}</span>
                                )}
                            </div>
                            <div className={`${styles.filterContent} ${isCompact ? styles.compactContent : ""}`}>
                                <Input.Search
                                    size="large"
                                    value={typeof value === "string" ? value : ""}
                                    placeholder="Search"
                                    onChange={(e) => updateFilter(f.dimension, e.target.value)}
                                    allowClear
                                />
                            </div>
                        </div>
                    );
                }

                return null;
            })}
        </div>
    );
}

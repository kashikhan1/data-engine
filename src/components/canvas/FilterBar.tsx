"use client";

import React, { useEffect, useMemo } from "react";
import {
    Calendar,
    ChevronDown,
    MapPin,
    Layers,
    Clock
} from "lucide-react";
import styles from "./FilterBar.module.css";
import type { Filter } from "@/types/dashboard";
import { useDashboardStore, useWorkflowStore } from "@/state/stores";

interface FilterBarProps {
    filters?: Filter[];
}

export function FilterBar({ filters = [] }: FilterBarProps) {
    const { activeFilters, setFilter, clearFilter, clearAllFilters, markFiltersActivated } = useDashboardStore();
    const { setStaleStep } = useWorkflowStore();

    const resolvedFilters = useMemo<Filter[]>(() => filters || [], [filters]);

    // Seed provided filters into store on first render (per dimension)
    useEffect(() => {
        // clear filters not in current set
        const allowed = new Set(resolvedFilters.map(f => f.dimension));
        activeFilters.forEach((_v, key) => {
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

    const toggleMulti = (dimension: string, optionValue: string) => {
        const current = (activeFilters.get(dimension) as string[] | undefined) || [];
        const next = current.includes(optionValue)
            ? current.filter(v => v !== optionValue)
            : [...current, optionValue];
        updateFilter(dimension, next);
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
        <div className={styles.container}>
            <div className={styles.headerRow}>
                <div className={styles.headerTitle}>
                    <Clock size={14} />
                    <span>Filters</span>
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
            {resolvedFilters.map((f) => {
                const value = renderValue(f.dimension);
            if (f.type === "date-range") {
                const options = f.options || [];
                const preset = typeof value === "string" ? value : value?.preset;
                const currentIndex = Math.max(0, options.findIndex(o => o.value === preset));
                const current = options[currentIndex] || options[0];
                const rangeValue = typeof value === "object" ? value : {};
                return (
                    <div key={f.id} className={styles.filterSection}>
                        <div className={styles.sectionHeader}>
                            <div className={styles.sectionTitle}>
                                <Calendar size={16} />
                                <span>{f.label || "Date Range"}</span>
                            </div>
                            <span className={styles.valuePill}>
                                {current?.value === "custom"
                                    ? formatValue(value)
                                    : formatValue(current?.label || current?.value || value)}
                            </span>
                        </div>
                        <div className={styles.filterContent}>
                            <div
                                className={styles.periodSelect}
                                onClick={() => {
                                    if (options.length === 0) return;
                                    const next = options[(currentIndex + 1) % options.length];
                                    if (next?.value === "custom") {
                                        updateFilter(f.dimension, {
                                            preset: "custom",
                                            from: rangeValue?.from || "",
                                            to: rangeValue?.to || ""
                                        });
                                    } else {
                                        updateFilter(f.dimension, next?.value ?? value);
                                    }
                                }}
                            >
                                <span>{current?.label || current?.value || "Select range"}</span>
                                <ChevronDown size={14} />
                            </div>
                            {current?.value === "custom" && (
                                <div className={styles.customDateRange}>
                                    <input
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
                                    <input
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
                        <div key={f.id} className={styles.filterSection}>
                            <div className={styles.sectionHeader}>
                                <div className={styles.sectionTitle}>
                                    <MapPin size={16} />
                                    <span>{f.label || f.dimension}</span>
                                </div>
                                <span className={styles.valuePill}>{formatValue(value)}</span>
                            </div>
                            <div className={styles.filterContent}>
                                {(f.options || []).map((opt) => {
                                    const checked = Array.isArray(value) ? value.includes(opt.value) : false;
                                    return (
                                        <label key={opt.value} className={styles.checkboxItem}>
                                            <input
                                                type="checkbox"
                                                checked={checked}
                                                onChange={() => toggleMulti(f.dimension, opt.value as string)}
                                            />
                                            <span>{opt.label}</span>
                                        </label>
                                    );
                                })}
                            </div>
                        </div>
                    );
                }

                if (f.type === "select") {
                    const options = f.options || [];
                    const currentIndex = Math.max(0, options.findIndex(o => o.value === value));
                    const current = options[currentIndex] || options[0];
                    return (
                        <div key={f.id} className={styles.filterSection}>
                            <div className={styles.sectionHeader}>
                                <div className={styles.sectionTitle}>
                                    <Layers size={16} />
                                    <span>{f.label || f.dimension}</span>
                                </div>
                                <span className={styles.valuePill}>{formatValue(current?.label || current?.value)}</span>
                            </div>
                            <div className={styles.filterContent}>
                                <div
                                    className={styles.periodSelect}
                                    onClick={() => {
                                        if (options.length === 0) return;
                                        const next = options[(currentIndex + 1) % options.length];
                                        updateFilter(f.dimension, next?.value ?? value);
                                    }}
                                >
                                    <span>{current?.label || current?.value || "Select"}</span>
                                    <ChevronDown size={14} />
                                </div>
                            </div>
                        </div>
                    );
                }

                return null;
            })}
        </div>
    );
}

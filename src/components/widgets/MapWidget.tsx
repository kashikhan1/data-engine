"use client";

import React, { useMemo } from "react";
import dynamic from "next/dynamic";
import styles from "./MapWidget.module.css";

// Dynamic import for Vega-Lite
const VegaLite = dynamic(() => import("react-vega").then((mod) => mod.VegaLite), {
    ssr: false,
    loading: () => <div className={styles.loading}>Loading map...</div>,
});

interface MapDataPoint {
    country?: string;
    countryCode?: string;  // ISO 3166-1 alpha-2 or alpha-3
    region?: string;
    lat?: number;
    lon?: number;
    value: number;
    label?: string;
}

interface MapWidgetProps {
    data: MapDataPoint[];
    mapType?: "world" | "usa" | "choropleth" | "bubble";
    valueFormat?: "number" | "currency" | "percent";
    colorScheme?: string;
    showLegend?: boolean;
}

// Country code to name mapping for common countries
const COUNTRY_NAMES: Record<string, string> = {
    US: "United States",
    GB: "United Kingdom",
    CA: "Canada",
    DE: "Germany",
    FR: "France",
    JP: "Japan",
    AU: "Australia",
    IN: "India",
    BR: "Brazil",
    CN: "China",
    PK: "Pakistan",
    MX: "Mexico",
    KR: "South Korea",
    IT: "Italy",
    ES: "Spain",
};

export function MapWidget({
    data,
    mapType = "bubble",
    valueFormat = "number",
    colorScheme = "blues",
    showLegend = true,
}: MapWidgetProps) {
    // Use mock data if none provided
    const mapData = useMemo(() => {
        const filtered = data ? data.filter(d => !!d) : [];
        if (filtered.length > 0) return filtered;

        return [
            { country: "United States", countryCode: "US", lat: 37.0902, lon: -95.7129, value: 4500000 },
            { country: "United Kingdom", countryCode: "GB", lat: 55.3781, lon: -3.4360, value: 1200000 },
            { country: "Germany", countryCode: "DE", lat: 51.1657, lon: 10.4515, value: 980000 },
            { country: "France", countryCode: "FR", lat: 46.2276, lon: 2.2137, value: 750000 },
            { country: "Canada", countryCode: "CA", lat: 56.1304, lon: -106.3468, value: 620000 },
            { country: "Australia", countryCode: "AU", lat: -25.2744, lon: 133.7751, value: 480000 },
            { country: "Japan", countryCode: "JP", lat: 36.2048, lon: 138.2529, value: 890000 },
            { country: "India", countryCode: "IN", lat: 20.5937, lon: 78.9629, value: 350000 },
            { country: "Brazil", countryCode: "BR", lat: -14.2350, lon: -51.9253, value: 280000 },
            { country: "Pakistan", countryCode: "PK", lat: 30.3753, lon: 69.3451, value: 150000 },
        ];
    }, [data]);

    // Calculate stats
    const stats = useMemo(() => {
        const total = mapData.reduce((sum, d) => sum + d.value, 0);
        const maxValue = Math.max(...mapData.map(d => d.value));
        const topCountry = mapData.reduce((max, d) => d.value > max.value ? d : max, mapData[0]);

        return { total, maxValue, topCountry };
    }, [mapData]);

    // Format value for display
    const formatValue = (value: number): string => {
        switch (valueFormat) {
            case "currency":
                return new Intl.NumberFormat("en-US", {
                    style: "currency",
                    currency: "USD",
                    notation: "compact",
                    compactDisplay: "short",
                }).format(value);
            case "percent":
                return `${value.toFixed(1)}%`;
            default:
                return new Intl.NumberFormat("en-US", {
                    notation: "compact",
                    compactDisplay: "short",
                }).format(value);
        }
    };

    // Vega-Lite spec for bubble map
    const vegaSpec = useMemo(() => ({
        $schema: "https://vega.github.io/schema/vega-lite/v5.json",
        width: "container",
        height: 200,
        padding: 10,
        projection: { type: "equalEarth" },
        layer: [
            // World background
            {
                data: {
                    url: "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json",
                    format: { type: "topojson", feature: "countries" },
                },
                mark: { type: "geoshape", fill: "rgba(255,255,255,0.03)", stroke: "rgba(255,255,255,0.1)", strokeWidth: 0.5 },
            },
            // Bubbles
            {
                data: { name: "points" },
                mark: { type: "circle", opacity: 0.8 },
                encoding: {
                    longitude: { field: "lon", type: "quantitative" },
                    latitude: { field: "lat", type: "quantitative" },
                    size: {
                        field: "value",
                        type: "quantitative",
                        scale: { range: [50, 1000] },
                        legend: null,
                    },
                    color: {
                        field: "value",
                        type: "quantitative",
                        scale: { range: ["#3b82f6", "#137fec"] }, // Gradient of blues
                        legend: null,
                    },
                    tooltip: [
                        { field: "country", type: "nominal", title: "Country" },
                        { field: "value", type: "quantitative", title: "Value", format: ",.0f" },
                    ],
                },
            },
        ],
        config: {
            background: "transparent",
            view: { stroke: "transparent" },
            legend: {
                labelColor: "#94a3b8",
                titleColor: "#94a3b8",
            },
        },
    }), [colorScheme, showLegend]);

    return (
        <div className={styles.container}>
            {/* Map visualization */}
            <div className={styles.mapWrapper}>
                <VegaLite
                    spec={vegaSpec as any}
                    data={{ points: mapData }}
                    actions={false}
                />
            </div>

            {/* Stats and top countries */}
            <div className={styles.sidebar}>
                <div className={styles.statCard}>
                    <span className={styles.statLabel}>Total</span>
                    <span className={styles.statValue}>{formatValue(stats.total)}</span>
                </div>

                <div className={styles.topList}>
                    <h4>Top Regions</h4>
                    <ul>
                        {mapData
                            .sort((a, b) => b.value - a.value)
                            .slice(0, 5)
                            .map((item, i) => (
                                <li key={item.countryCode || i} className={styles.topItem}>
                                    <div className={styles.topRank}>{i + 1}</div>
                                    <div className={styles.topInfo}>
                                        <span className={styles.topName}>
                                            {item.country || COUNTRY_NAMES[item.countryCode || ""] || item.countryCode}
                                        </span>
                                        <span className={styles.topValue}>{formatValue(item.value)}</span>
                                    </div>
                                    <div
                                        className={styles.topBar}
                                        style={{ width: `${(item.value / stats.maxValue) * 100}%` }}
                                    />
                                </li>
                            ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}

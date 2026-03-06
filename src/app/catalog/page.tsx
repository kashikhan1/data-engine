"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
    Search,
    Activity,
    Database,
    ArrowLeft,
    Filter,
    ExternalLink,
    ChevronRight,
    Info
} from "lucide-react";
import styles from "./Catalog.module.css";

// Mock data for catalog
const METRICS = [
    { slug: "rev", name: "Gross Revenue", description: "Total revenue before deductions and taxes", sql: "SUM(amount)", table: "transactions", tags: ["Finance", "Core"], owner: "Finance Team", lastUpdated: "2024-12-20" },
    { slug: "wau", name: "WAU", description: "Weekly Active Users (logged in at least once in 7 days)", sql: "COUNT(DISTINCT user_id)", table: "events", tags: ["Growth", "Core"], owner: "Product Team", lastUpdated: "2024-12-24" },
    { slug: "cac", name: "CAC", description: "Customer Acquisition Cost", sql: "marketing_spend / new_customers", table: "marketing_summary", tags: ["Marketing"], owner: "Marketing Team", lastUpdated: "2024-12-15" },
    { slug: "churn", name: "Churn Rate", description: "Percentage of users who canceled their subscription", sql: "(canceled / active) * 100", table: "subscriptions", tags: ["Retention"], owner: "Success Team", lastUpdated: "2024-12-22" },
];

const DIMENSIONS = [
    { slug: "country", name: "Country", type: "string", table: "users", description: "User's primary country of residence" },
    { slug: "device", name: "Device Type", type: "string", table: "events", description: "User's device category (mobile, desktop, tablet)" },
    { slug: "plan", name: "Plan Name", type: "string", table: "subscriptions", description: "Subscription tier level" },
];

type CatalogMetric = (typeof METRICS)[number];
type CatalogDimension = (typeof DIMENSIONS)[number];

export default function Catalog() {
    const [searchQuery, setSearchQuery] = useState("");
    const [activeType, setActiveType] = useState<"metrics" | "dimensions">("metrics");
    const [selectedItem, setSelectedItem] = useState<CatalogMetric | CatalogDimension | null>(null);

    const filteredMetrics = METRICS.filter(m =>
        m.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        m.description.toLowerCase().includes(searchQuery.toLowerCase())
    );

    const filteredDimensions = DIMENSIONS.filter(d =>
        d.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        d.description.toLowerCase().includes(searchQuery.toLowerCase())
    );

    return (
        <div className={styles.container}>
            {/* Header */}
            <header className={styles.header}>
                <div className={styles.headerTop}>
                    <Link href="/" className={styles.backButton}>
                        <ArrowLeft size={18} />
                        <span>Workspace</span>
                    </Link>
                    <div className={styles.headerActions}>
                        <button className={styles.syncButton}>
                            <Database size={16} />
                            <span>Sync Schema</span>
                        </button>
                    </div>
                </div>
                <div className={styles.headerContent}>
                    <h1>Semantic Catalog</h1>
                    <p>Browse and manage the source of truth for your business metrics and dimensions.</p>
                </div>
            </header>

            {/* Main Layout */}
            <div className={styles.layout}>
                {/* Left Sidebar - Filters & Navigation */}
                <aside className={styles.sidebar}>
                    <div className={styles.searchBar}>
                        <Search size={18} />
                        <input
                            type="text"
                            placeholder="Filter catalog..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                        />
                    </div>

                    <div className={styles.typeSwitcher}>
                        <button
                            className={`${styles.typeButton} ${activeType === "metrics" ? styles.active : ""}`}
                            onClick={() => setActiveType("metrics")}
                        >
                            <Activity size={18} />
                            <span>Metrics</span>
                            <span className={styles.badge}>{METRICS.length}</span>
                        </button>
                        <button
                            className={`${styles.typeButton} ${activeType === "dimensions" ? styles.active : ""}`}
                            onClick={() => setActiveType("dimensions")}
                        >
                            <Database size={18} />
                            <span>Dimensions</span>
                            <span className={styles.badge}>{DIMENSIONS.length}</span>
                        </button>
                    </div>

                    <div className={styles.filterGroup}>
                        <div className={styles.filterHeader}>
                            <Filter size={14} />
                            <span>Categories</span>
                        </div>
                        <div className={styles.filterList}>
                            {["Finance", "Marketing", "Core", "Retention", "Growth"].map(cat => (
                                <label key={cat} className={styles.filterItem}>
                                    <input type="checkbox" />
                                    <span>{cat}</span>
                                </label>
                            ))}
                        </div>
                    </div>
                </aside>

                {/* Content Area */}
                <main className={styles.content}>
                    <div className={styles.list}>
                        {activeType === "metrics" ? (
                            filteredMetrics.map(metric => (
                                <div
                                    key={metric.slug}
                                    className={`${styles.item} ${selectedItem?.slug === metric.slug ? styles.selected : ""}`}
                                    onClick={() => setSelectedItem(metric)}
                                >
                                    <div className={styles.itemHeader}>
                                        <div className={styles.itemTitle}>
                                            <h3>{metric.name}</h3>
                                            <code>{metric.slug}</code>
                                        </div>
                                        <ChevronRight size={18} />
                                    </div>
                                    <p className={styles.itemDesc}>{metric.description}</p>
                                    <div className={styles.itemMeta}>
                                        <span className={styles.itemTable}>
                                            <Database size={12} />
                                            {metric.table}
                                        </span>
                                        <div className={styles.tags}>
                                            {metric.tags.map(tag => (
                                                <span key={tag} className={styles.tag}>{tag}</span>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            ))
                        ) : (
                            filteredDimensions.map(dim => (
                                <div
                                    key={dim.slug}
                                    className={`${styles.item} ${selectedItem?.slug === dim.slug ? styles.selected : ""}`}
                                    onClick={() => setSelectedItem(dim)}
                                >
                                    <div className={styles.itemHeader}>
                                        <div className={styles.itemTitle}>
                                            <h3>{dim.name}</h3>
                                            <code>{dim.slug}</code>
                                        </div>
                                        <ChevronRight size={18} />
                                    </div>
                                    <p className={styles.itemDesc}>{dim.description}</p>
                                    <div className={styles.itemMeta}>
                                        <span className={styles.itemType}>{dim.type}</span>
                                        <span className={styles.itemTable}>
                                            <Database size={12} />
                                            {dim.table}
                                        </span>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </main>

                {/* Right Detail Panel */}
                <aside className={styles.detail}>
                    {selectedItem ? (
                        <div className={styles.detailView}>
                            <div className={styles.detailHeader}>
                                <div className={styles.detailIcon}>
                                    {activeType === "metrics" ? <Activity size={24} /> : <Database size={24} />}
                                </div>
                                <h2>{selectedItem.name}</h2>
                                <code>{selectedItem.slug}</code>
                            </div>

                            <div className={styles.detailSection}>
                                <h4>Description</h4>
                                <p>{selectedItem.description}</p>
                            </div>

                            {activeType === "metrics" && (
                                <div className={styles.detailSection}>
                                    <h4>SQL Definition</h4>
                                    <pre className={styles.codeBlock}>
                                        <code>{selectedItem.sql}</code>
                                    </pre>
                                </div>
                            )}

                            <div className={styles.detailSection}>
                                <h4>Properties</h4>
                                <div className={styles.propGrid}>
                                    <div className={styles.propItem}>
                                        <span className={styles.propLabel}>Source Table</span>
                                        <span className={styles.propValue}>{selectedItem.table}</span>
                                    </div>
                                    {activeType === "metrics" ? (
                                        <>
                                            <div className={styles.propItem}>
                                                <span className={styles.propLabel}>Owner</span>
                                                <span className={styles.propValue}>{selectedItem.owner}</span>
                                            </div>
                                            <div className={styles.propItem}>
                                                <span className={styles.propLabel}>Last Updated</span>
                                                <span className={styles.propValue}>{selectedItem.lastUpdated}</span>
                                            </div>
                                        </>
                                    ) : (
                                        <div className={styles.propItem}>
                                            <span className={styles.propLabel}>Data Type</span>
                                            <span className={styles.propValue}>{selectedItem.type}</span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className={styles.detailActions}>
                                <Link href={`/studio?query=Analyze ${selectedItem.name}`} className={styles.primaryAction}>
                                    <Activity size={16} />
                                    <span>Analyze in Studio</span>
                                </Link>
                                <button className={styles.secondaryAction}>
                                    <ExternalLink size={16} />
                                    <span>View Data Lineage</span>
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className={styles.emptyDetail}>
                            <Info size={48} />
                            <p>Select an item to view its definition, SQL, and lineage.</p>
                        </div>
                    )}
                </aside>
            </div>
        </div>
    );
}

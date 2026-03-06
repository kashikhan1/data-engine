"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
    ArrowLeft,
    Search,
    Play,
    ChevronRight,
    Layers,
    Sparkles
} from "lucide-react";
import styles from "./Recipes.module.css";

const CATEGORIES = ["All", "Finance", "Marketing", "Product", "Sales", "Engineering"];

const RECIPES = [
    {
        id: "rec_1",
        name: "SaaS Metrics Overview",
        description: "Executive-level view of MRR, Churn, CAC, and LTV. Essential for tracking health of subscription businesses.",
        category: "Finance",
        usageCount: 1240,
        createdBy: "System",
        tags: ["MRR", "Churn", "CAC"],
        color: "#6366f1"
    },
    {
        id: "rec_2",
        name: "Marketing Funnel Analysis",
        description: "Detailed breakdown of the conversion funnel from landing page sessions to signups and purchases.",
        category: "Marketing",
        usageCount: 850,
        createdBy: "System",
        tags: ["Funnel", "Conversion", "Attribution"],
        color: "#ec4899"
    },
    {
        id: "rec_3",
        name: "User Retention Cohorts",
        description: "Analyze how well you retain users over time. Groups users by their signup month and tracks weekly retention.",
        category: "Product",
        usageCount: 2100,
        createdBy: "System",
        tags: ["Retention", "Cohorts", "Engagement"],
        color: "#10b981"
    },
    {
        id: "rec_4",
        name: "Regional Sales Performance",
        description: "Map view of sales distribution by country and city, with trend analysis for top markets.",
        category: "Sales",
        usageCount: 420,
        createdBy: "Finance Team",
        tags: ["Sales", "Maps", "Geography"],
        color: "#f59e0b"
    },
    {
        id: "rec_5",
        name: "API Error Monitoring",
        description: "Real-time tracking of 4xx and 5xx errors by endpoint and region code.",
        category: "Engineering",
        usageCount: 156,
        createdBy: "Infra Team",
        tags: ["Errors", "Logs", "DevOps"],
        color: "#ef4444"
    },
];

export default function Recipes() {
    const [searchQuery, setSearchQuery] = useState("");
    const [activeCategory, setActiveCategory] = useState("All");

    const filteredRecipes = RECIPES.filter(r => {
        const matchesSearch = r.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            r.description.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesCategory = activeCategory === "All" || r.category === activeCategory;
        return matchesSearch && matchesCategory;
    });

    return (
        <div className={styles.container}>
            {/* Header */}
            <header className={styles.header}>
                <div className={styles.headerTop}>
                    <Link href="/" className={styles.backButton}>
                        <ArrowLeft size={18} />
                        <span>Workspace</span>
                    </Link>
                    <div className={styles.premiumBadge}>
                        <Sparkles size={14} />
                        <span>Pro Recipes</span>
                    </div>
                </div>
                <div className={styles.headerContent}>
                    <h1>Report Recipes</h1>
                    <p>Curated templates for common business questions. Pick a recipe and customize it to your data.</p>
                </div>
            </header>

            {/* Toolkit */}
            <div className={styles.toolkit}>
                <div className={styles.searchBar}>
                    <Search size={18} />
                    <input
                        type="text"
                        placeholder="Find a recipe..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                </div>

                <div className={styles.categories}>
                    {CATEGORIES.map(cat => (
                        <button
                            key={cat}
                            className={`${styles.categoryBtn} ${activeCategory === cat ? styles.active : ""}`}
                            onClick={() => setActiveCategory(cat)}
                        >
                            {cat}
                        </button>
                    ))}
                </div>
            </div>

            {/* Grid */}
            <main className={styles.main}>
                <div className={styles.grid}>
                    {filteredRecipes.map(recipe => (
                        <div key={recipe.id} className={styles.card}>
                            <div className={styles.cardHeader} style={{ backgroundColor: recipe.color + '15' }}>
                                <div className={styles.recipeIcon} style={{ color: recipe.color, backgroundColor: recipe.color + '25' }}>
                                    <Layers size={24} />
                                </div>
                                <div className={styles.usage}>
                                    <Play size={10} fill="currentColor" />
                                    <span>{recipe.usageCount.toLocaleString()} runs</span>
                                </div>
                            </div>

                            <div className={styles.cardContent}>
                                <div className={styles.cardTop}>
                                    <span className={styles.category}>{recipe.category}</span>
                                    <h3>{recipe.name}</h3>
                                </div>
                                <p className={styles.description}>{recipe.description}</p>

                                <div className={styles.tags}>
                                    {recipe.tags.map(tag => (
                                        <span key={tag} className={styles.tag}>
                                            #{tag}
                                        </span>
                                    ))}
                                </div>

                                <div className={styles.footer}>
                                    <div className={styles.author}>
                                        <div className={styles.avatar}>
                                            {recipe.createdBy[0]}
                                        </div>
                                        <span>{recipe.createdBy}</span>
                                    </div>
                                    <Link href={`/studio?recipe=${recipe.id}`} className={styles.runBtn}>
                                        <span>Use Recipe</span>
                                        <ChevronRight size={16} />
                                    </Link>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {filteredRecipes.length === 0 && (
                    <div className={styles.emptyState}>
                        <Search size={48} />
                        <h3>No recipes found</h3>
                        <p>Try adjusting your search or filters to find what you're looking for.</p>
                        <button onClick={() => { setSearchQuery(""); setActiveCategory("All"); }}>
                            Clear all filters
                        </button>
                    </div>
                )}
            </main>
        </div>
    );
}

export const AGENT_ROLES = {
    PLANNER: "Senior Dashboard Strategist & Data Architect",
    SQL_ENGINEER: "Senior PostgreSQL Engineer & Performance Specialist",
    SQL_SERVER_ENGINEER: "Senior MSSQL / SQL Server Engineer",
    FINAL_PLANNER: "Chief Product Officer & UX Architect"
};

export const SQL_GENERATION_RULES = {
    POSTGRES: [
        "PLAN ADHERENCE: Use the exact 'metric' and 'dim' defined in the plan. The plan's 'Uses' field tells you the exact table.column and aggregation.",
        "ZERO HALLUCINATION: Only use tables/columns listed in SCHEMA. Never invent columns.",
        "CASE SENSITIVITY: Use DOUBLE QUOTES for ALL identifiers (e.g. \"TableName\".\"ColumnName\").",
        "NULL SAFETY: If the plan's Notes say a column has high nulls or mentions COALESCE, wrap it: COALESCE(\"column\", 0). For text use COALESCE(\"column\", '').",
        "TYPE-AWARE AGGREGATES: For 'kpi' widgets, always use COALESCE(aggregate, 0). For NULLable measure columns, wrap the column in COALESCE before aggregating.",
        "ENUM FILTER: If the plan's Notes list enum values (e.g. 'status IN (active, inactive)'), generate a WHERE clause using those exact values. Use template variable {{status}} for dynamic filters.",
        "SKEWED COLUMNS: If the plan's Notes say a column is SKEWED, use PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY \"column\") instead of AVG.",
        "RELATIONSHIP NAVIGATOR: Use RELATIONSHIPS for JOINs. If the plan says 'LEFT JOIN (dim)', use LEFT JOIN. If it says 'INNER JOIN (junction)', use INNER JOIN.",
        "DYNAMIC TABLES: For 'table' widgets, you MUST use 'SELECT *' or explicitly select ALL listed columns. Include a global search WHERE clause: (CAST(\"col1\" AS TEXT) ILIKE '%' || {{__search}} || '%' OR CAST(\"col2\" AS TEXT) ILIKE '%' || {{__search}} || '%').",
        "PAGINATION & TEMPLATES: ALWAYS include 'COUNT(*) OVER() AS total_count'. ALWAYS use 'OFFSET {{offset}} LIMIT {{size}}'. Use template variables like {{status}} or {{category}} if they appear in 'Filters applied'.",
        "TIME GROUPING: Use DATE_TRUNC('month', \"date_col\") or DATE_TRUNC('week', ...) for trend charts. For 'last 30 days' use: WHERE \"date_col\" >= CURRENT_DATE - INTERVAL '30 days'.",
        "PII GUARD: If a column is labeled [PII] in the plan, never SELECT or GROUP BY it directly. Use COUNT(*) or aggregated forms only."
    ],
    MSSQL: [
        "NO LIMIT: Use TOP or OFFSET/FETCH for pagination.",
        "PAGINATION TEMPLATES: Always use 'OFFSET {{offset}} ROWS FETCH NEXT {{size}} ROWS ONLY'.",
        "DATE MATH: Use GETDATE(), DATEADD, DATEDIFF. NO DATE_TRUNC. For month grouping: DATEADD(month, DATEDIFF(month, 0, \"date_col\"), 0).",
        "IDENTIFIERS: Use double quotes or square brackets [Table].[Column].",
        "NULL SAFETY: Wrap nullable measures with ISNULL(\"column\", 0). For text use ISNULL(\"column\", '').",
        "DYNAMIC TABLES: For 'table' widgets, you MUST use 'SELECT *' or select ALL columns. Include global search: (CAST(\"col1\" AS VARCHAR(MAX)) LIKE '%' + {{__search}} + '%').",
        "TOTAL COUNT: Include 'COUNT(*) OVER() AS total_count'.",
        "PII GUARD: If a column is labeled [PII] in the plan, never SELECT or GROUP BY it directly."
    ]
};

export const PLANNING_DECENTRALIZED = {
    PROJECT_BRIEF_TEMPLATE: (intent: string, strategy: string, filters: string, context: string) => `
    PROJECT BRIEF:
    - User Intent: "${intent}"
    - Core Strategy: ${strategy}
    - Configured Filters: ${filters}
    - Technical Context: ${context}
    `,
    WIDGET_GEN_RULES: [
        "Business-First: Titles should be executive-friendly (e.g., 'Revenue Velocity' not 'Sum of amount').",
        "Metric Precision: Define exactly what column and aggregation to use.",
        "Data Context: Use the provided Schema and Table Insights.",
        "Interactivity: Identify which filters (from the Brief) should affect this widget."
    ],
    ASSEMBLER_RULES: [
        "Cohesion: Ensure a logical flow (KPIs -> Trends -> Breakdowns -> Details).",
        "Deduplication: Merge similar widgets. Max 8 total widgets.",
        "Layout Logic: Assign layout hints (row1 for KPIs, row2-3 for charts, row4 for tables)."
    ]
};

export const AGENT_ROLES = {
    PLANNER: "Senior Dashboard Strategist & Data Architect",
    SQL_ENGINEER: "Senior PostgreSQL Engineer & Performance Specialist",
    SQL_SERVER_ENGINEER: "Senior MSSQL / SQL Server Engineer",
    FINAL_PLANNER: "Chief Product Officer & UX Architect"
};

export const SQL_GENERATION_RULES = {
    POSTGRES: [
        "PLAN ADHERENCE: Use the exact 'metric' and 'dim' defined in the plan.",
        "ZERO HALLUCINATION: Only use tables/columns listed in SCHEMA.",
        "CASE SENSITIVITY: Use DOUBLE QUOTES for ALL identifiers (e.g. \"TableName\".\"ColumnName\").",
        "TYPE-AWARE AGGREGATES: For 'kpi' widgets, use COALESCE(COUNT(*), 0) or similar. Handle NULLs.",
        "RELATIONSHIP NAVIGATOR: Use RELATIONSHIPS for JOINs. Use LEFT JOIN if data might be missing.",
        "DYNAMIC TABLES: For 'table' widgets, you MUST use 'SELECT *' or explicitly select ALL columns to ensure the UI can show/hide them. Include a global search WHERE clause: (CAST(\"col1\" AS TEXT) ILIKE '%' || {{__search}} || '%' OR CAST(\"col2\" AS TEXT) ILIKE '%' || {{__search}} || '%').",
        "PAGINATION & TEMPLATES: ALWAYS include 'COUNT(*) OVER() AS total_count'. ALWAYS use 'OFFSET {{offset}} LIMIT {{size}}'. Use template variables like {{status}} or {{category}} if they appear in 'Filters applied'.",
        "POSTGRESQL RULES: Use DATE_TRUNC for grouping by time. Use ILIKE for search."
    ],
    MSSQL: [
        "NO LIMIT: Use TOP or OFFSET/FETCH for pagination.",
        "PAGINATION TEMPLATES: Always use 'OFFSET {{offset}} ROWS FETCH NEXT {{size}} ROWS ONLY'.",
        "DATE MATH: Use GETDATE(), DATEADD, DATEDIFF. NO DATE_TRUNC.",
        "IDENTIFIERS: Use double quotes or square brackets [Table].[Column].",
        "DYNAMIC TABLES: For 'table' widgets, you MUST use 'SELECT *' or select ALL columns. Include global search: (CAST(\"col1\" AS VARCHAR(MAX)) LIKE '%' + {{__search}} + '%').",
        "TOTAL COUNT: Include 'COUNT(*) OVER() AS total_count'."
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

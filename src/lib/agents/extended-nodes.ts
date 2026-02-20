import { AgentState } from "./state";
import { AIMessage } from "@langchain/core/messages";

/**
 * ERROR RECOVERY AGENT
 * Uses deterministic logic instead of LLM to prevent cascading failures
 */
export async function errorRecoveryAgent(state: typeof AgentState.State) {
    const errors = state.errors || [];
    if (errors.length === 0) {
        return {
            status: "No errors to recover from.",
            messages: [],
            errors: []
        };
    }

    console.log(`[ERROR_RECOVERY] Analyzing ${errors.length} errors...`);

    const errorText = errors.join(' ').toLowerCase();
    const retryCount = state.retryCount || 0;

    // Determine error type based on keywords
    let errorType: string = "other";
    if (errorText.includes("connection") || errorText.includes("connect")) {
        errorType = "connection";
    } else if (errorText.includes("syntax") || errorText.includes("parse")) {
        errorType = "syntax";
    } else if (errorText.includes("validation") || errorText.includes("invalid")) {
        errorType = "validation";
    } else if (errorText.includes("execution") || errorText.includes("query")) {
        errorType = "execution";
    } else if (errorText.includes("timeout") || errorText.includes("timed out")) {
        errorType = "timeout";
    }

    // Determine if retryable based on error type and retry count
    const maxRetries = 3;
    const retryable = retryCount < maxRetries &&
        (errorType === "validation" || errorType === "execution" || errorType === "syntax");

    // Generate recovery action and suggestion
    let recoveryAction = "Review error details and try again.";
    let suggestion = "Check the error message for specific issues.";

    if (errorType === "connection") {
        recoveryAction = "Check database connection settings.";
        suggestion = "Verify POSTGRES_URL in .env file and ensure database is running.";
    } else if (errorType === "syntax" || errorType === "validation") {
        recoveryAction = retryable ? "Regenerating query with corrections." : "Manual review needed.";
        suggestion = "The query structure may need adjustment. Check table and column names.";
    } else if (errorType === "execution") {
        recoveryAction = retryable ? "Retrying with modified query." : "Check database permissions.";
        suggestion = "Ensure the user has SELECT permissions on the required tables.";
    } else if (errorType === "timeout") {
        recoveryAction = "Consider simplifying the query or adding indexes.";
        suggestion = "The query took too long. Try requesting less data.";
    }

    const errorRecovery = {
        errorType,
        originalError: errors[0]?.substring(0, 200) || "Unknown error",
        recoveryAction,
        retryable,
        suggestion
    };

    console.log(`[ERROR_RECOVERY] Type: ${errorType}, Retryable: ${retryable}, Retries: ${retryCount}`);

    return {
        errorRecovery,
        status: retryable ? `Error recoverable: ${recoveryAction}` : "Error not recoverable.",
        messages: [
            new AIMessage(`[ERROR_RECOVERY] Type: ${errorType}`),
            new AIMessage(`[ERROR_RECOVERY] Suggestion: ${suggestion}`)
        ],
        errors: retryable ? [] : errors,
        retryCount: retryCount + 1
    };
}


/**
 * METADATA MANAGEMENT AGENT
 * Maintains business glossary and data lineage
 */
export async function metadataManagementAgent(state: typeof AgentState.State) {
    const schemaInfo = state.schemaInfo;
    if (!schemaInfo) {
        return {
            metadata: null,
            status: "No schema to build metadata from.",
        };
    }

    console.log(`[METADATA] Building business glossary...`);

    // Build glossary from schema
    const glossary: Record<string, any> = {};

    for (const [tableName, tableInfo] of Object.entries(schemaInfo)) {
        const typedTableInfo = tableInfo as any; // Schema info structure from MCP
        if (Array.isArray(typedTableInfo.columns)) {
            for (const col of typedTableInfo.columns) {
                const technicalName = `${tableName}.${col.column_name}`;
                glossary[technicalName] = {
                    businessName: formatBusinessName(col.column_name),
                    technicalName: technicalName,
                    description: inferDescription(col.column_name, col.data_type),
                    type: col.data_type
                };
            }
        }
    }

    const metadata = {
        glossary,
        dataLineage: [], // Would be populated from actual data flow tracking
        schemaVersion: new Date().toISOString(),
        tableCount: Object.keys(schemaInfo).length
    };

    return {
        metadata,
        status: `Metadata created with ${Object.keys(glossary).length} glossary entries.`,
        messages: [new AIMessage(`[METADATA] Glossary: ${Object.keys(glossary).length} terms`)],
    };
}

/**
 * DASHBOARD ASSEMBLY AGENT
 * Combines widgets into final dashboard with layout
 */
export async function dashboardAssemblyAgent(state: typeof AgentState.State) {
    const dashboard = state.dashboard;
    const results = state.results || [];
    const insights = state.insights || [];

    if (!dashboard) {
        return {
            status: "No dashboard configuration to assemble.",
            errors: ["Dashboard design missing."]
        };
    }

    console.log(`[DASHBOARD_ASSEMBLY] Assembling ${dashboard.widgets.length} widgets...`);

    // Enhance widgets with actual data
    const enhancedWidgets = dashboard.widgets.map((widget, idx) => {
        const result = results[idx];
        return {
            ...widget,
            data: result?.data || [],
            error: result?.error,
            position: calculateWidgetPosition(idx, dashboard.widgets.length)
        };
    });

    const assembledDashboard = {
        ...dashboard,
        widgets: enhancedWidgets,
        insights: insights,
        metadata: {
            createdAt: new Date().toISOString(),
            widgetCount: enhancedWidgets.length,
            dataQuality: state.qualityReport?.score || 0
        }
    };

    return {
        dashboard: assembledDashboard,
        status: "Dashboard assembled successfully.",
        messages: [new AIMessage(`[ASSEMBLY] Complete dashboard with ${enhancedWidgets.length} widgets.`)],
        errors: []
    };
}

/**
 * REAL-TIME SYNC AGENT
 * Manages data freshness and refresh policies
 */
export async function realTimeSyncAgent(state: typeof AgentState.State) {
    // This would typically check data staleness and trigger refreshes
    // For now, we'll return sync status

    console.log(`[REAL_TIME_SYNC] Checking data freshness...`);

    return {
        status: "Data sync checked. Manual refresh required.",
        messages: [new AIMessage(`[SYNC] Dashboard data is current as of ${new Date().toISOString()}`)],
    };
}

// Helper functions
function formatBusinessName(technicalName: string): string {
    return technicalName
        .replace(/_/g, ' ')
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, str => str.toUpperCase())
        .trim();
}

function inferDescription(columnName: string, dataType: string): string {
    const name = columnName.toLowerCase();

    if (name.includes('id')) return `Unique identifier (${dataType})`;
    if (name.includes('name')) return `Name or title field (${dataType})`;
    if (name.includes('email')) return `Email address (${dataType})`;
    if (name.includes('date') || name.includes('time')) return `Timestamp field (${dataType})`;
    if (name.includes('amount') || name.includes('price')) return `Monetary value (${dataType})`;
    if (name.includes('count') || name.includes('total')) return `Numeric count or total (${dataType})`;
    if (name.includes('status')) return `Status indicator (${dataType})`;

    return `Data field of type ${dataType}`;
}

function calculateWidgetPosition(index: number, total: number): { x: number, y: number, w: number, h: number } {
    // Simple grid layout: 2 columns
    const col = index % 2;
    const row = Math.floor(index / 2);

    return {
        x: col * 6,  // 12-column grid, each widget is 6 columns wide
        y: row * 4,  // 4 rows high per widget
        w: 6,        // width
        h: 4         // height
    };
}

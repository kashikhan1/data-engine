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

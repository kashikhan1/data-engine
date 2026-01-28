export interface RunParams {
    query: string;
    options: {
        dashboardId?: string;
        recipeId?: string;
        context?: any;
    };
}

// Global registry for run parameters, preserved during Next.js HMR
const globalForRunRegistry = globalThis as unknown as {
    runRegistry: Map<string, RunParams> | undefined;
};

export const runRegistry =
    globalForRunRegistry.runRegistry ?? new Map<string, RunParams>();

if (process.env.NODE_ENV !== "production") {
    globalForRunRegistry.runRegistry = runRegistry;
}

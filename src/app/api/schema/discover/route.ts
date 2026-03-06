import { NextRequest, NextResponse } from "next/server";

import { runSchemaDiscoveryServer } from "@/modules/schema/agent";

export const maxDuration = 900;

const schemaCache = new Map<string, { data: unknown; expiry: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCacheKey(body: unknown): string {
    const normalized = JSON.stringify({
        connection: (body as any)?.connection || (body as any)?.connectionString,
        connectorType: (body as any)?.connectorType,
        allowedTables: (body as any)?.allowedTables,
        options: {
            enableSemanticSearch: (body as any)?.options?.enableSemanticSearch,
            enableTableKpis: (body as any)?.options?.enableTableKpis,
            enableTableMatrix: (body as any)?.options?.enableTableMatrix,
            enableTableFilters: (body as any)?.options?.enableTableFilters,
        }
    });
    return Buffer.from(normalized).toString("base64");
}

function getCached(key: string): unknown | null {
    const entry = schemaCache.get(key);
    if (entry && entry.expiry > Date.now()) {
        return entry.data;
    }
    schemaCache.delete(key);
    return null;
}

function setCached(key: string, data: unknown): void {
    schemaCache.set(key, { data, expiry: Date.now() + CACHE_TTL_MS });
}

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const {
            connection,
            connectionString,
            connectorType,
            options,
            allowedTables,
            routingContext,
            useCache = true
        }: {
            connection?: string;
            connectionString?: string;
            connectorType?: string;
            options?: {
                enableSemanticSearch?: boolean;
                enableTableKpis?: boolean;
                enableTableMatrix?: boolean;
                enableTableFilters?: boolean;
                projectContext?: string;
            };
            allowedTables?: string[];
            routingContext?: {
                schemaHint?: string;
                projectContext?: string;
            };
            useCache?: boolean;
        } = body || {};

        const effectiveConnection = connection || connectionString;
        
        if (useCache && effectiveConnection) {
            const cacheKey = getCacheKey(body);
            const cached = getCached(cacheKey);
            if (cached) {
                return NextResponse.json({ ...cached as object, _cached: true });
            }
        }

        const result = await runSchemaDiscoveryServer({
            connection: effectiveConnection,
            connectorType,
            options: options || {},
            allowedTables: Array.isArray(allowedTables) ? allowedTables : undefined,
            routingContext
        });

        if (useCache && effectiveConnection && result?.tables?.length > 0) {
            const cacheKey = getCacheKey(body);
            setCached(cacheKey, result);
        }

        return NextResponse.json(result);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Schema discovery failed";
        
        let userMessage = message;
        if (message.includes("ECONNREFUSED") || message.includes("connection refused")) {
            userMessage = "Cannot connect to database. Please check your connection settings and ensure the database is running.";
        } else if (message.includes("timeout")) {
            userMessage = "Connection timed out. The database may be slow or unreachable. Please try again.";
        } else if (message.includes("authentication") || message.includes("password")) {
            userMessage = "Authentication failed. Please check your username and password.";
        } else if (message.includes("permission") || message.includes("denied")) {
            userMessage = "Access denied. Your user doesn't have permission to access this database.";
        }

        return NextResponse.json(
            { error: userMessage, _originalError: message },
            { status: 500 }
        );
    }
}

'use client';

/**
 * Client-side Proxy for MCP Gateway.
 * This file no longer contains Node.js imports. It calls Server Actions to perform the actual work.
 */
import {
    connectToPostgres,
    executeQuery,
    discoverSchema,
    getTableData,
    listTables,
    getTableSchema,
    getEnvConfig,
    testMcpConnection
} from '@/app/actions/mcp';

class DatabaseClientProxy {
    async connect(connectionString: string) {
        return await connectToPostgres(connectionString);
    }

    async runQuery(sql: string, connectionString?: string) {
        return await executeQuery(sql, connectionString);
    }

    async getSchema(connectionString?: string) {
        return await discoverSchema(connectionString);
    }

    async getTableSchema(tableName: string, connectionString?: string) {
        return await getTableSchema(tableName, connectionString);
    }

    async getTablePreview(tableName: string, connectionString?: string) {
        return await getTableData(tableName, connectionString);
    }

    async listTables(connectionString?: string) {
        return await listTables(connectionString);
    }

    async getEnvConfig() {
        return await getEnvConfig();
    }

    async testMcpConnection(endpoint: string, auth?: { authType?: string; token?: string }) {
        return await testMcpConnection(endpoint, auth);
    }
}

export const dbGateway = new DatabaseClientProxy();

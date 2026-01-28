import { executeQuery, discoverSchema, getTableData, listTables, getTableSchema } from '../../app/actions/mcp';

class MCPServerProxy {
    async runQuery(sql: string, connectionString?: string) {
        return await executeQuery(sql, connectionString);
    }

    async getSchema(connectionString?: string) {
        return await discoverSchema(connectionString);
    }

    async getTablePreview(tableName: string, connectionString?: string) {
        return await getTableData(tableName, connectionString);
    }

    async listTables(connectionString?: string) {
        return await listTables(connectionString);
    }

    async getTableSchema(tableName: string, connectionString?: string) {
        return await getTableSchema(tableName, connectionString);
    }
}

export const dbGateway = new MCPServerProxy();

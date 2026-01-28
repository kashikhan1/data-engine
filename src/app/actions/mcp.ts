'use server';

import postgres from 'postgres';
import mssql from 'mssql';
import path from 'path';

function stripLeadingSqlComments(sql: string) {
    let text = sql.trimStart();
    while (true) {
        if (text.startsWith('--')) {
            const nextLine = text.indexOf('\n');
            if (nextLine === -1) return '';
            text = text.slice(nextLine + 1).trimStart();
            continue;
        }
        if (text.startsWith('/*')) {
            const endBlock = text.indexOf('*/');
            if (endBlock === -1) return '';
            text = text.slice(endBlock + 2).trimStart();
            continue;
        }
        return text;
    }
}

/**
 * Server-side Direct Postgres Gateway.
 * Replaces MCP Proxy for better reliability and performance.
 */
class DirectPostgresGateway {
    private sql: any = null;
    private currentConfig: string | null = null;

    async connect(connectionString: string) {
        const envUrl = process.env.POSTGRES_URL;
        const targetUrl = connectionString || envUrl;

        if (!targetUrl) {
            console.error("[POSTGRES] No connection string available.");
            return false;
        }

        if (this.sql && this.currentConfig === targetUrl) {
            return true;
        }

        if (this.sql) {
            try { await this.sql.end({ timeout: 5 }); } catch (e) { }
        }

        try {
            const maskedUrl = targetUrl.replace(/:[^:@]+@/, ':***@');
            console.log(`[POSTGRES] Connecting directly to ${maskedUrl}`);

            this.sql = postgres(targetUrl, {
                ssl: targetUrl.includes('amazonaws.com') ? { rejectUnauthorized: false } : undefined,
                max: 10,
                idle_timeout: 30,
                connect_timeout: 5,
            });

            await this.sql`select 1`;

            this.currentConfig = targetUrl;
            console.log("[POSTGRES] Connected successfully via postgres client.");
            return true;
        } catch (error: any) {
            console.error("[POSTGRES] Connection failed:", error.message);
            this.sql = null;
            return false;
        }
    }

    async runQuery(sql: string, connectionString?: string) {
        try {
            if (!this.sql || (connectionString && connectionString !== this.currentConfig)) {
                const connected = await this.connect(connectionString || "");
                if (!connected) {
                    return { error: "Failed to connect to the database. Please check your POSTGRES_URL." };
                }
            }

            if (!this.sql) return { error: "Postgres client not initialized." };

            const trimmedSql = stripLeadingSqlComments(sql).trim().toUpperCase();
            if (!trimmedSql.startsWith('SELECT') && !trimmedSql.startsWith('WITH') && !trimmedSql.startsWith('SHOW') && !trimmedSql.startsWith('EXPLAIN')) {
                return { error: "Only SELECT and EXPLAIN queries are allowed." };
            }

            const result = await this.sql.unsafe(sql);
            return normalizeRows(Array.isArray(result) ? result : []);
        } catch (error: any) {
            console.error(`[POSTGRES] Query Error: ${error.message}`);
            return { error: error.message };
        }
    }
}

class DirectMssqlGateway {
    private pool: mssql.ConnectionPool | null = null;
    private currentConfig: string | null = null;

    private parseSqlServerUrl(rawUrl: string) {
        if (!rawUrl.toLowerCase().startsWith('sqlserver://')) return null;
        const withoutScheme = rawUrl.replace(/^sqlserver:\/\//i, '');
        const slashIndex = withoutScheme.indexOf('/');
        if (slashIndex === -1) return null;
        const hostPart = withoutScheme.slice(0, slashIndex);
        const dbPart = withoutScheme.slice(slashIndex + 1);
        const [databaseRaw, queryRaw] = dbPart.split('?');
        if (!databaseRaw) return null;

        const atIndex = hostPart.lastIndexOf('@');
        const userInfo = atIndex >= 0 ? hostPart.slice(0, atIndex) : '';
        const hostInfo = atIndex >= 0 ? hostPart.slice(atIndex + 1) : hostPart;
        const [server, portRaw] = hostInfo.split(':');
        if (!server) return null;

        let user = '';
        let password = '';
        if (userInfo) {
            const colonIndex = userInfo.indexOf(':');
            if (colonIndex >= 0) {
                user = decodeURIComponent(userInfo.slice(0, colonIndex));
                password = decodeURIComponent(userInfo.slice(colonIndex + 1));
            } else {
                user = decodeURIComponent(userInfo);
            }
        }

        const params = new URLSearchParams(queryRaw || '');
        const encryptParam = params.get('encrypt');
        const trustParam = params.get('trustServerCertificate');

        return {
            server,
            port: portRaw ? Number(portRaw) : undefined,
            database: decodeURIComponent(databaseRaw),
            user,
            password,
            options: {
                encrypt: encryptParam ? encryptParam === 'true' : true,
                trustServerCertificate: trustParam ? trustParam === 'true' : true,
            }
        };
    }

    async connect(connectionString: string) {
        const envUrl = process.env.MSSQL_URL;
        const targetUrl = connectionString || envUrl;

        if (!targetUrl) {
            console.error("[MSSQL] No connection string available.");
            return false;
        }

        if (this.pool && this.currentConfig === targetUrl) {
            return true;
        }

        if (this.pool) {
            try { await this.pool.close(); } catch (e) { }
        }

        try {
            const maskedUrl = targetUrl.replace(/(Password=)[^;]+/i, '$1***').replace(/:[^:@]+@/, ':***@');
            console.log(`[MSSQL] Connecting directly to ${maskedUrl}`);

            const parsed = this.parseSqlServerUrl(targetUrl);
            if (parsed) {
                this.pool = await mssql.connect(parsed);
            } else {
                this.pool = await mssql.connect(targetUrl);
            }

            await this.pool.request().query('SELECT 1');
            this.currentConfig = targetUrl;
            console.log("[MSSQL] Connected successfully via mssql client.");
            return true;
        } catch (error: any) {
            console.error("[MSSQL] Connection failed:", error.message);
            this.pool = null;
            return false;
        }
    }

    async runQuery(sql: string, connectionString?: string) {
        try {
            if (!this.pool || (connectionString && connectionString !== this.currentConfig)) {
                const connected = await this.connect(connectionString || "");
                if (!connected) {
                    return { error: "Failed to connect to the database. Please check your MSSQL_URL." };
                }
            }

            if (!this.pool) return { error: "MSSQL client not initialized." };

            const trimmedSql = stripLeadingSqlComments(sql).trim().toUpperCase();
            if (!trimmedSql.startsWith('SELECT') && !trimmedSql.startsWith('WITH')) {
                return { error: "Only SELECT queries are allowed." };
            }

            const result = await this.pool.request().query(sql);
            return normalizeRows(Array.isArray(result.recordset) ? result.recordset : []);
        } catch (error: any) {
            console.error(`[MSSQL] Query Error: ${error.message}`);
            return { error: error.message };
        }
    }
}

function normalizeRows(rows: any[]) {
    return rows.map((row, index) => {
        const normalized: Record<string, any> = {};
        Object.entries(row || {}).forEach(([key, value]) => {
            normalized[key] = normalizeValue(value);
        });
        const fingerprint = JSON.stringify(normalized);
        normalized.__rowKey = `${index}-${fingerprint}`;
        return normalized;
    });
}

function normalizeValue(value: any): any {
    if (value === null || value === undefined) return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'object') {
        // Convert class instances (e.g. interval types) to plain JSON-friendly objects
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return String(value);
        }
    }
    return value;
}

const globalPostgres = new DirectPostgresGateway();
const globalMssql = new DirectMssqlGateway();

function isMssqlConnectionString(connectionString?: string) {
    if (!connectionString) return false;
    const lower = connectionString.toLowerCase();
    return lower.startsWith('mssql://') ||
        lower.startsWith('sqlserver://') ||
        lower.includes('server=') ||
        lower.includes('data source=');
}

function resolveGateway(connectionString?: string) {
    const envFallback = process.env.POSTGRES_URL || process.env.MSSQL_URL || '';
    const targetUrl = connectionString || envFallback;
    if (isMssqlConnectionString(targetUrl)) {
        return { type: 'mssql' as const, gateway: globalMssql, targetUrl };
    }
    return { type: 'postgres' as const, gateway: globalPostgres, targetUrl };
}

function quoteIdent(name: string, type: 'postgres' | 'mssql') {
    if (type === 'mssql') {
        return `[${name.replace(/]/g, ']]')}]`;
    }
    return `"${name.replace(/"/g, '""')}"`;
}

export async function connectToPostgres(url: string) {
    const { gateway, targetUrl } = resolveGateway(url);
    return await gateway.connect(targetUrl);
}

export async function executeQuery(sql: string, url?: string) {
    const { gateway, targetUrl } = resolveGateway(url);
    return await gateway.runQuery(sql, targetUrl);
}

export async function discoverSchema(url?: string) {
    const { type, gateway, targetUrl } = resolveGateway(url);
    const schemaName = type === 'mssql' ? 'dbo' : 'public';
    let query = `
        SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns 
        WHERE table_schema = '${schemaName}'
    `;

    console.log("[POSTGRES_DEBUG] discoverSchema: No filtering, fetching all public tables.");

    const allColumns = await gateway.runQuery(query, targetUrl);
    if (allColumns && (allColumns as any).error) {
        console.error("[POSTGRES_DEBUG] discoverSchema query error:", (allColumns as any).error);
        return allColumns;
    }

    const schemaInfo: Record<string, any> = {};
    if (Array.isArray(allColumns)) {
        console.log(`[POSTGRES_DEBUG] discoverSchema: Found ${allColumns.length} columns in total.`);
        allColumns.forEach((col: any) => {
            if (!schemaInfo[col.table_name]) {
                schemaInfo[col.table_name] = { columns: [] };
            }
            schemaInfo[col.table_name].columns.push({
                name: col.column_name,
                column_name: col.column_name,
                type: col.data_type,
                data_type: col.data_type,
                nullable: col.is_nullable === 'YES',
                is_nullable: col.is_nullable
            });
        });
    }

    return schemaInfo;
}

export async function getTableData(tableName: string, url?: string) {
    if (!tableName) {
        console.error("[POSTGRES_ERROR] getTableData called with undefined tableName");
        return { error: "Table name is required" };
    }
    const safeTableName = tableName;

    const { type, gateway, targetUrl } = resolveGateway(url);
    const schemaName = type === 'mssql' ? 'dbo' : 'public';
    const columns = await gateway.runQuery(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${safeTableName}' AND table_schema = '${schemaName}'`,
        targetUrl
    );
    if (columns && (columns as any).error) return columns;

    const colNames = Array.isArray(columns) ? columns.map((c: any) => c.column_name) : [];
    const timeCol = colNames.find((n: string) => (n && typeof n === 'string' && (n.toLowerCase().includes('time') || n.toLowerCase().includes('date') || n.toLowerCase().includes('created'))));

    const quotedTable = quoteIdent(safeTableName, type);
    let sql = type === 'mssql' ? `SELECT TOP 5 * FROM ${quotedTable}` : `SELECT * FROM ${quotedTable}`;
    if (timeCol) {
        sql += ` ORDER BY ${quoteIdent(timeCol, type)} DESC`;
    }
    if (type !== 'mssql') {
        sql += ` LIMIT 5`;
    }

    return await gateway.runQuery(sql, targetUrl);
}

export async function listTables(url?: string) {
    const { type, gateway, targetUrl } = resolveGateway(url);
    const schemaName = type === 'mssql' ? 'dbo' : 'public';
    const tables = await gateway.runQuery(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schemaName}' AND table_type = 'BASE TABLE'`,
        targetUrl
    );
    if (tables && (tables as any).error) {
        console.error("[POSTGRES_DEBUG] listTables query error:", (tables as any).error);
        return tables;
    }

    let tableList = Array.isArray(tables) ? tables.map((t: any) => t.table_name) : [];

    console.log(`[POSTGRES_DEBUG] Found ${tableList.length} tables in public schema.`);

    return tableList;
}

export async function getTableSchema(tableName: string, url?: string) {
    if (!tableName) {
        throw new Error("getTableSchema called with undefined tableName");
    }
    console.log(`[POSTGRES_DEBUG] getTableSchema called for: ${tableName}`);

    try {
        const { type, gateway, targetUrl } = resolveGateway(url);
        const schemaName = type === 'mssql' ? 'dbo' : 'public';

        const columns = await gateway.runQuery(`
            SELECT 
                column_name, 
                data_type, 
                is_nullable, 
                column_default 
            FROM information_schema.columns 
            WHERE table_name = '${tableName}'
                AND table_schema = '${schemaName}'
            ORDER BY ordinal_position
        `, targetUrl);

        const primaryKeys = await gateway.runQuery(`
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
                AND tc.table_name = '${tableName}'
                AND tc.table_schema = '${schemaName}'
        `, targetUrl);

        const foreignKeys = await gateway.runQuery(`
            SELECT
                kcu.column_name,
                ccu.table_name AS foreign_table_name,
                ccu.column_name AS foreign_column_name
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            JOIN information_schema.constraint_column_usage AS ccu
                ON ccu.constraint_name = tc.constraint_name
                AND ccu.table_schema = tc.table_schema
            WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_name = '${tableName}'
                AND tc.table_schema = '${schemaName}'
        `, targetUrl);

        const pkColumns = Array.isArray(primaryKeys) ? primaryKeys.map((pk: any) => pk.column_name) : [];
        const fkData = Array.isArray(foreignKeys) ? foreignKeys : [];

        return {
            columns: Array.isArray(columns) ? columns.map((col: any) => ({
                ...col,
                isPrimaryKey: pkColumns.includes(col.column_name),
                isForeignKey: fkData.some((fk: any) => fk.column_name === col.column_name)
            })) : [],
            primaryKeys: pkColumns,
            foreignKeys: fkData
        };
    } catch (err: any) {
        console.error(`[POSTGRES_ERROR] getTableSchema failed for ${tableName}:`, err.message);
        throw err;
    }
}

export async function getEnvConfig() {
    return {
        postgresUrl: process.env.POSTGRES_URL || "",
        mssqlUrl: process.env.MSSQL_URL || "",
        allowedTables: ""
    };
}

'use server';

import postgres from 'postgres';
import mssql from 'mssql';

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
    private pools = new Map<string, any>();

    private resolveSSL(connectionString: string) {
        const lower = connectionString.toLowerCase();
        // Explicit sslmode in URL
        if (lower.includes('sslmode=disable')) return false;
        if (lower.includes('sslmode=require') || lower.includes('sslmode=verify')) return { rejectUnauthorized: false };
        // Well-known cloud providers always need SSL
        if (lower.includes('amazonaws.com') || lower.includes('supabase.co') ||
            lower.includes('neon.tech') || lower.includes('cockroachdb') ||
            lower.includes('planetscale') || lower.includes('railway.app')) {
            return { rejectUnauthorized: false };
        }
        return undefined; // let the postgres driver decide
    }

    async connect(connectionString: string) {
        if (!connectionString) return false;

        if (this.pools.has(connectionString)) {
            try {
                const sql = this.pools.get(connectionString);
                await sql`SELECT 1`;
                return true;
            } catch {
                console.warn("[POSTGRES] Pool stale, reconnecting...");
                this.pools.delete(connectionString);
            }
        }

        try {
            const maskedUrl = connectionString.replace(/:[^:@]+@/, ':***@');
            console.log(`[POSTGRES] Connecting to ${maskedUrl}`);

            const sql = postgres(connectionString, {
                ssl: this.resolveSSL(connectionString),
                max: 5,
                idle_timeout: 60,       // release idle connections after 60s
                max_lifetime: 3600,     // recycle connections every hour
                connect_timeout: 30,    // 30s — handles ngrok and remote tunnels
            });

            await sql`SELECT 1`;
            this.pools.set(connectionString, sql);
            return true;
        } catch (error: any) {
            console.error("[POSTGRES] Connection failed:", error.message);
            return false;
        }
    }

    async getSql(connectionString?: string) {
        const targetUrl = connectionString || process.env.POSTGRES_URL || '';
        if (!this.pools.has(targetUrl)) {
            const ok = await this.connect(targetUrl);
            if (!ok) return null;
        }
        return this.pools.get(targetUrl);
    }

    async runQuery(sql: string, connectionString?: string) {
        try {
            const pool = await this.getSql(connectionString);
            if (!pool) return { error: "Failed to connect to the database." };

            const trimmedSql = stripLeadingSqlComments(sql).trim().toUpperCase();
            if (!trimmedSql.startsWith('SELECT') && !trimmedSql.startsWith('WITH') && !trimmedSql.startsWith('SHOW') && !trimmedSql.startsWith('EXPLAIN')) {
                return { error: "Only SELECT and EXPLAIN queries are allowed." };
            }

            const result = await pool.unsafe(sql);
            return normalizeRows(Array.isArray(result) ? result : []);
        } catch (error: any) {
            console.error(`[POSTGRES] Query Error: ${error.message}`);
            return { error: error.message };
        }
    }
}

class DirectMssqlGateway {
    private pools = new Map<string, mssql.ConnectionPool>();

    /** Parse sqlserver:// or mssql:// URL into a node-mssql config object. */
    private parseSqlServerUrl(rawUrl: string): mssql.config | null {
        const lower = rawUrl.toLowerCase();
        const isUrlScheme = lower.startsWith('sqlserver://') || lower.startsWith('mssql://');
        if (!isUrlScheme) return null;

        const withoutScheme = rawUrl.replace(/^(sqlserver|mssql):\/\//i, '');
        const slashIndex = withoutScheme.indexOf('/');
        if (slashIndex === -1) return null;

        const hostPart = withoutScheme.slice(0, slashIndex);
        const dbPart = withoutScheme.slice(slashIndex + 1);
        const [databaseRaw, queryRaw] = dbPart.split('?');
        if (!databaseRaw) return null;

        const atIndex = hostPart.lastIndexOf('@');
        const userInfo = atIndex >= 0 ? hostPart.slice(0, atIndex) : '';
        const hostInfo = atIndex >= 0 ? hostPart.slice(atIndex + 1) : hostPart;
        const colonIdx = hostInfo.lastIndexOf(':');
        const server = colonIdx >= 0 ? hostInfo.slice(0, colonIdx) : hostInfo;
        const portRaw = colonIdx >= 0 ? hostInfo.slice(colonIdx + 1) : '';
        if (!server) return null;

        let user = '';
        let password = '';
        if (userInfo) {
            const ci = userInfo.indexOf(':');
            if (ci >= 0) {
                user = decodeURIComponent(userInfo.slice(0, ci));
                password = decodeURIComponent(userInfo.slice(ci + 1));
            } else {
                user = decodeURIComponent(userInfo);
            }
        }

        const params = new URLSearchParams(queryRaw || '');
        const encryptParam = params.get('encrypt');
        const trustParam = params.get('trustServerCertificate');
        // ngrok and dev tunnels typically need trustServerCertificate=true
        const trustCert = trustParam ? trustParam === 'true' : true;
        const encrypt = encryptParam ? encryptParam === 'true' : trustCert; // if trusting cert, encryption is still on

        return {
            server,
            port: portRaw ? Number(portRaw) : 1433,
            database: decodeURIComponent(databaseRaw),
            user,
            password,
            connectionTimeout: 30000,  // 30s — handles ngrok latency
            requestTimeout: 60000,     // 60s — enough for complex analytic queries
            options: {
                encrypt,
                trustServerCertificate: trustCert,
                enableArithAbort: true,
            },
        };
    }

    async connect(connectionString: string) {
        if (!connectionString) return false;

        if (this.pools.has(connectionString)) {
            try {
                const pool = this.pools.get(connectionString)!;
                await pool.request().query('SELECT 1');
                return true;
            } catch {
                console.warn("[MSSQL] Pool stale, reconnecting...");
                this.pools.delete(connectionString);
            }
        }

        try {
            const maskedUrl = connectionString.replace(/(Password=)[^;]+/i, '$1***').replace(/:[^:@]+@/, ':***@');
            console.log(`[MSSQL] Connecting to ${maskedUrl}`);

            let pool: mssql.ConnectionPool;
            const parsed = this.parseSqlServerUrl(connectionString);
            if (parsed) {
                pool = await mssql.connect(parsed);
            } else {
                // ADO-style connection string — inject timeouts if absent
                const hasTimeout = /ConnectionTimeout=/i.test(connectionString);
                const withTimeouts = hasTimeout
                    ? connectionString
                    : `${connectionString};Connection Timeout=30`;
                pool = await mssql.connect(withTimeouts);
            }

            await pool.request().query('SELECT 1');
            this.pools.set(connectionString, pool);
            return true;
        } catch (error: any) {
            console.error("[MSSQL] Connection failed:", error.message);
            return false;
        }
    }

    async getPool(connectionString?: string) {
        // Never fall back to a different connection string than requested.
        // Falling back to process.env.MSSQL_URL would silently hit the wrong DB.
        const targetUrl = connectionString || '';
        if (!targetUrl) return null;
        if (!this.pools.has(targetUrl)) {
            const ok = await this.connect(targetUrl);
            if (!ok) return null;
        }
        return this.pools.get(targetUrl) || null;
    }

    async runQuery(sql: string, connectionString?: string) {
        try {
            const pool = await this.getPool(connectionString);
            if (!pool) return { error: "Failed to connect to the database." };

            const trimmedSql = stripLeadingSqlComments(sql).trim().toUpperCase();
            if (!trimmedSql.startsWith('SELECT') && !trimmedSql.startsWith('WITH')) {
                return { error: "Only SELECT queries are allowed." };
            }

            // Set a per-request timeout so a slow query doesn't block the pool
            const request = pool.request();
            request.timeout = 60000; // 60s
            const result = await request.query(sql);
            return normalizeRows(Array.isArray(result.recordset) ? result.recordset : []);
        } catch (error: any) {
            console.error(`[MSSQL] Query Error: ${error.message}`);
            // Evict a broken pool so the next call reconnects cleanly
            if (connectionString && this.pools.has(connectionString)) {
                const pool = this.pools.get(connectionString)!;
                const msg = String(error.message || '').toLowerCase();
                if (msg.includes('connection') || msg.includes('socket') || msg.includes('timeout')) {
                    try { await pool.close(); } catch { /* ignore */ }
                    this.pools.delete(connectionString);
                }
            }
            return { error: error.message };
        }
    }
}

export async function testConnection(url: string) {
    const { gateway, targetUrl } = resolveGateway(url);
    return await gateway.connect(targetUrl);
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
    // More precise check to avoid false positives with postgres:// or postgresql://
    if (lower.startsWith('postgres://') || lower.startsWith('postgresql://')) return false;

    return lower.startsWith('mssql://') ||
        lower.startsWith('sqlserver://') ||
        lower.includes('server=') ||
        lower.includes('data source=');
}

function resolveGateway(connectionString?: string) {
    const targetUrl = connectionString || process.env.POSTGRES_URL || process.env.MSSQL_URL || '';
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

function quoteSqlLiteral(value: string) {
    return `'${String(value || '').replace(/'/g, "''")}'`;
}

function unquoteIdentifierPart(part: string) {
    return String(part || "")
        .trim()
        .replace(/^\[|\]$/g, "")
        .replace(/^"|"$/g, "");
}

function splitQualifiedTableName(raw: string) {
    const value = String(raw || "").trim();
    if (!value) return { schema: null as string | null, table: "" };
    const normalized = value.replace(/^\[|\]$/g, "").replace(/^"|"$/g, "");
    const parts = normalized.split(".");
    if (parts.length >= 2) {
        const schema = unquoteIdentifierPart(parts[0]);
        const table = unquoteIdentifierPart(parts.slice(1).join("."));
        return { schema: schema || null, table };
    }
    return { schema: null, table: normalized };
}

async function resolveTableTarget(
    type: 'postgres' | 'mssql',
    gateway: DirectPostgresGateway | DirectMssqlGateway,
    targetUrl: string,
    requestedTable: string
) {
    const preferredSchema = type === 'mssql' ? 'dbo' : 'public';
    const parsed = splitQualifiedTableName(requestedTable);
    const tableOnly = parsed.table || String(requestedTable || "").trim();
    const explicitSchema = parsed.schema;
    if (!tableOnly) {
        return { schemaName: preferredSchema, tableName: "" };
    }

    if (explicitSchema) {
        return { schemaName: explicitSchema, tableName: tableOnly };
    }

    const tableLiteral = quoteSqlLiteral(tableOnly);
    const discovered = await gateway.runQuery(
        `
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_type = 'BASE TABLE'
          AND LOWER(table_name) = LOWER(${tableLiteral})
        ORDER BY CASE WHEN table_schema = ${quoteSqlLiteral(preferredSchema)} THEN 0 ELSE 1 END, table_schema
        `,
        targetUrl
    );

    if (Array.isArray(discovered) && discovered.length > 0) {
        return {
            schemaName: String(discovered[0].table_schema || preferredSchema),
            tableName: String(discovered[0].table_name || tableOnly),
        };
    }

    return { schemaName: preferredSchema, tableName: tableOnly };
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
    const schemaLiteral = quoteSqlLiteral(schemaName);
    // Exclude views — only scan BASE TABLEs
    const query = `
        SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
        FROM information_schema.columns c
        JOIN information_schema.tables t
            ON c.table_name = t.table_name AND c.table_schema = t.table_schema
        WHERE c.table_schema = ${schemaLiteral}
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name, c.ordinal_position
    `;

    const allColumns = await gateway.runQuery(query, targetUrl);
    if (allColumns && (allColumns as any).error) {
        console.error(`[${type.toUpperCase()}] discoverSchema error:`, (allColumns as any).error);
        return allColumns;
    }

    const schemaInfo: Record<string, any> = {};
    if (Array.isArray(allColumns)) {
        allColumns.forEach((col: any) => {
            if (!schemaInfo[col.table_name]) schemaInfo[col.table_name] = { columns: [] };
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
        console.error("[DB] getTableData called with undefined tableName");
        return { error: "Table name is required" };
    }
    const { type, gateway, targetUrl } = resolveGateway(url);
    const target = await resolveTableTarget(type, gateway, targetUrl, tableName);
    if (!target.tableName) return { error: "Table name is required" };

    const quotedTable = `${quoteIdent(target.schemaName, type)}.${quoteIdent(target.tableName, type)}`;
    // Single query — MSSQL uses TOP N, Postgres uses LIMIT N
    const sql = type === 'mssql'
        ? `SELECT TOP 25 * FROM ${quotedTable}`
        : `SELECT * FROM ${quotedTable} LIMIT 25`;

    return await gateway.runQuery(sql, targetUrl);
}

export async function listTables(url?: string) {
    const { type, gateway, targetUrl } = resolveGateway(url);
    const schemaName = type === 'mssql' ? 'dbo' : 'public';
    const schemaLiteral = quoteSqlLiteral(schemaName);
    const tables = await gateway.runQuery(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = ${schemaLiteral} AND table_type = 'BASE TABLE' ORDER BY table_name`,
        targetUrl
    );
    if (tables && (tables as any).error) {
        console.error(`[${type.toUpperCase()}] listTables error:`, (tables as any).error);
        return tables;
    }

    const tableList = Array.isArray(tables) ? tables.map((t: any) => t.table_name) : [];
    console.log(`[${type.toUpperCase()}] Found ${tableList.length} base tables in schema '${schemaName}'.`);
    return tableList;
}

export async function getTableSchema(tableName: string, url?: string) {
    if (!tableName) {
        throw new Error("getTableSchema called with undefined tableName");
    }

    try {
        const { type, gateway, targetUrl } = resolveGateway(url);
        const target = await resolveTableTarget(type, gateway, targetUrl, tableName);
        if (!target.tableName) {
            throw new Error("Table name is required");
        }
        const tableLiteral = quoteSqlLiteral(target.tableName);
        const schemaLiteral = quoteSqlLiteral(target.schemaName);

        const columns = await gateway.runQuery(`
            SELECT 
                column_name, 
                data_type, 
                is_nullable, 
                column_default 
            FROM information_schema.columns 
            WHERE table_name = ${tableLiteral}
                AND table_schema = ${schemaLiteral}
            ORDER BY ordinal_position
        `, targetUrl);

        const primaryKeys = await gateway.runQuery(`
            SELECT kcu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON tc.constraint_name = kcu.constraint_name
                AND tc.table_schema = kcu.table_schema
            WHERE tc.constraint_type = 'PRIMARY KEY'
                AND tc.table_name = ${tableLiteral}
                AND tc.table_schema = ${schemaLiteral}
        `, targetUrl);

        // Use REFERENTIAL_CONSTRAINTS — works on both PostgreSQL and MSSQL (SQL Server).
        // The old constraint_column_usage join fails on MSSQL and cross-schema FKs.
        const foreignKeys = await gateway.runQuery(`
            SELECT
                kcu.column_name,
                ref_kcu.table_name  AS foreign_table_name,
                ref_kcu.column_name AS foreign_column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
                ON  tc.constraint_name   = kcu.constraint_name
                AND tc.table_schema      = kcu.table_schema
            JOIN information_schema.referential_constraints rc
                ON  tc.constraint_name   = rc.constraint_name
                AND tc.constraint_schema = rc.constraint_schema
            JOIN information_schema.key_column_usage ref_kcu
                ON  rc.unique_constraint_name   = ref_kcu.constraint_name
                AND rc.unique_constraint_schema = ref_kcu.table_schema
                AND kcu.ordinal_position        = ref_kcu.ordinal_position
            WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_name   = ${tableLiteral}
                AND tc.table_schema = ${schemaLiteral}
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
        console.error(`[DB] getTableSchema failed for ${tableName}:`, err.message);
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

type McpConnectionResult = {
    ok: boolean;
    status: "Connected" | "Auth Error" | "Error";
    message?: string;
};

export async function testMcpConnection(
    endpoint: string,
    auth?: { authType?: string; token?: string }
): Promise<McpConnectionResult> {
    const target = String(endpoint || "").trim();
    if (!target) {
        return { ok: false, status: "Error", message: "Endpoint is required." };
    }
    if (!/^https?:\/\//i.test(target)) {
        return { ok: false, status: "Error", message: "Endpoint must start with http:// or https://." };
    }

    const headers: Record<string, string> = {
        Accept: "application/json, text/plain, */*",
    };
    const authType = String(auth?.authType || "").toLowerCase();
    const token = String(auth?.token || "").trim();
    if (token && authType.includes("bearer")) {
        headers.Authorization = `Bearer ${token}`;
    }
    if (token && authType.includes("basic")) {
        headers.Authorization = `Basic ${token}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
        const res = await fetch(target, {
            method: "GET",
            headers,
            signal: controller.signal,
            cache: "no-store",
            redirect: "follow",
        });

        if (res.status === 401 || res.status === 403) {
            return { ok: false, status: "Auth Error", message: "Authentication rejected by MCP endpoint." };
        }
        if (res.ok) {
            return { ok: true, status: "Connected" };
        }
        if (res.status === 404 || res.status === 405) {
            return {
                ok: true,
                status: "Connected",
                message: "Endpoint is reachable but does not expose GET on this path.",
            };
        }
        return {
            ok: false,
            status: "Error",
            message: `MCP endpoint responded with HTTP ${res.status}.`,
        };
    } catch (error: any) {
        if (error?.name === "AbortError") {
            return { ok: false, status: "Error", message: "MCP endpoint timed out after 5 seconds." };
        }
        return {
            ok: false,
            status: "Error",
            message: error?.message || "Unable to reach MCP endpoint.",
        };
    } finally {
        clearTimeout(timeout);
    }
}

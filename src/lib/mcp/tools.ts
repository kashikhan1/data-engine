import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { dbGateway } from "./client";

export const pgListSchemasTool = new DynamicStructuredTool({
    name: "pg_list_schemas",
    description: "Lists all schemas in the Postgres database.",
    schema: z.object({}),
    func: async () => {
        return JSON.stringify(await dbGateway.runQuery("SELECT schema_name FROM information_schema.schemata"));
    },
});

export const pgListTablesTool = new DynamicStructuredTool({
    name: "pg_list_tables",
    description: "Lists all tables in a specific schema.",
    schema: z.object({
        schema: z.string().describe("The schema name to list tables for"),
    }),
    func: async ({ schema }: { schema: string }) => {
        return JSON.stringify(await dbGateway.runQuery(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}'`));
    },
});

export const pgGetTableSchemaTool = new DynamicStructuredTool({
    name: "pg_get_table_schema",
    description: "Gets the column definitions for a specific table.",
    schema: z.object({
        schema: z.string(),
        table: z.string(),
    }),
    func: async ({ schema, table }: { schema: string; table: string }) => {
        return JSON.stringify(await dbGateway.runQuery(`
      SELECT column_name, data_type, is_nullable 
      FROM information_schema.columns 
      WHERE table_schema = '${schema}' AND table_name = '${table}'
    `));
    },
});

export const pgRunQueryTool = new DynamicStructuredTool({
    name: "pg_run_query",
    description: "Executes a parameterized SQL query on the Postgres database.",
    schema: z.object({
        sql: z.string().describe("The SQL query to execute"),
        limit: z.number().optional().default(100),
    }),
    func: async ({ sql, limit }: { sql: string; limit: number }) => {
        // In a real scenario, we'd handle parameters and limits securely
        return JSON.stringify(await dbGateway.runQuery(`${sql} LIMIT ${limit}`));
    },
});

export const pgTools = [
    pgListSchemasTool,
    pgListTablesTool,
    pgGetTableSchemaTool,
    pgRunQueryTool,
];

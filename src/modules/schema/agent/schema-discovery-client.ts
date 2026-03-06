export interface SchemaDiscoveryOptions {
    enableSemanticSearch?: boolean;
    enableTableKpis?: boolean;
    enableTableMatrix?: boolean;
    enableTableFilters?: boolean;
    projectContext?: string;
}

export interface RunSchemaDiscoveryClientInput {
    connection?: string;
    connectorType?: string;
    options?: SchemaDiscoveryOptions;
    allowedTables?: string[];
    routingContext?: {
        schemaHint?: string;
        projectContext?: string;
    };
}

export async function runSchemaDiscovery(
    inputOrConnection?: string | RunSchemaDiscoveryClientInput,
    options: SchemaDiscoveryOptions = {},
    allowedTables?: string[]
) {
    const isObjectInput = !!inputOrConnection && typeof inputOrConnection === "object";
    const payload = isObjectInput
        ? {
            connection: (inputOrConnection as RunSchemaDiscoveryClientInput).connection,
            connectorType: (inputOrConnection as RunSchemaDiscoveryClientInput).connectorType,
            options: (inputOrConnection as RunSchemaDiscoveryClientInput).options || {},
            allowedTables: (inputOrConnection as RunSchemaDiscoveryClientInput).allowedTables || [],
            routingContext: (inputOrConnection as RunSchemaDiscoveryClientInput).routingContext || {},
        }
        : {
            connection: inputOrConnection as string | undefined,
            options: options || {},
            allowedTables: Array.isArray(allowedTables) ? allowedTables : [],
        };
    const response = await fetch("/api/schema/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error || "Schema discovery failed");
    }
    if (data?.error) {
        throw new Error(data.error);
    }

    return data;
}

export {
  runSchemaDiscovery as runSchemaDiscoveryServer,
  type RunSchemaDiscoveryInput,
  type SchemaDiscoveryOptions as SchemaDiscoveryServerOptions,
  type ColumnProfile,
  type TableClassification,
  type DataQualityReport,
  type TableInsight,
  type TableFilterSuggestion,
  type QueryExample,
} from "../../../lib/agents/schema-discovery";

export {
  runSchemaDiscovery as runSchemaDiscovery,
  runSchemaDiscovery as runSchemaDiscoveryClient,
  type RunSchemaDiscoveryClientInput,
  type SchemaDiscoveryOptions as SchemaDiscoveryClientOptions,
} from "./schema-discovery-client";

export * from "./data-type-utils";

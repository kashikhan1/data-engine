import { registerPostgresSchemaDiscoverySkill } from "./postgres/schema-discovery";
import { registerMssqlSchemaDiscoverySkill } from "./mssql/schema-discovery";
import { registerPostgresSqlValidatorSkill } from "./postgres/sql-validator";
import { registerMssqlSqlValidatorSkill } from "./mssql/sql-validator";

let registered = false;

export function registerConnectorSkills() {
  if (registered) return;
  registerPostgresSchemaDiscoverySkill();
  registerMssqlSchemaDiscoverySkill();
  registerPostgresSqlValidatorSkill();
  registerMssqlSqlValidatorSkill();
  registered = true;
}

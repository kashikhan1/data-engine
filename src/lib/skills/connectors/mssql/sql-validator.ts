import { registerSkill, type SkillDefinition } from "@/lib/skills/registry";
import { validateSqlAgainstInstructions } from "@/lib/agents/connector-policy";

import type { ConnectorValidationInput, ConnectorValidationOutput } from "../contracts";

const skill: SkillDefinition<ConnectorValidationInput, ConnectorValidationOutput> = {
  id: "connector.mssql.sql-validator",
  description: "MSSQL connector-specific SQL validation skill.",
  run: async (input) => {
    return validateSqlAgainstInstructions(
      input.sql,
      input.connectionString,
      input.connectorInstructions,
      "mssql",
      input.schemaForPrompt,
      input.widget
    );
  },
};

let registered = false;
export function registerMssqlSqlValidatorSkill() {
  if (registered) return;
  registerSkill(skill);
  registered = true;
}

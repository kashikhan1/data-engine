import { registerSkill, type SkillDefinition } from "@/lib/skills/registry";
import { validateSqlAgainstInstructions } from "@/lib/agents/connector-policy";

import type { ConnectorValidationInput, ConnectorValidationOutput } from "../contracts";

const skill: SkillDefinition<ConnectorValidationInput, ConnectorValidationOutput> = {
  id: "connector.postgres.sql-validator",
  description: "PostgreSQL connector-specific SQL validation skill.",
  run: async (input) => {
    return validateSqlAgainstInstructions(
      input.sql,
      input.connectionString,
      input.connectorInstructions,
      "postgres",
      input.schemaForPrompt,
      input.widget
    );
  },
};

let registered = false;
export function registerPostgresSqlValidatorSkill() {
  if (registered) return;
  registerSkill(skill);
  registered = true;
}

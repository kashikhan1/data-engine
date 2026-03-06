import { HumanMessage, SystemMessage } from "@langchain/core/messages";

import { createDefaultChatModel } from "@/lib/llm/model";
import { invokeModelWithRetry, extractJSON } from "@/lib/agents/llm-utils";

import type {
  ConnectorKind,
  ConnectorRoutingContext,
  ConnectorSkillSelectionInput,
  ConnectorSkillSet,
} from "./contracts";
import { getConnectorSkillSet } from "./skill-map";

const getModel = () => createDefaultChatModel({ logPrefix: "[LLM][CONNECTOR_ROUTER]", timeoutMs: 900000 });

function inferConnectorHeuristic(input: ConnectorSkillSelectionInput): ConnectorKind {
  const rawConn = String(input.connectionString || "").toLowerCase();
  const rawType = String(input.connectorType || "").toLowerCase();
  if (
    rawType.includes("mssql") ||
    rawType.includes("sql server") ||
    rawConn.startsWith("mssql://") ||
    rawConn.startsWith("sqlserver://") ||
    rawConn.includes("server=") ||
    rawConn.includes("data source=")
  ) {
    return "mssql";
  }
  return "postgres";
}

async function proposeConnectorFromLlm(input: ConnectorSkillSelectionInput): Promise<ConnectorKind | null> {
  const context = [input.schemaHint, input.projectContext, input.connectorType, input.connectionString]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .join("\n");
  if (!context) return null;

  const systemPrompt = `You are a connector router.
Choose one connector: postgres or mssql.
Return ONLY JSON: {"connector":"postgres"} or {"connector":"mssql"}.`;

  try {
    const response = await invokeModelWithRetry(
      getModel,
      [new SystemMessage(systemPrompt), new HumanMessage(context)],
      2,
      1000
    );
    const content = String((response as { content?: unknown } | null)?.content || "");
    const parsed = extractJSON(content) as { connector?: string } | null;
    const connector = String(parsed?.connector || "").toLowerCase();
    if (connector === "postgres" || connector === "mssql") return connector;
    return null;
  } catch {
    return null;
  }
}

export async function resolveConnectorSkills(input: ConnectorSkillSelectionInput): Promise<{
  kind: ConnectorKind;
  skills: ConnectorSkillSet;
  routing: ConnectorRoutingContext;
}> {
  const requested = inferConnectorHeuristic(input);
  const llmSelection = await proposeConnectorFromLlm(input);

  if (!llmSelection) {
    return {
      kind: requested,
      skills: getConnectorSkillSet(requested),
      routing: {
        requested,
        selected: requested,
        source: "heuristic",
        fallbackUsed: false,
        reason: "No LLM selection."
      }
    };
  }

  if (llmSelection === requested) {
    return {
      kind: llmSelection,
      skills: getConnectorSkillSet(llmSelection),
      routing: {
        requested,
        selected: llmSelection,
        source: "llm_selected",
        fallbackUsed: false,
        reason: "LLM selection validated against connector inference."
      }
    };
  }

  return {
    kind: requested,
    skills: getConnectorSkillSet(requested),
    routing: {
      requested,
      selected: requested,
      source: "validated_fallback",
      fallbackUsed: true,
      reason: `LLM proposed ${llmSelection}; fell back to inferred ${requested}.`
    }
  };
}

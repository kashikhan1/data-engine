# AI Auto Dashboard & Reporting Creator

This project is a Postgres-based AI Dashboard builder using **LangGraph**, **MCP**, and **Vega-Lite**.

## 🚀 Getting Started

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Configure Environment**:
    Create a `.env.local` file (this is ignored by git) and add:
    ```env
    OPENAI_API_KEY=your_openai_key
    POSTGRES_URL=your_postgres_url
    ```

3.  **Run the App**:
    ```bash
    npm run dev
    ```

## 🏗️ Architecture

- **`src/app/api/chat/route.ts`**: The main entry point for the agentic workflow.
- **`src/lib/agents/graph.ts`**: Defines the LangGraph state machine.
- **`src/lib/agents/nodes.ts`**: Contains the logic for Plan, Policy, Semantic, SQL, MCP, QA, Viz, and Narrative agents.
- **`src/lib/mcp/tools.ts`**: Postgres-specific toolset for the MCP Calling Agent.
- **`src/lib/semantic/service.ts`**: Resolves natural language terms to canonical metrics and dimensions.

## 📊 Semantic Registry

The system expects a `semantic` schema in your Postgres database. See `docs/semantic_schema.sql` for the required DDL.

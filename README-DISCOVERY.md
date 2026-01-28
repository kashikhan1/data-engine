# Schema Discovery Script

A standalone CLI tool for deep database profiling and semantic understanding using AI.

## Features

✨ **Professional CLI Experience**
- Beautiful colored terminal output
- Animated progress indicators
- Detailed logging and error messages
- Human-readable file sizes and statistics

🔍 **Deep Schema Profiling**
- Automatic table discovery
- Column type analysis and categorization
- Record counting and sampling
- Foreign key relationship detection

🤖 **AI-Powered Semantic Analysis**
- Natural language schema understanding
- Business context identification
- Data quality assessment
- Relationship insights

## Installation

The script is already set up in your project. Just ensure dependencies are installed:

```bash
npm install
```

## Usage

### Basic Usage

Run with default settings (uses `POSTGRES_URL` from `.env`):

```bash
npm run discover
```

Or use `npx` directly:

```bash
npx tsx run-discovery.ts
```

### Custom Database URL

Specify a different database connection:

```bash
npx tsx run-discovery.ts --url="postgresql://user:password@host:port/database"
```

### Custom Output File

Save results to a specific file:

```bash
npx tsx run-discovery.ts --output=my-schema.json
```

### Combined Options

```bash
npx tsx run-discovery.ts \
  --url="postgresql://user:password@host:port/database" \
  --output=production-schema.json
```

## Configuration

### Environment Variables

The script reads from your `.env` file:

```env
# Database Connection (Required)
POSTGRES_URL=postgresql://user:password@host:port/database

# LLM Configuration (Optional)
OLLAMA_MODEL=llama3.2:latest
OLLAMA_BASE_URL=http://localhost:11434

# Or use OpenAI
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4-turbo-preview
```

### Table Filtering

If you want to limit which tables are profiled, configure `ALLOWED_TABLES` in your database gateway:

```typescript
// src/lib/mcp/server.ts or similar
const ALLOWED_TABLES = ['clients', 'orders', 'products'];
```

## Output Format

The script generates a JSON file with the following structure:

```json
{
  "tables": ["clients", "orders", "products"],
  "schemaInfo": {
    "clients": {
      "columns": [
        {
          "name": "id",
          "type": "integer",
          "category": "numeric",
          "isPrimary": true,
          "nullable": false
        }
      ],
      "foreignKeys": [...]
    }
  },
  "sampleData": {
    "clients": [
      { "id": 1, "name": "Acme Corp", ... }
    ]
  },
  "tableCounts": {
    "clients": 1250,
    "orders": 5430
  },
  "relationships": [
    {
      "fromTable": "orders",
      "fromColumn": "client_id",
      "toTable": "clients",
      "toColumn": "id",
      "type": "many-to-one"
    }
  ],
  "rawAnalysis": "Natural language analysis of the schema..."
}
```

## What the Script Does

1. **Connects to Database** - Establishes connection using MCP (Model Context Protocol)
2. **Discovers Tables** - Lists all tables in the public schema
3. **Profiles Each Table**:
   - Fetches column definitions with data types
   - Counts total records
   - Samples last 5 records
   - Identifies primary keys and foreign keys
   - Categorizes data types (numeric, temporal, text, boolean, complex)
4. **Analyzes Relationships** - Maps foreign key connections
5. **Generates Semantic Analysis** - Uses LLM to create natural language understanding
6. **Saves Results** - Writes comprehensive JSON output

## Progress Indicators

The script shows real-time progress:

```
⠋ Connecting to database and profiling schema...
```

When complete, you'll see a detailed summary:

```
━━━ Discovery Results ━━━

✓ Found 4 tables

Tables Discovered:
  1. clients
     ├─ Columns: 12
     └─ Records: 1,250

  2. orders
     ├─ Columns: 15
     └─ Records: 5,430

Relationships Found: 8
  clients.id → orders.client_id
  ...

━━━ Summary ━━━

  ● Tables Profiled: 4
  ● Total Records: 6,680
  ● Relationships: 8
  ● Execution Time: 45.2s
```

## Troubleshooting

### Connection Errors

**Problem**: `Failed to connect to the database`

**Solutions**:
- Verify database URL is correct
- Check network connectivity
- Ensure database is accessible (not behind firewall)
- Verify credentials are correct

### Permission Errors

**Problem**: `Permission denied for table...`

**Solution**: Ensure your database user has `SELECT` permissions:

```sql
GRANT SELECT ON ALL TABLES IN SCHEMA public TO your_user;
```

### LLM Errors

**Problem**: `Failed to generate semantic analysis`

**Solutions**:
- If using Ollama: Ensure service is running (`ollama serve`)
- Check model is pulled: `ollama pull llama3.2:latest`
- If using OpenAI: Verify API key is valid
- Check rate limits

### No Tables Found

**Problem**: `No tables found in the database`

**Solutions**:
- Verify you're connected to the correct database
- Check that tables exist in the `public` schema
- Review `ALLOWED_TABLES` filter if configured

### Slow Performance

**Problem**: Script takes a long time

**Reasons**:
- Large number of tables (351 in your case)
- Table filtering reduces this to 4 tables
- LLM semantic analysis can take 30-60 seconds
- Network latency to remote database

**Optimization**:
- Use `ALLOWED_TABLES` to limit scope
- Use faster LLM model
- Run on same network as database

## Integration with Application

After running the script, you can use the output in your application:

```typescript
import schemaData from './schema-discovery-output.json';

// Use in your schema discovery view
setSchemaData(schemaData);
```

Or load it dynamically:

```typescript
const schemaData = JSON.parse(
  fs.readFileSync('schema-discovery-output.json', 'utf-8')
);
```

## Next Steps

After schema discovery:

1. **Review the Analysis** - Read the semantic analysis to understand your data
2. **Plan Dashboard** - Use the schema context to plan dashboard widgets
3. **Generate Queries** - Create SQL queries based on the schema
4. **Execute & Visualize** - Run queries and build visualizations

## Advanced Usage

### Programmatic Usage

You can also import and use the function directly:

```typescript
import { runSchemaDiscovery } from './src/lib/agents/nodes';

const schemaData = await runSchemaDiscovery(
  'postgresql://user:pass@host:port/db'
);

console.log(schemaData);
```

### Custom Analysis

Modify the `generateSchemaAnalysis` function in `src/lib/agents/nodes.ts` to customize the LLM prompt for your specific needs.

## Support

For issues or questions:
1. Check the `agent_logs.txt` file for detailed logs
2. Review the error messages and stack traces
3. Verify your environment configuration
4. Check database connectivity and permissions

---

**Happy Schema Discovery! 🔍**

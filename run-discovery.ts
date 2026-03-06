#!/usr/bin/env tsx
/**
 * Standalone Schema Discovery Script
 * 
 * This script runs the schema discovery agent independently from the Next.js app.
 * It connects to your Postgres database, profiles all tables, generates semantic
 * analysis using LLM, and saves the results to a JSON file.
 * 
 * Usage:
 *   npx tsx run-discovery.ts
 *   npx tsx run-discovery.ts --output=schema-output.json
 *   npx tsx run-discovery.ts --url="postgresql://user:pass@host:port/db"
 */

import 'dotenv/config';
import { runSchemaDiscovery } from './src/lib/agents/schema-discovery';
import * as fs from 'fs';
import * as path from 'path';

// ANSI color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
};

// Progress spinner
const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerIndex = 0;
let spinnerInterval: NodeJS.Timeout | null = null;

function startSpinner(message: string) {
    process.stdout.write(`${colors.cyan}${spinnerFrames[0]}${colors.reset} ${message}`);
    spinnerInterval = setInterval(() => {
        spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
        process.stdout.write(`\r${colors.cyan}${spinnerFrames[spinnerIndex]}${colors.reset} ${message}`);
    }, 80);
}

function stopSpinner(success: boolean, finalMessage: string) {
    if (spinnerInterval) {
        clearInterval(spinnerInterval);
        spinnerInterval = null;
    }
    const icon = success ? `${colors.green}✓${colors.reset}` : `${colors.red}✗${colors.reset}`;
    process.stdout.write(`\r${icon} ${finalMessage}\n`);
}

function logSection(title: string) {
    console.log(`\n${colors.bright}${colors.blue}━━━ ${title} ━━━${colors.reset}\n`);
}

function logInfo(message: string) {
    console.log(`${colors.cyan}ℹ${colors.reset} ${message}`);
}

function logSuccess(message: string) {
    console.log(`${colors.green}✓${colors.reset} ${message}`);
}

function logWarning(message: string) {
    console.log(`${colors.yellow}⚠${colors.reset} ${message}`);
}

function logError(message: string) {
    console.log(`${colors.red}✗${colors.reset} ${message}`);
}

function logData(label: string, value: any) {
    console.log(`  ${colors.dim}${label}:${colors.reset} ${colors.white}${value}${colors.reset}`);
}

// Parse command line arguments
function parseArgs() {
    const args = process.argv.slice(2);
    const config: { output?: string; url?: string } = {};

    args.forEach(arg => {
        if (arg.startsWith('--output=')) {
            config.output = arg.split('=')[1];
        } else if (arg.startsWith('--url=')) {
            config.url = arg.split('=')[1];
        }
    });

    return config;
}

// Format bytes to human-readable size
function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Main execution
async function main() {
    const startTime = Date.now();

    // Print banner
    console.log(`${colors.bright}${colors.magenta}`);
    console.log('╔═══════════════════════════════════════════════════════════╗');
    console.log('║                                                           ║');
    console.log('║          🔍 SCHEMA DISCOVERY AGENT (Pro Mode)             ║');
    console.log('║                                                           ║');
    console.log('║     Deep profiling and semantic understanding             ║');
    console.log('║                                                           ║');
    console.log('╚═══════════════════════════════════════════════════════════╝');
    console.log(colors.reset);

    const config = parseArgs();
    const outputFile = config.output || 'schema-discovery-output.json';

    logSection('Configuration');

    const connectionUrl = config.url || process.env.POSTGRES_URL || process.env.NEXT_PUBLIC_POSTGRES_URL;

    if (!connectionUrl) {
        logError('No database connection URL provided!');
        logInfo('Please set POSTGRES_URL in .env or use --url flag');
        console.log('\nExample:');
        console.log(`  ${colors.dim}npx tsx run-discovery.ts --url="postgresql://user:pass@host:port/db"${colors.reset}`);
        process.exit(1);
    }

    // Mask password in URL for display
    const maskedUrl = connectionUrl.replace(/:([^:@]+)@/, ':****@');
    logData('Database URL', maskedUrl);
    logData('Output File', outputFile);
    logData('LLM Model', process.env.OLLAMA_MODEL || process.env.OPENAI_MODEL || 'llama3.2:latest');

    logSection('Starting Schema Discovery via script...');

    let schemaData: any;

    try {
        startSpinner('Connecting to database and profiling schema...');

        // Run the schema discovery
        schemaData = await runSchemaDiscovery(connectionUrl);

        stopSpinner(true, 'Schema discovery completed successfully!');

        // Display results summary
        logSection('Discovery Results');

        if (schemaData.tables && schemaData.tables.length > 0) {
            logSuccess(`Found ${colors.bright}${schemaData.tables.length}${colors.reset} tables`);

            console.log(`\n${colors.bright}Tables Discovered:${colors.reset}`);
            schemaData.tables.forEach((table: string, index: number) => {
                const count = schemaData.tableCounts?.[table] || 0;
                const columns = schemaData.schemaInfo?.[table]?.columns?.length || 0;
                console.log(`  ${colors.cyan}${index + 1}.${colors.reset} ${colors.white}${table}${colors.reset}`);
                console.log(`     ${colors.dim}├─ Columns: ${columns}${colors.reset}`);
                console.log(`     ${colors.dim}└─ Records: ${count.toLocaleString()}${colors.reset}`);
            });

            if (schemaData.relationships && schemaData.relationships.length > 0) {
                console.log(`\n${colors.bright}Relationships Found:${colors.reset} ${schemaData.relationships.length}`);
                schemaData.relationships.slice(0, 5).forEach((rel: any) => {
                    console.log(`  ${colors.dim}${rel.fromTable}.${rel.fromColumn} → ${rel.toTable}.${rel.toColumn}${colors.reset}`);
                });
                if (schemaData.relationships.length > 5) {
                    console.log(`  ${colors.dim}... and ${schemaData.relationships.length - 5} more${colors.reset}`);
                }
            }

            // Show semantic analysis preview
            if (schemaData.rawAnalysis) {
                console.log(`\n${colors.bright}Semantic Analysis Preview:${colors.reset}`);
                const preview = schemaData.rawAnalysis.substring(0, 300);
                console.log(`${colors.dim}${preview}${preview.length < schemaData.rawAnalysis.length ? '...' : ''}${colors.reset}`);
            }
        } else {
            logWarning('No tables found in the database');
        }

        // Save to file
        logSection('Saving Results');

        startSpinner(`Writing to ${outputFile}...`);

        const outputPath = path.resolve(process.cwd(), outputFile);
        const jsonOutput = JSON.stringify(schemaData, null, 2);
        fs.writeFileSync(outputPath, jsonOutput, 'utf-8');

        const fileSize = fs.statSync(outputPath).size;
        stopSpinner(true, `Results saved to ${outputFile}`);

        logData('File Path', outputPath);
        logData('File Size', formatBytes(fileSize));

        // Summary statistics
        logSection('Summary');

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        const totalRecords = Object.values(schemaData.tableCounts || {}).reduce((sum: number, count: any) => sum + Number(count), 0);

        console.log(`  ${colors.green}●${colors.reset} Tables Profiled: ${colors.bright}${schemaData.tables?.length || 0}${colors.reset}`);
        console.log(`  ${colors.green}●${colors.reset} Total Records: ${colors.bright}${totalRecords.toLocaleString()}${colors.reset}`);
        console.log(`  ${colors.green}●${colors.reset} Relationships: ${colors.bright}${schemaData.relationships?.length || 0}${colors.reset}`);
        console.log(`  ${colors.green}●${colors.reset} Execution Time: ${colors.bright}${duration}s${colors.reset}`);

        console.log(`\n${colors.bright}${colors.green}✓ Schema discovery completed successfully!${colors.reset}\n`);

        // Next steps
        console.log(`${colors.dim}Next steps:${colors.reset}`);
        console.log(`  1. Review the output file: ${colors.cyan}${outputFile}${colors.reset}`);
        console.log(`  2. Use this data in your application's schema discovery view`);
        console.log(`  3. Run the dashboard planner with this schema context\n`);

    } catch (error: any) {
        if (spinnerInterval) {
            stopSpinner(false, 'Schema discovery failed!');
        }

        logSection('Error Details');
        logError(error.message);

        if (error.stack) {
            console.log(`\n${colors.dim}Stack trace:${colors.reset}`);
            console.log(colors.dim + error.stack + colors.reset);
        }

        console.log(`\n${colors.yellow}Troubleshooting tips:${colors.reset}`);
        console.log(`  • Verify your database connection URL is correct`);
        console.log(`  • Ensure the database is accessible from your network`);
        console.log(`  • Check that your database user has SELECT permissions`);
        console.log(`  • Verify the Ollama service is running (if using local LLM)`);
        console.log(`  • Check the agent_logs.txt file for detailed error logs\n`);

        process.exit(1);
    }
}

// Run the script
main().catch(error => {
    console.error(`\n${colors.red}Fatal error:${colors.reset}`, error);
    process.exit(1);
});

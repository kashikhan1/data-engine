import { NextRequest, NextResponse } from 'next/server';
import { streamingSqlEngineerWorkflow, StreamEvent } from '@/modules/runtime/agent';
import { AgentState } from '@/modules/runtime/agent';
import { runQueryGenerator } from '@/modules/sql/agent';

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { query, schema, queryPlan, queryValidation, securityClearance, context, connectorInstructions, connectorType, connectionString } = body;

        // Build initial state for streaming workflow
        const mergedSchema = schema
            ? {
                ...schema,
                connectorInstructions: connectorInstructions || schema?.connectorInstructions,
                connectorType: connectorType || schema?.connectorType,
                connectionString: connectionString || schema?.connectionString || schema?.dbUrl || schema?.postgresUrl || schema?.mssqlUrl
            }
            : schema;
        const mergedContext = {
            ...(context || {}),
            connectorInstructions: connectorInstructions || context?.connectorInstructions,
            connectorType: connectorType || context?.connectorType,
            connectionString: connectionString || context?.connectionString || context?.postgresUrl || context?.mssqlUrl
        };

        const effectivePlan = queryPlan || body?.plan || null;
        let effectiveQueryValidation = queryValidation;
        if ((!effectiveQueryValidation || Object.keys(effectiveQueryValidation).length === 0) && effectivePlan && mergedSchema) {
            try {
                effectiveQueryValidation = await runQueryGenerator(
                    effectivePlan,
                    mergedSchema,
                    body?.filters || {},
                    body?.errorLog || [],
                    Boolean(body?.applyFilters)
                );
            } catch (err) {
                console.error('[STREAMING_API] Failed to pre-generate SQL map:', err);
            }
        }

        if (!effectivePlan || !mergedSchema) {
            return NextResponse.json(
                { error: 'Missing queryPlan/schema for streaming workflow' },
                { status: 400 }
            );
        }
        if (!effectiveQueryValidation || Object.keys(effectiveQueryValidation).length === 0) {
            return NextResponse.json(
                { error: 'No SQL queries available for execution. Generate SQL first.' },
                { status: 400 }
            );
        }

        const state: Partial<typeof AgentState.State> = {
            intent: query,
            context: mergedContext,
            schema: mergedSchema,
            queryPlan: effectivePlan,
            queryValidation: effectiveQueryValidation,
            securityClearance: securityClearance || { approved: true },
            results: [],
            analytics: null,
            insights: []
        };

        // Create a ReadableStream for Server-Sent Events
        const encoder = new TextEncoder();
        
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // Start the streaming workflow
                    const workflowGenerator = streamingSqlEngineerWorkflow(state as typeof AgentState.State);

                    // Process each event from the workflow
                    for await (const event of workflowGenerator) {
                        const sseData = `data: ${JSON.stringify(event)}\n\n`;
                        controller.enqueue(encoder.encode(sseData));
                        
                        // If this is a completion or error event, close the stream
                        if (event.type === 'complete' || event.type === 'error') {
                            break;
                        }
                    }
                } catch (error) {
                    // Send error event if something goes wrong
                    const errorEvent: StreamEvent = {
                        type: 'error',
                        message: `Workflow error: ${error instanceof Error ? error.message : 'Unknown error'}`
                    };
                    
                    const sseData = `data: ${JSON.stringify(errorEvent)}\n\n`;
                    controller.enqueue(encoder.encode(sseData));
                } finally {
                    controller.close();
                }
            }
        });

        // Return Server-Sent Events response
        return new NextResponse(stream, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            },
        });

    } catch (error) {
        console.error('[STREAMING_API] Error:', error);
        return NextResponse.json(
            { error: 'Failed to start streaming workflow' },
            { status: 500 }
        );
    }
}

export async function OPTIONS() {
    return new NextResponse(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}

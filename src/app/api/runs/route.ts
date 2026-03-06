import { NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { runRegistry } from "@/modules/runtime/agent";

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { originalQuery, dashboardId, recipeId, context } = body;

        if (!originalQuery) {
            return NextResponse.json(
                { error: "originalQuery is required" },
                { status: 400 }
            );
        }

        // Generate run ID
        const runId = uuidv4();

        // Register params for the streaming route to use
        runRegistry.set(runId, {
            query: originalQuery,
            options: { dashboardId, recipeId, context }
        });

        return NextResponse.json({ runId });
    } catch (error) {
        console.error("Error creating run:", error);
        return NextResponse.json(
            { error: "Failed to create run" },
            { status: 500 }
        );
    }
}

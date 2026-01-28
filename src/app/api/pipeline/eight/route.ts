import { NextRequest } from "next/server";
import { runEightAgentWorkflow } from "@/app/actions/eight-agent";

export const maxDuration = 900; // 15 minutes

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { query, connectionString } = body || {};
        if (!query) {
            return new Response(JSON.stringify({ error: "Missing query" }), {
                status: 400,
                headers: { "Content-Type": "application/json" },
            });
        }

        const result = await runEightAgentWorkflow({ query, connectionString });
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    } catch (err: any) {
        console.error("[API_PIPELINE_EIGHT] Error:", err);
        return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
        });
    }
}

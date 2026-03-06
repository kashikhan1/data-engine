import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
    try {
        const body = await request.json();
        const { connectionString, connectorType } = body;

        if (!connectionString) {
            return NextResponse.json(
                { status: "error", message: "No connection string provided" },
                { status: 400 }
            );
        }

        const { runSkill } = await import("@/lib/skills/registry");
        const { registerConnectorSkills, resolveConnectorSkills } = await import("@/lib/skills/connectors");
        
        registerConnectorSkills();
        
        const resolved = await resolveConnectorSkills({
            connectionString,
            connectorType,
            schemaHint: "",
            projectContext: ""
        });

        const schemaDiscoverySkillId = resolved.skills.schemaDiscoverySkillId;

        const startTime = Date.now();
        
        const connectResult = await runSkill<any, any>(schemaDiscoverySkillId, {
            operation: "connect",
            connectionString
        });

        const responseTime = Date.now() - startTime;

        if (connectResult?.ok) {
            return NextResponse.json({
                status: "healthy",
                message: "Connection successful",
                dialect: resolved.kind,
                responseTimeMs: responseTime
            });
        } else {
            return NextResponse.json({
                status: "unhealthy",
                message: connectResult?.error || "Connection failed",
                responseTimeMs: responseTime
            }, { status: 400 });
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Health check failed";
        
        let userMessage = message;
        if (message.includes("ECONNREFUSED")) {
            userMessage = "Cannot connect - server may be down or firewall blocking";
        } else if (message.includes("timeout")) {
            userMessage = "Connection timed out";
        } else if (message.includes("authentication") || message.includes("password")) {
            userMessage = "Invalid credentials";
        }

        return NextResponse.json(
            { status: "error", message: userMessage },
            { status: 500 }
        );
    }
}

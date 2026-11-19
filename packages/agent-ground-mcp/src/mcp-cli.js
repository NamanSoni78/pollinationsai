#!/usr/bin/env node
// Stdio MCP server entry: exposes the 7 Agent Ground hub tools over MCP.
// Requires `npm install --prefix .` (@modelcontextprotocol/server + zod).
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createGround } from "./index.js";
import { buildGroundServer } from "./mcp.js";

function portFromEnv() {
    // Default to an ephemeral port so spawned CLI instances never clash with a
    // running hub; an explicit AGENT_GROUND_PORT is always honoured.
    const parsed = Number.parseInt(process.env.AGENT_GROUND_PORT ?? "", 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function main() {
    const stateDir = process.env.AGENT_GROUND_STATE_DIR || ".ground";
    const ground = await createGround({ port: portFromEnv(), stateDir });
    const server = buildGroundServer(ground);
    await server.connect(new StdioServerTransport());
    // stdout is the MCP channel; diagnostics go to stderr only.
    console.error(
        `agent-ground MCP server ready on stdio (hub port ${ground.port}, state ${stateDir})`,
    );

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
            await ground.stop();
        } finally {
            process.exit(0);
        }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

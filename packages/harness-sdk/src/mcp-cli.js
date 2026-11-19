#!/usr/bin/env node
// Stdio MCP entry for "harness-tools" (the SDK tool surface). Child VMs
// (OpenCode instances) load this via their `mcp.servers` config; see
// configureOpenCodeAgent() in src/opencode.js. Requires
// `npm install --prefix packages/harness-sdk`.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { buildHarnessServer } from "./mcp.js";

async function main() {
    const server = await buildHarnessServer();
    await server.connect(new StdioServerTransport());
    console.error(
        `harness-tools MCP server ready on stdio (workspace ${process.env.HARNESS_WORKSPACE ?? process.cwd()})`,
    );
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

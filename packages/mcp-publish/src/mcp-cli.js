#!/usr/bin/env node
/**
 * stdio MCP server entry for the Agent Ground publish tools.
 *
 * Constructed like packages/mcp/src/server.js (McpServer + registerTool with
 * z.object schemas); StdioServerTransport comes from the same SDK's ./stdio
 * export (@modelcontextprotocol/server ^2.0.0). Requires `npm install` in
 * this package before running.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { publishTools } from "./index.js";

const server = new McpServer(
    { name: "pollinations-mcp-publish", version: "1.0.0" },
    {
        capabilities: { tools: {} },
        instructions:
            "Deploy static sites and workers to Cloudflare Pages/Workers and EdgeOne Pages. " +
            "Credentials are read from the environment only: CLOUDFLARE_API_TOKEN + " +
            "CLOUDFLARE_ACCOUNT_ID for Cloudflare, EDGEONE_API_TOKEN for EdgeOne " +
            "(CLOUDFLARE_API_BASE / EDGEONE_API_BASE can override the API endpoints). " +
            "Every deploy returns the live URL plus an automatic verification result; " +
            "missing credentials return {configured:false, env} without contacting any API.",
    },
);

for (const [name, description, inputSchema, handler] of publishTools()) {
    server.registerTool(
        name,
        { description, inputSchema: z.object(inputSchema) },
        handler,
    );
}

server.onerror = (error) => {
    console.error(`Server error: ${error.message}`);
};

const transport = new StdioServerTransport();
await server.connect(transport);

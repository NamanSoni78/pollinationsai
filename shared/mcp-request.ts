import { readResponseText } from "./response-bytes.ts";

/**
 * Cap for a single MCP JSON-RPC request body read by the standalone worker
 * front doors: the public mcp.pollinations.ai umbrella and the gen-fronted
 * app workers. The umbrella's largest documented tool payload is deploySite
 * at "up to 5 MB per request" (packages/mcp/src/services/accountService.js),
 * so 8 MiB leaves JSON-RPC envelope headroom. Cloudflare accepts request
 * bodies far larger than a Workers isolate can buffer, and the pre-handler
 * batch check reads a teed clone of the whole body before the MCP handler
 * runs, so an oversized body killed every concurrent request on the isolate.
 */
export const MCP_REQUEST_LIMIT_BYTES = 8 * 1024 * 1024;

/** Thrown when an MCP request body exceeds {@link MCP_REQUEST_LIMIT_BYTES}. */
export class McpRequestTooLargeError extends Error {
    readonly receivedBytes: number;

    constructor(receivedBytes: number) {
        super(`MCP request body exceeds ${MCP_REQUEST_LIMIT_BYTES} bytes`);
        this.name = "McpRequestTooLargeError";
        this.receivedBytes = receivedBytes;
    }
}

/**
 * Read a request's JSON body for pre-handler checks (batch rejection,
 * tools/call detection) without ever buffering more than
 * {@link MCP_REQUEST_LIMIT_BYTES}. Mirrors
 * `request.clone().json().catch(() => null)` for bodies within the cap and
 * throws {@link McpRequestTooLargeError} past it.
 */
export async function readMcpRequestJson(request: Request): Promise<unknown> {
    const text = await readResponseText(
        request.clone(),
        MCP_REQUEST_LIMIT_BYTES,
        (total) => new McpRequestTooLargeError(total),
    );
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return null;
    }
}

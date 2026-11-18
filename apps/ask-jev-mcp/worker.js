import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
    buildUrl,
    createMCPResponse,
    createTextContent,
    fetchJsonWithAuth,
} from "../../packages/mcp/src/utils/coreUtils.js";
import {
    CreateDecisionRequestSchema,
    DEFAULT_DECISION_MODEL,
} from "../../shared/schemas/decisions.ts";

function buildServer() {
    const server = new McpServer(
        { name: "ask-jev-mcp", title: "Ask Jev MCP", version: "0.1.0" },
        { capabilities: { tools: {} } },
    );
    server.registerTool(
        "jev_decide",
        {
            description:
                "Evaluate state with independent choice, ordered score, or noul (probability) questions. " +
                "Supply relevant facts in state; confidence can remain high when facts are missing. " +
                "Choice criteria map options to descriptions; optional noul criteria.true/false define yes/no. " +
                "Read score legends; handle counting, arithmetic, and date comparisons in code. " +
                "Question and answer shapes: https://docs.typesafe.ai/api. " +
                "Optional model picks another decision model, any /v1/models entry whose supported_endpoints include /alpha/decisions; defaults to Jev.",
            inputSchema: CreateDecisionRequestSchema,
        },
        async ({ model, state, questions }, context) => {
            const { answers } = await fetchJsonWithAuth(
                buildUrl("/alpha/decisions"),
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        model: model ?? DEFAULT_DECISION_MODEL,
                        state,
                        questions,
                    }),
                },
                context,
            );
            return createMCPResponse([createTextContent(answers, true)]);
        },
    );
    return server;
}

const mcpHandler = createMcpHandler(() => buildServer(), {
    legacy: "stateless",
    onerror: (error) => console.error(error),
});

function readBearerToken(request) {
    const authorization = request.headers.get("authorization");
    if (!authorization) return null;

    const [scheme, token] = authorization.trim().split(/\s+/, 2);
    if (scheme?.toLowerCase() !== "bearer" || !token) {
        return null;
    }
    return token;
}

function unauthorizedResponse() {
    return Response.json(
        {
            error: "unauthorized",
            message: "Send a Pollinations API key as a bearer token.",
        },
        {
            status: 401,
            headers: {
                "WWW-Authenticate":
                    'Bearer realm="ask-jev-mcp.pollinations.ai"',
            },
        },
    );
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/health" && request.method === "GET") {
            return Response.json({
                name: "ask-jev-mcp",
                transport: "streamable-http",
                endpoint: "/",
                stateless: true,
            });
        }

        if (url.pathname !== "/") {
            return new Response("Not found", { status: 404 });
        }

        // Tool calls carry the caller's key to Gen, and so to Enter's D1,
        // from Cloudflare's shared Workers IP — the exact threat the sibling
        // pollinations-mcp worker caps on its public custom domain. This
        // worker's own public domain (ask-jev-mcp.pollinations.ai) previously
        // had no cap, so cap each client IP here the same way: requests
        // without a valid key still burn a D1 auth read per call.
        const ip = request.headers.get("cf-connecting-ip");
        if (ip && !(await env.IP_RATE_LIMITER.limit({ key: ip })).success) {
            return Response.json(
                {
                    error: "rate_limited",
                    message: "Too many requests. Please slow down.",
                },
                { status: 429, headers: { "Retry-After": "10" } },
            );
        }

        const token = readBearerToken(request);
        if (!token) return unauthorizedResponse();

        if (request.method === "POST") {
            // The batch probe used to clone().json() whatever the caller
            // sent, and the Workers platform accepts up to 100 MB of
            // request body. Read the probe body once under a 1 MiB cap — no
            // MCP message needs more — and refuse larger bodies before they
            // are parsed.
            const probe = await readBodyProbe(request.clone());
            if (probe.oversized) {
                return Response.json(
                    {
                        error: "payload_too_large",
                        message: "Request body is too large.",
                    },
                    { status: 413 },
                );
            }
            if (Array.isArray(probe.value)) {
                return Response.json(
                    {
                        error: "invalid_request",
                        message: "Batch requests are not supported.",
                    },
                    { status: 400 },
                );
            }
        }

        return mcpHandler.fetch(request, {
            authInfo: {
                token,
                clientId: "pollinations-api-key",
                scopes: [],
            },
        });
    },
};

const MAX_PROBE_BODY_BYTES = 1024 * 1024;

// Read a cloned request body once, bounded at MAX_PROBE_BODY_BYTES.
// Returns { oversized: true } over the cap, else { value } with the parsed
// JSON body (null when it is not valid JSON).
async function readBodyProbe(clone) {
    const reader = clone.body?.getReader();
    if (!reader) {
        return { value: await clone.json().catch(() => null) };
    }
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_PROBE_BODY_BYTES) {
            // Best-effort: drop the branch without waiting for the cancel
            // to settle — a teed clone's cancel only completes once the other
            // branch finishes too, and the probe branch is discarded either
            // way.
            void reader.cancel().catch(() => {});
            return { oversized: true };
        }
        chunks.push(value);
    }
    reader.releaseLock();
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return { value: JSON.parse(new TextDecoder().decode(bytes)) };
    } catch {
        return { value: null };
    }
}

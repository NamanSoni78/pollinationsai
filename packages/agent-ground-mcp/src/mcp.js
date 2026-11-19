import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const SERVER_VERSION = "1.0.0";

const SERVER_INSTRUCTIONS = `# Agent Ground MCP Server

Parent hub tools for the Agent Ground multi-agent platform. Use these tools to
coordinate child VM agents: discover agents registered with the hub, shoulder-tap
another agent without disrupting its context (read-only shadow queries over its
workspace, or queued negotiate-change requests), publish and fetch versioned
blackboard artifacts, subscribe to artifact changes, broadcast milestones on the
watercooler, and request peer deployment checks.

- ground_ask_agent with mode "readonly_query" answers from the target workspace
  with file:line citations and never mutates the target.
- ground_ask_agent with mode "negotiate_change" queues a request in the target
  agent's inbox; it is delivered at the target's next step boundary.
- Artifacts are immutable per (key, version); omit version to auto-increment.
- ground_publish_artifact wakes every matching subscriber.`;

/** Mirrors packages/mcp/src/utils/coreUtils.js helpers. */
function createMCPResponse(content) {
    return { content };
}

function createTextContent(text, stringify = false) {
    return {
        type: "text",
        text: stringify ? JSON.stringify(text, null, 2) : text,
    };
}

async function callGround(fn) {
    return createMCPResponse([createTextContent(await fn(), true)]);
}

/**
 * The 7 Agent Ground MCP tools, shaped exactly like packages/mcp services:
 * arrays of [name, description, zodFieldObject, handler].
 *
 * @param {object} ground - hub instance from createGround()
 * @returns {Array<[string, string, object, Function]>} tool tuples
 */
export function groundTools(ground) {
    return [
        [
            "ground_list_agents",
            "List agents registered with the Agent Ground hub, with their full AgentCards (role, goal, status, stack, owned paths, workspace). Filter by status or role.",
            {
                status: z
                    .string()
                    .optional()
                    .describe(
                        'Filter by card status: "booting", "idle", "working", "closed_loop_running", "waiting_event" or "budget_paused"',
                    ),
                role: z
                    .string()
                    .optional()
                    .describe(
                        "Filter by agent role (e.g. worker, indexer, expert)",
                    ),
            },
            async (params) =>
                callGround(() =>
                    ground.listAgents(
                        params.status || params.role
                            ? { status: params.status, role: params.role }
                            : undefined,
                    ),
                ),
        ],
        [
            "ground_ask_agent",
            'Shoulder-tap another agent. mode "readonly_query" (default) runs a read-only BM25 shadow read over the target workspace and answers with quoted excerpts plus path:line citations and the WORKLOG tail — the target is never modified. mode "negotiate_change" queues the request in the target .agent/inbox.json for delivery at its next step boundary.',
            {
                target_agent_id: z
                    .string()
                    .describe("agent_id of the target agent"),
                question: z
                    .string()
                    .describe(
                        "Question or change request for the target agent",
                    ),
                mode: z
                    .enum(["readonly_query", "negotiate_change"])
                    .optional()
                    .describe(
                        "Shoulder-tap channel; defaults to readonly_query",
                    ),
                from: z
                    .string()
                    .optional()
                    .describe(
                        "Requester identity recorded for negotiate_change requests",
                    ),
                reply_timeout_sec: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe(
                        "Accepted for API compatibility; the inbox queue has no expiry",
                    ),
            },
            async (params) => callGround(() => ground.askAgent(params)),
        ],
        [
            "ground_publish_artifact",
            "Publish a new immutable version of a blackboard artifact. Every subscription matching the key (or the publisher agent) receives a ground.artifact event. Omit version to auto-increment; republishing an existing (key, version) fails.",
            {
                key: z.string().describe('Artifact key, e.g. "design.spec"'),
                payload: z
                    .union([
                        z.string(),
                        z.object({}).passthrough(),
                        z.array(z.any()),
                    ])
                    .describe("Artifact payload (any JSON value)"),
                content_type: z
                    .string()
                    .optional()
                    .describe(
                        "MIME type of the payload; defaults to application/json",
                    ),
                changelog: z
                    .string()
                    .optional()
                    .describe("What changed in this version"),
                publisher: z
                    .string()
                    .optional()
                    .describe("agent_id of the publishing agent"),
                version: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Explicit version; defaults to latest + 1"),
            },
            async (params) => callGround(() => ground.publishArtifact(params)),
        ],
        [
            "ground_fetch_artifact",
            "Fetch an artifact from the blackboard by key. Omit version for the latest, or pass an exact version for a pinned fetch.",
            {
                key: z.string().describe("Artifact key"),
                version: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Exact version; defaults to latest"),
            },
            async (params) =>
                callGround(() =>
                    ground.fetchArtifact(params.key, params.version),
                ),
        ],
        [
            "ground_subscribe",
            "Subscribe an agent to blackboard activity: artifact_keys wakes the agent when those keys are published; agent_ids wakes it when those publishers publish anything.",
            {
                agent_id: z
                    .string()
                    .describe("agent_id of the subscribing agent"),
                artifact_keys: z
                    .array(z.string())
                    .optional()
                    .describe("Artifact keys to watch"),
                agent_ids: z
                    .array(z.string())
                    .optional()
                    .describe("Publisher agent_ids to watch"),
            },
            async (params) => callGround(() => ground.subscribe(params)),
        ],
        [
            "ground_broadcast",
            "Post to the hub watercooler (last 200 kept): announce a milestone, a blocker, a request for review, or a deployment.",
            {
                kind: z
                    .enum(["milestone", "blocked", "needs_review", "deployed"])
                    .describe("Broadcast kind"),
                summary: z
                    .string()
                    .describe("One-line summary shown in the watercooler feed"),
                from: z
                    .string()
                    .describe("agent_id (or identity) of the sender"),
                details: z
                    .string()
                    .optional()
                    .describe("Optional longer details"),
            },
            async (params) => callGround(() => ground.broadcast(params)),
        ],
        [
            "ground_request_peer_check",
            "Ask a reviewer agent to check a target URL. Runs an HTTP GET (2xx = ok) and returns a passed/failed status with findings.",
            {
                reviewer_agent_id: z
                    .string()
                    .describe("agent_id of the reviewing agent"),
                target_url: z.string().describe("http(s) URL to check"),
                checks: z
                    .array(z.string())
                    .optional()
                    .describe(
                        'Checks to run; currently only "http_status" is supported',
                    ),
            },
            async (params) => callGround(() => ground.requestPeerCheck(params)),
        ],
    ];
}

/**
 * Build an McpServer with the ground tools registered, mirroring
 * packages/mcp/src/server.js construction.
 *
 * @param {object} ground - hub instance from createGround()
 * @returns {McpServer} connected-ready server
 */
export function buildGroundServer(ground) {
    const server = new McpServer(
        { name: "agent-ground", version: SERVER_VERSION },
        {
            instructions: SERVER_INSTRUCTIONS,
            capabilities: { tools: {} },
        },
    );

    for (const [name, description, inputSchema, handler] of groundTools(
        ground,
    )) {
        server.registerTool(
            name,
            { description, inputSchema: z.object(inputSchema) },
            handler,
        );
    }

    server.onerror = (error) => {
        console.error(`Agent Ground MCP server error: ${error.message}`);
    };

    return server;
}

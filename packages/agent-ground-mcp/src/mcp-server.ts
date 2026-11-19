import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentGroundHub } from "./ground-hub";
import type { ArtifactContentType, BroadcastKind } from "./types";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOL_DEFINITIONS = [
  {
    name: "ground_list_agents",
    description: "List live Child VM agents registered on Agent Ground with roles, owned paths, and preview URLs.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string" },
        tag: { type: "string" },
      },
    },
  },
  {
    name: "ground_ask_agent",
    description:
      "Ask a peer agent a question. Default mode 'readonly_query' uses a non-disruptive Shadow Reader subagent with file citations; 'negotiate_change' queues an action at the target's next step boundary.",
    inputSchema: {
      type: "object",
      required: ["target_agent_id", "question", "mode"],
      properties: {
        from_agent_id: { type: "string" },
        target_agent_id: { type: "string" },
        question: { type: "string" },
        mode: { type: "string", enum: ["readonly_query", "negotiate_change"] },
        reply_timeout_sec: { type: "number" },
      },
    },
  },
  {
    name: "ground_publish_artifact",
    description: "Publish an immutable versioned artifact (OpenAPI spec, TS types, design tokens, image URL, preview URL) to the Ground Blackboard.",
    inputSchema: {
      type: "object",
      required: ["key", "version", "content_type", "payload", "changelog"],
      properties: {
        author_agent_id: { type: "string" },
        key: { type: "string" },
        version: { type: "string" },
        content_type: {
          type: "string",
          enum: ["json", "typescript", "markdown", "url", "image_url"],
        },
        payload: { type: "string" },
        changelog: { type: "string" },
      },
    },
  },
  {
    name: "ground_fetch_artifact",
    description: "Fetch the latest or a specific version of a shared artifact from the Ground Blackboard.",
    inputSchema: {
      type: "object",
      required: ["key"],
      properties: {
        key: { type: "string" },
        version: { type: "string" },
      },
    },
  },
  {
    name: "ground_subscribe",
    description: "Subscribe to Blackboard artifact keys or peer agent IDs to wake from sleep(until_event).",
    inputSchema: {
      type: "object",
      properties: {
        subscriber_agent_id: { type: "string" },
        artifact_keys: { type: "array", items: { type: "string" } },
        agent_ids: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "ground_broadcast",
    description: "Emit a structured status pulse (milestone, blocked, needs_review, deployed) to the Watercooler stream.",
    inputSchema: {
      type: "object",
      required: ["kind", "summary"],
      properties: {
        agent_id: { type: "string" },
        kind: { type: "string", enum: ["milestone", "blocked", "needs_review", "deployed"] },
        summary: { type: "string" },
        details: { type: "object" },
      },
    },
  },
  {
    name: "ground_request_peer_check",
    description: "Ask a peer agent on Agent Ground to run a live integration smoke test against your preview URL before Warden audit.",
    inputSchema: {
      type: "object",
      required: ["reviewer_agent_id", "preview_url"],
      properties: {
        requester_agent_id: { type: "string" },
        reviewer_agent_id: { type: "string" },
        preview_url: { type: "string" },
        checks: { type: "array", items: { type: "string" } },
      },
    },
  },
];

/**
 * Handles a single JSON-RPC 2.0 MCP message against `AgentGroundHub`.
 */
export async function handleAgentGroundMcpRequest(
  hub: AgentGroundHub,
  req: JsonRpcRequest,
  callerAgentId?: string,
): Promise<Record<string, unknown>> {
  const id = req.id ?? null;

  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-ground-mcp", version: "0.1.0" },
      },
    };
  }

  if (req.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: TOOL_DEFINITIONS },
    };
  }

  if (req.method === "tools/call") {
    const toolName = String(req.params?.name ?? "");
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;

    try {
      let data: unknown;
      switch (toolName) {
        case "ground_list_agents":
          data = await hub.ground_list_agents({
            status: args.status as string | undefined,
            tag: args.tag as string | undefined,
          });
          break;
        case "ground_ask_agent":
          data = await hub.ground_ask_agent({
            from_agent_id: (args.from_agent_id as string | undefined) ?? callerAgentId,
            target_agent_id: String(args.target_agent_id),
            question: String(args.question),
            mode: (args.mode as "readonly_query" | "negotiate_change") ?? "readonly_query",
            reply_timeout_sec: args.reply_timeout_sec as number | undefined,
          });
          break;
        case "ground_publish_artifact":
          data = await hub.ground_publish_artifact({
            author_agent_id: (args.author_agent_id as string | undefined) ?? callerAgentId,
            key: String(args.key),
            version: String(args.version),
            content_type: args.content_type as ArtifactContentType,
            payload: String(args.payload),
            changelog: String(args.changelog),
          });
          break;
        case "ground_fetch_artifact":
          data = await hub.ground_fetch_artifact({
            key: String(args.key),
            version: args.version as string | undefined,
          });
          break;
        case "ground_subscribe":
          data = await hub.ground_subscribe({
            subscriber_agent_id: (args.subscriber_agent_id as string | undefined) ?? callerAgentId,
            artifact_keys: args.artifact_keys as string[] | undefined,
            agent_ids: args.agent_ids as string[] | undefined,
          });
          break;
        case "ground_broadcast":
          await hub.ground_broadcast({
            agent_id: (args.agent_id as string | undefined) ?? callerAgentId,
            kind: args.kind as BroadcastKind,
            summary: String(args.summary),
            details: args.details as Record<string, unknown> | undefined,
          });
          data = { ok: true };
          break;
        case "ground_request_peer_check":
          data = await hub.ground_request_peer_check({
            requester_agent_id: (args.requester_agent_id as string | undefined) ?? callerAgentId,
            reviewer_agent_id: String(args.reviewer_agent_id),
            preview_url: String(args.preview_url),
            checks: args.checks as string[] | undefined,
          });
          break;
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown Agent Ground tool: ${toolName}` },
          };
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(data) }],
          structuredContent: data,
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unsupported MCP method: ${req.method}` },
  };
}

/**
 * Starts a Streamable HTTP JSON-RPC 2.0 MCP server for Agent Ground.
 */
export function createAgentGroundMcpServer(hub: AgentGroundHub): {
  server: http.Server;
  listen: (port?: number) => Promise<{ url: string; port: number }>;
  close: () => Promise<void>;
} {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name: "agent-ground-mcp", tools: TOOL_DEFINITIONS.map((t) => t.name) }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);

    try {
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRpcRequest;
      const callerId = req.headers["x-agent-id"] ? String(req.headers["x-agent-id"]) : undefined;
      const reply = await handleAgentGroundMcpRequest(hub, payload, callerId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: err instanceof Error ? err.message : "Invalid JSON" },
        }),
      );
    }
  });

  return {
    server,
    listen: (port = 0) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          resolve({ url: `http://127.0.0.1:${addr.port}`, port: addr.port });
        });
      }),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

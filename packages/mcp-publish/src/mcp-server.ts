import http from "node:http";
import type { AddressInfo } from "node:net";
import { CloudflarePublishConnector } from "./cloudflare";
import { EdgeOnePublishConnector } from "./edgeone";
import { OutOfBandSecretVault } from "./secret-guard";
import { verifyLiveDeployment } from "./smoke-test";

export interface PublishMcpContext {
  vault: OutOfBandSecretVault;
  cloudflare: CloudflarePublishConnector;
  edgeone: EdgeOnePublishConnector;
}

const PUBLISH_TOOLS = [
  {
    name: "cloudflare_deploy_pages",
    description: "Publish a built static/SPA project directory to Cloudflare Pages using out-of-band credentials.",
    inputSchema: {
      type: "object",
      required: ["project_name", "build_dir"],
      properties: {
        project_name: { type: "string" },
        build_dir: { type: "string" },
        branch: { type: "string" },
      },
    },
  },
  {
    name: "cloudflare_deploy_worker",
    description: "Deploy a Cloudflare Worker script bundle using out-of-band credentials.",
    inputSchema: {
      type: "object",
      required: ["script_name", "entry_file"],
      properties: {
        script_name: { type: "string" },
        entry_file: { type: "string" },
      },
    },
  },
  {
    name: "cloudflare_set_env_var",
    description: "Set a project environment variable/secret out-of-band on Cloudflare.",
    inputSchema: {
      type: "object",
      required: ["project_name", "key", "value"],
      properties: {
        project_name: { type: "string" },
        key: { type: "string" },
        value: { type: "string" },
        secret: { type: "boolean" },
      },
    },
  },
  {
    name: "cloudflare_get_deployment_logs",
    description: "Tail deployment logs for a Cloudflare Pages or Workers deployment.",
    inputSchema: {
      type: "object",
      required: ["deployment_id"],
      properties: { deployment_id: { type: "string" } },
    },
  },
  {
    name: "edgeone_deploy_pages",
    description: "Publish a built project directory to EdgeOne Pages using out-of-band credentials.",
    inputSchema: {
      type: "object",
      required: ["project_name", "build_dir"],
      properties: {
        project_name: { type: "string" },
        build_dir: { type: "string" },
        region: { type: "string" },
      },
    },
  },
  {
    name: "edgeone_get_deployment_status",
    description: "Get live status and URL of an EdgeOne Pages deployment.",
    inputSchema: {
      type: "object",
      required: ["deployment_id"],
      properties: { deployment_id: { type: "string" } },
    },
  },
  {
    name: "edgeone_get_logs",
    description: "Fetch deployment logs from EdgeOne Pages.",
    inputSchema: {
      type: "object",
      required: ["deployment_id"],
      properties: { deployment_id: { type: "string" } },
    },
  },
  {
    name: "publish_smoke_test",
    description: "Verify HTTP 200 and clean rendering on a live deployed URL before Warden sign-off.",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: { type: "string" },
        expected_substring: { type: "string" },
      },
    },
  },
];

export async function handlePublishMcpRequest(
  ctx: PublishMcpContext,
  req: { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const id = req.id ?? null;

  if (req.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pollinations-publish-mcp", version: "0.1.0" },
      },
    };
  }

  if (req.method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: PUBLISH_TOOLS } };
  }

  if (req.method === "tools/call") {
    const name = String(req.params?.name ?? "");
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      let data: unknown;
      switch (name) {
        case "cloudflare_deploy_pages":
          data = await ctx.cloudflare.cloudflare_deploy_pages({
            project_name: String(args.project_name),
            build_dir: String(args.build_dir),
            branch: args.branch as string | undefined,
          });
          break;
        case "cloudflare_deploy_worker":
          data = await ctx.cloudflare.cloudflare_deploy_worker({
            script_name: String(args.script_name),
            entry_file: String(args.entry_file),
          });
          break;
        case "cloudflare_set_env_var":
          data = await ctx.cloudflare.cloudflare_set_env_var({
            project_name: String(args.project_name),
            key: String(args.key),
            value: String(args.value),
            secret: Boolean(args.secret),
          });
          break;
        case "cloudflare_get_deployment_logs":
          data = await ctx.cloudflare.cloudflare_get_deployment_logs({
            deployment_id: String(args.deployment_id),
          });
          break;
        case "edgeone_deploy_pages":
          data = await ctx.edgeone.edgeone_deploy_pages({
            project_name: String(args.project_name),
            build_dir: String(args.build_dir),
            region: args.region as string | undefined,
          });
          break;
        case "edgeone_get_deployment_status":
          data = await ctx.edgeone.edgeone_get_deployment_status({
            deployment_id: String(args.deployment_id),
          });
          break;
        case "edgeone_get_logs":
          data = await ctx.edgeone.edgeone_get_logs({
            deployment_id: String(args.deployment_id),
          });
          break;
        case "publish_smoke_test":
          data = await verifyLiveDeployment(String(args.url), {
            expectedSubstring: args.expected_substring as string | undefined,
          });
          break;
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Unknown Publish MCP tool: ${name}` },
          };
      }
      const safeJson = ctx.vault.redact(JSON.stringify(data));
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: safeJson }],
          structuredContent: JSON.parse(safeJson),
        },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: ctx.vault.redact(err instanceof Error ? err.message : String(err)),
        },
      };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unsupported method: ${req.method}` } };
}

export function createPublishMcpServer(ctx: PublishMcpContext) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          name: "pollinations-publish-mcp",
          tools: PUBLISH_TOOLS.map((t) => t.name),
          credentials: ctx.vault.getSafeStatus(),
        }),
      );
      return;
    }

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const reply = await handlePublishMcpRequest(ctx, body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });

  return {
    server,
    listen: (port = 0) =>
      new Promise<{ url: string; port: number }>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          resolve({ url: `http://127.0.0.1:${addr.port}`, port: addr.port });
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

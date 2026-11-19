import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  BudgetExhaustedError,
  PollenBudgetFirewall,
  estimatePollenCost,
} from "./budget-firewall";
import { DEFAULT_POLLINATIONS_BASE_URL } from "./identity";

export interface MeteringProxyOptions {
  apiKey: string;
  firewall: PollenBudgetFirewall;
  upstreamBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * HTTP Metering Proxy that sits between Child VM OpenCode harnesses / MCP clients
 * and `https://gen.pollinations.ai`. Every paid LLM, image, search, or sandbox MCP
 * call passes through here so the Pollen Budget Firewall enforces 75%/90%/100% rules
 * and injects the user's BYOP Bearer token strictly out-of-band (never exposed in prompts).
 */
export function createPollenMeteringProxy(options: MeteringProxyOptions): {
  server: http.Server;
  listen: (port?: number) => Promise<{ url: string; port: number }>;
  close: () => Promise<void>;
} {
  const upstreamBase = (
    options.upstreamBaseUrl ?? DEFAULT_POLLINATIONS_BASE_URL
  ).replace(/\/+$/, "");
  const fetchFn = options.fetchImpl ?? fetch;

  const server = http.createServer(async (req, res) => {
    const reqUrl = req.url ?? "/";
    const method = req.method ?? "GET";

    if (reqUrl === "/_budget/status" && method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(options.firewall.getStatus()));
      return;
    }

    const agentId = String(req.headers["x-agent-id"] ?? "unknown-agent");
    const role = String(req.headers["x-agent-role"] ?? "worker");

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const rawBody = Buffer.concat(chunks);

    let parsedModel: string | undefined;
    if (rawBody.length > 0 && req.headers["content-type"]?.includes("application/json")) {
      try {
        const json = JSON.parse(rawBody.toString("utf8")) as { model?: string };
        parsedModel = json.model;
      } catch {
        // Non-JSON or streaming payload
      }
    }

    // Hard pre-flight budget check -> returns HTTP 402 immediately on cutoff
    try {
      await options.firewall.assertCanSpend(agentId, 0);
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        res.writeHead(402, {
          "content-type": "application/json",
          "x-pollen-budget-tier": "EXHAUSTED",
        });
        res.end(
          JSON.stringify({
            error: {
              code: "POLLEN_BUDGET_EXHAUSTED",
              message: err.message,
              status: "BUDGET_PAUSED",
              event: err.event,
            },
          }),
        );
        return;
      }
      throw err;
    }

    // Forward out-of-band with user's BYOP key
    const forwardHeaders: Record<string, string> = {
      authorization: `Bearer ${options.apiKey}`,
    };
    if (req.headers["content-type"]) {
      forwardHeaders["content-type"] = String(req.headers["content-type"]);
    }
    if (req.headers.accept) {
      forwardHeaders.accept = String(req.headers.accept);
    }

    try {
      const upstreamRes = await fetchFn(`${upstreamBase}${reqUrl}`, {
        method,
        headers: forwardHeaders,
        body: method === "GET" || method === "HEAD" ? undefined : rawBody,
      });

      const responseBuffer = Buffer.from(await upstreamRes.arrayBuffer());
      const contentType = upstreamRes.headers.get("content-type") ?? "application/json";
      const explicitCost = upstreamRes.headers.get("x-pollinations-mcp-cost");

      let promptTokens = 0;
      let completionTokens = 0;
      if (contentType.includes("application/json")) {
        try {
          const parsed = JSON.parse(responseBuffer.toString("utf8")) as {
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          promptTokens = parsed.usage?.prompt_tokens ?? 0;
          completionTokens = parsed.usage?.completion_tokens ?? 0;
        } catch {
          // Ignore parse errors on non-standard JSON
        }
      }

      const costPollen = estimatePollenCost({
        model: parsedModel,
        promptTokens,
        completionTokens,
        explicitCostHeader: explicitCost,
        endpoint: reqUrl,
      });

      const { status } = await options.firewall.recordSpend({
        agentId,
        role,
        endpoint: reqUrl,
        model: parsedModel,
        promptTokens,
        completionTokens,
        costPollen,
      });

      res.writeHead(upstreamRes.status, {
        "content-type": contentType,
        "x-pollen-budget-tier": status.tier,
        "x-pollen-burn-percent": String(status.burnPercent),
        "x-pollen-spent": String(status.spentPollen),
      });
      res.end(responseBuffer);
    } catch (err) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "UPSTREAM_PROXY_ERROR",
            message: err instanceof Error ? err.message : String(err),
          },
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

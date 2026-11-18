import type { AgentRunClaims } from "@shared/auth/agent-run-token.ts";
import type { AuthUser } from "@shared/auth/api-key.ts";
import { payerBucketToMeter } from "@shared/billing/balance.ts";
import { handleBalanceDeduction } from "@shared/billing/track-helpers.ts";
import { sendToTinybird } from "@shared/events.ts";
import {
    type McpUsageReceipt,
    parseMcpUsageHeaders,
} from "@shared/mcp-usage.ts";
import { getPublicOrigin } from "@shared/public-origin.ts";
import {
    getMcpPricingInfo,
    getMcpServerDefinition,
    MCP_SERVERS,
    MCP_USAGE_HEADERS,
    MCP_USER_GITHUB_HEADER,
    MCP_USER_ID_HEADER,
    type McpServerDefinition,
} from "@shared/registry/mcp.ts";
import {
    priceToEventParams,
    type TinybirdEvent,
    usageToEventParams,
} from "@shared/schemas/generation-event.ts";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Env } from "@/env.ts";
import { auth } from "@/middleware/auth.ts";
import { edgeRateLimit } from "@/middleware/rate-limit-edge.ts";
import { requestIdentity } from "@/middleware/track.ts";
import { requireAccountFunds } from "@/utils/generation-access.ts";

function requestForMcp(
    request: Request,
    server: McpServerDefinition,
    user: AuthUser,
    agentRun: AgentRunClaims | undefined,
): Request {
    const headers = new Headers(request.headers);
    if (server.forwardAuthorization !== true) {
        headers.delete("authorization");
    }
    headers.delete("cookie");
    headers.delete(MCP_USER_ID_HEADER);
    headers.delete(MCP_USER_GITHUB_HEADER);
    if (server.userScoped) {
        // Each agent gets its own state on the account, apart from the
        // account owner's.
        headers.set(
            MCP_USER_ID_HEADER,
            agentRun ? `${user.id}:agent:${agentRun.agentModelId}` : user.id,
        );
        if (user.githubId && user.githubUsername) {
            headers.set(
                MCP_USER_GITHUB_HEADER,
                `${user.githubId}+${user.githubUsername}`,
            );
        }
    }
    for (const header of Object.values(MCP_USAGE_HEADERS)) {
        headers.delete(header);
    }
    const url = new URL(request.url);
    url.protocol = "https:";
    url.host = "mcp.internal";
    url.pathname = "/";
    return new Request(url, {
        method: request.method,
        headers,
        body:
            request.method === "GET" || request.method === "HEAD"
                ? undefined
                : request.body,
        redirect: "manual",
    });
}

function responseForCaller(response: Response): Response {
    const result = new Response(response.body, response);
    for (const header of Object.values(MCP_USAGE_HEADERS)) {
        result.headers.delete(header);
    }
    return result;
}

async function settleUsage(
    c: Context<Env>,
    server: Extract<McpServerDefinition, { billing: "usage_receipt" }>,
    usage: McpUsageReceipt,
    startedAt: Date,
): Promise<void> {
    const user = c.var.auth.requireUser();
    const db = drizzle(c.env.DB);
    let deduction: Awaited<ReturnType<typeof handleBalanceDeduction>> | null =
        null;
    try {
        deduction = await handleBalanceDeduction({
            db: db as unknown as Parameters<
                typeof handleBalanceDeduction
            >[0]["db"],
            isBilledUsage: usage.cost > 0,
            totalPrice: usage.cost,
            userId: user.id,
            apiKeyId: c.var.auth.apiKey?.id,
            apiKeyPollenBalance: c.var.auth.apiKey?.pollenBalance,
            // Tool cost is known only after execution. Reconcile the final
            // receipt directly instead of inventing a maximum-cost preflight.
            apiKeyReservedAmount: 0,
            byopClientKeyId: c.var.auth.apiKey?.byopClientKeyId,
            modelPaidOnly: false,
            questPollenOnly: c.var.auth.apiKey?.questPollenOnly,
        });
    } catch (error) {
        c.var.log.error(
            "MCP billing deduction failed after response; continuing tracking: {error}",
            {
                error: error instanceof Error ? error.message : String(error),
            },
        );
    }
    const endedAt = new Date();
    const event: TinybirdEvent = {
        id: crypto.randomUUID(),
        requestId: c.get("requestId"),
        requestPath: `/mcp/${server.id}`,
        startTime: startedAt,
        endTime: endedAt,
        responseTime: endedAt.getTime() - startedAt.getTime(),
        responseStatus: usage.status,
        environment: c.env.ENVIRONMENT,
        eventType: "mcp.call",
        ...requestIdentity(c.var.auth),
        ...(deduction?.payerBucket
            ? payerBucketToMeter(deduction.payerBucket)
            : {}),
        modelRequested: server.id,
        resolvedModelRequested: server.id,
        modelUsed: server.id,
        modelProviderUsed: server.provider,
        fallbackUsed: false,
        isFinal: true,
        isBilledUsage: usage.cost > 0,
        adjustmentCosts: { [usage.adjustmentId]: usage.cost },
        adjustmentUnits: { [usage.adjustmentId]: usage.adjustmentUnits },
        ...priceToEventParams(),
        ...usageToEventParams(),
        totalCost: usage.cost,
        totalPrice: deduction?.billedPrice ?? 0,
        devPrice: usage.cost,
        markupRate: deduction?.markup?.markupRate ?? 0,
        errorResponseCode:
            usage.status >= 400 ? String(usage.status) : undefined,
        errorSource:
            usage.status >= 400 ? `${server.id}.${usage.tool}` : undefined,
        errorMessage: usage.status >= 400 ? usage.error : undefined,
    };
    c.executionCtx.waitUntil(
        sendToTinybird(
            event,
            c.env.TINYBIRD_INGEST_URL,
            c.env.TINYBIRD_INGEST_TOKEN,
            c.var.log,
        ),
    );
}

const MAX_MCP_BODY_BYTES = 8 * 1024 * 1024;

// Read the JSON-RPC message bounded at MAX_MCP_BODY_BYTES: JSON-RPC tool
// arguments are KB-scale, and this keeps one authenticated POST from
// buffering a transport-sized body into the shared gen isolate before it is
// forwarded to the server binding — the route family was the one
// authenticated JSON surface on gen without a body cap (chat/messages carry
// 32/100 MiB, the image JSON routes their own). 8 MiB keeps the umbrella's
// documented 5 MB deploySite payloads routed through gen working — the same
// size the standalone workers' cap chose.
async function readMcpMessage(
    request: Request,
): Promise<{ method?: unknown } | null> {
    const declared = Number.parseInt(
        request.headers.get("content-length") ?? "",
        10,
    );
    if (Number.isFinite(declared) && declared > MAX_MCP_BODY_BYTES) {
        throw new HTTPException(413, {
            message: "MCP request body exceeds 8 MiB",
        });
    }
    const clone = request.clone();
    const reader = clone.body?.getReader();
    if (!reader) {
        return clone
            .json<{ method?: unknown } | null>()
            .catch(() => null);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_MCP_BODY_BYTES) {
                // Best-effort drop of the branch, the shape ask-jev's probe
                // uses: a teed clone's cancel only settles once the other
                // branch finishes too, and this branch is discarded either
                // way.
                void reader.cancel().catch(() => {});
                throw new HTTPException(413, {
                    message: "MCP request body exceeds 8 MiB",
                });
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes)) as {
            method?: unknown;
        } | null;
    } catch {
        return null;
    }
}

export const mcpRoutes = new Hono<Env>()
    .use("/mcp", edgeRateLimit)
    .use("/mcp/*", edgeRateLimit)
    .get("/mcp", (c) =>
        c.json({
            data: MCP_SERVERS.map((server) => ({
                id: server.id,
                name: server.name,
                description: server.description,
                alpha: server.alpha,
                url: `${getPublicOrigin(c)}/mcp/${server.id}`,
                pricing: getMcpPricingInfo(server),
            })),
        }),
    )
    .use("/mcp/:serverId", auth())
    .all("/mcp/:serverId", async (c) => {
        const user = c.var.auth.requireUser();
        const message =
            c.req.method === "POST"
                ? await readMcpMessage(c.req.raw)
                : null;
        if (Array.isArray(message)) {
            throw new HTTPException(400, {
                message: "MCP batch requests are not supported",
            });
        }
        const serverId = c.req.param("serverId");
        const server = getMcpServerDefinition(serverId);
        if (!server) {
            throw new HTTPException(404, { message: "MCP server not found" });
        }
        if (server.agents === false && c.var.auth.agentRun) {
            throw new HTTPException(403, {
                message: `Agents can't use ${server.name}`,
            });
        }
        // A tool's cost is known only from its receipt, so a tool call needs a
        // spendable balance up front. Initialization and discovery stay free.
        if (
            server.billing === "usage_receipt" &&
            message?.method === "tools/call"
        ) {
            await requireAccountFunds(c, 0);
        }
        const binding = c.env[server.binding] as Fetcher;

        const startedAt = new Date();
        const response = await binding.fetch(
            requestForMcp(c.req.raw, server, user, c.var.auth.agentRun),
        );
        if (server.billing === "usage_receipt") {
            const usage = parseMcpUsageHeaders(response.headers);
            if (usage) {
                try {
                    await settleUsage(c, server, usage, startedAt);
                } catch (error) {
                    c.var.log.error("MCP billing failed: {error}", {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    });
                }
            }
        }
        return responseForCaller(response);
    });

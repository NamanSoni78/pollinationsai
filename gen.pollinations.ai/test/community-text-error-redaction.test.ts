import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from "cloudflare:test";
import { handleError, UpstreamError } from "@shared/error.ts";
import type { ModelDefinition } from "@shared/registry/registry.ts";
import { Hono } from "hono";
import type { Context } from "hono";
import { requestId } from "hono/request-id";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/env.ts";
import { logger } from "@/middleware/logger.ts";
import { syncTextEnvironment } from "@/text/environment.ts";
import { throwTextError } from "@/text/errors.ts";
import { generateTextPortkey } from "@/text/generateTextPortkey.js";
import type { ServiceError } from "@/text/types.js";

const PUBLISHER_URL = "https://publisher-gpu.example.com/v1/chat/completions";

function communityDefinition(): ModelDefinition {
    return {
        supportedParameters: [],
        aliases: [],
        provider: "community",
        publisher: "fixture",
        category: "text",
        addedDate: Date.now(),
        priceMultiplier: 1,
        paidOnly: false,
        cost: { promptTextTokens: 0, completionTextTokens: 0 },
        title: "Fixture Pro",
        description: "community fixture",
        inputModalities: ["text"],
        outputModalities: ["text"],
        tools: false,
        reasoning: false,
        contextLength: 8192,
        isSpecialized: false,
    } as unknown as ModelDefinition;
}

function communityOptions() {
    return {
        model: "community/fixture/pro",
        requestedModel: "community/fixture/pro",
        modelConfig: {
            provider: "openai",
            authKey: "endpoint-secret",
            model: "fixture-upstream",
            directEndpoint: PUBLISHER_URL,
        },
        modelDef: communityDefinition(),
    };
}

function createApp(route: (c: Context<Env>) => Promise<Response> | Response) {
    const app = new Hono<Env>();
    app.use("*", requestId());
    app.use("*", logger);
    app.post("/v1/chat/completions", route);
    app.onError(handleError);
    return app;
}

async function post(app: Hono<Env>) {
    const ctx = createExecutionContext();
    const response = await app.fetch(
        new Request("https://gen.test/v1/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "community/fixture/pro" }),
        }),
        {
            ...env,
            ENVIRONMENT: "test",
            LOG_LEVEL: "error",
            LOG_FORMAT: "text",
            TINYBIRD_INGEST_URL:
                "https://tinybird.test/v0/events?name=generation_event_v2",
            TINYBIRD_INGEST_TOKEN: "test_tinybird_token",
        },
        ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
}

afterEach(() => {
    vi.restoreAllMocks();
    syncTextEnvironment(env);
});

describe("community text endpoint error redaction", () => {
    it("does not disclose the publisher's host, body, or upstream message on a failed community chat attempt", async () => {
        syncTextEnvironment(env);
        vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
            Response.json(
                {
                    error: {
                        message:
                            "rate limit exceeded on gpu-box.publisher-gpu.example.com (10.0.0.5:8443)",
                    },
                },
                { status: 429 },
            ),
        );
        const app = createApp(async (c) => {
            try {
                await generateTextPortkey(
                    [{ role: "user", content: "hello" }],
                    communityOptions(),
                );
            } catch (error) {
                throwTextError(error as ServiceError);
            }
            return c.json({ ok: true });
        });

        const response = await post(app);

        // The community upstream's 429 remaps to a gateway 502.
        expect(response.status).toBe(502);
        const body = await response.text();
        // The publisher's host and raw upstream body never reach the caller,
        // and neither does the upstream-authored message text.
        expect(body).not.toContain("publisher-gpu.example.com");
        expect(body).not.toContain("gpu-box");
        expect(body).not.toContain("rate limit exceeded");
        const parsed = JSON.parse(body) as {
            error: { details?: Record<string, unknown> };
        };
        expect(parsed.error.details?.upstreamHost).toBeUndefined();
        expect(parsed.error.details?.upstreamBody).toBeUndefined();
    });

    it("keeps gateway-authored messages on community errors while dropping the publisher's host and body", async () => {
        syncTextEnvironment(env);
        // Keep the server-error telemetry fetch off the network.
        vi.spyOn(globalThis, "fetch").mockImplementation(
            async () => new Response("ok"),
        );
        const app = createApp((c) => {
            // Mirror of the /v1/responses handler's gateway-authored errors.
            throw new UpstreamError(502, {
                message:
                    "Responses provider returned an invalid response or omitted usage",
                requestUrl: new URL(PUBLISHER_URL),
                responseBody:
                    '{"error":{"message":"publisher diagnostic with host gpu-box"}}',
                redactUpstream: true,
            });
        });

        const response = await post(app);
        expect(response.status).toBe(502);
        const parsed = (await response.json()) as {
            error: {
                message: string;
                details?: Record<string, unknown>;
            };
        };
        // Our message is ours — the caller keeps the actionable diagnostic.
        expect(parsed.error.message).toContain("omitted usage");
        // The publisher's host and raw body still never reach the caller.
        expect(JSON.stringify(parsed)).not.toContain("publisher-gpu");
        expect(JSON.stringify(parsed)).not.toContain("gpu-box");
        expect(parsed.error.details?.upstreamHost).toBeUndefined();
        expect(parsed.error.details?.upstreamBody).toBeUndefined();
    });
});

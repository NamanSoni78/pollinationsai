import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from "cloudflare:test";
import { rateLimit } from "@shared/rate-limit.ts";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";

// Issue 68's class residuals (named by round 25): routes mounted outside
// proxyRoutes' catch-all limiter. solution57 covers /v1/messages,
// /internal/generation/:id and the OpenAPI routes; these tests pin the
// remaining instances — /models/status (a Tinybird 24-hour scan per distinct
// cache key), /models/stats (a KV read per request), /alpha/e2b/sandbox/*
// (a pre-auth external fetch proxy) and /quests/catalog (an Enter hop) —
// all refused with 429 before their expensive side effect runs.

/** Always-429 limiter binding, mirroring the cloudflare:test harness. */
function limiter(limit: number): RateLimit {
    const counts = new Map<string, number>();
    return {
        async limit({ key }) {
            const count = (counts.get(key) ?? 0) + 1;
            counts.set(key, count);
            return { success: count <= limit };
        },
    };
}

function limitedEnv(): typeof env {
    return {
        ...env,
        EDGE_RATE_LIMITER: limiter(0),
        EDGE_IP_RATE_LIMITER: limiter(0),
    };
}

async function fetchLimited(
    path: string,
    bindings: Record<string, unknown> = {},
    init: RequestInit = {},
): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
        new Request(`https://gen.pollinations.ai${path}`, {
            ...init,
            headers: {
                "CF-Connecting-IP": "203.0.113.7",
                ...(init.headers as Record<string, string> | undefined),
            },
        }),
        { ...limitedEnv(), ...bindings } as typeof env,
        ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
}

describe("edge rate limit coverage — residuals outside proxyRoutes", () => {
    it("refuses /models/status before the Tinybird scan runs", async () => {
        const upstream = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(Response.json({ data: [] }));
        try {
            const response = await fetchLimited(
                "/models/status?minutes=15&traffic=regular",
            );
            expect(response.status).toBe(429);
            expect(response.headers.get("Retry-After")).toBe("10");
            expect(upstream).not.toHaveBeenCalled();
        } finally {
            upstream.mockRestore();
        }
    });

    it("refuses /models/stats before the KV read runs", async () => {
        const kvGet = vi
            .spyOn(env.KV, "get")
            .mockResolvedValue(null as never);
        try {
            const response = await fetchLimited("/models/stats");
            expect(response.status).toBe(429);
            expect(kvGet).not.toHaveBeenCalled();
        } finally {
            kvGet.mockRestore();
        }
    });

    it("refuses /alpha/e2b/sandbox proxies before the external fetch", async () => {
        const upstream = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response("unreachable"));
        try {
            const response = await fetchLimited(
                "/alpha/e2b/sandbox/files?path=/x",
                {},
                {
                    headers: {
                        "e2b-sandbox-id": "abc123",
                        "e2b-sandbox-port": "49983",
                    },
                },
            );
            expect(response.status).toBe(429);
            expect(upstream).not.toHaveBeenCalled();
        } finally {
            upstream.mockRestore();
        }
    });

    it("refuses /quests/catalog before the Enter hop", async () => {
        const enterFetch = vi.fn(
            async () => new Response("enter", { status: 200 }),
        );
        const response = await fetchLimited("/quests/catalog", {
            ENTER: { fetch: enterFetch } as unknown as Fetcher,
        });
        expect(response.status).toBe(429);
        expect(enterFetch).not.toHaveBeenCalled();
    });
});

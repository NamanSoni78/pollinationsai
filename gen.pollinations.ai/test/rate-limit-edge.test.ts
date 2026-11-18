import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from "cloudflare:test";
import { rateLimit } from "@shared/rate-limit.ts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { edgeRateLimit } from "@/middleware/rate-limit-edge.ts";
import worker from "../src/index.ts";

/** Counts calls per key within one window, like the Cloudflare binding. */
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

// Small stand-ins for wrangler's 600 per key and 1,000 per IP.
function bindings() {
    return {
        EDGE_RATE_LIMITER: limiter(3),
        EDGE_IP_RATE_LIMITER: limiter(5),
    };
}

const app = new Hono().use(edgeRateLimit).get("/", (c) => c.text("ok"));

function send(
    env: ReturnType<typeof bindings>,
    { key, ip = "203.0.113.7" }: { key?: string; ip?: string },
) {
    const headers = new Headers({ "CF-Connecting-IP": ip });
    if (key) headers.set("Authorization", `Bearer ${key}`);
    return app.request("/", { headers }, env);
}

describe("edge rate limit", () => {
    it("limits sandbox port hosts before any D1 or provider lookup", async () => {
        const prepare = vi.spyOn(env.DB, "prepare").mockImplementation(() => {
            throw new Error("Sandbox lookup ran before the edge limit");
        });
        const ctx = createExecutionContext();
        const portBindings = {
            ...env,
            ENVIRONMENT: "production" as const,
            SANDBOX_DOMAIN: "pollinations.app",
            EDGE_RATE_LIMITER: limiter(0),
        };
        try {
            const response = await worker.fetch(
                new Request("https://8080-limitprobe.pollinations.app/", {
                    headers: { "CF-Connecting-IP": "203.0.113.7" },
                }),
                portBindings,
                ctx,
            );
            await waitOnExecutionContext(ctx);
            expect(response.status).toBe(429);
            expect(response.headers.get("Retry-After")).toBe("10");
            expect(prepare).not.toHaveBeenCalled();
        } finally {
            prepare.mockRestore();
        }
    });

    it("caps rotating keys from one IP at the IP limit", async () => {
        const env = bindings();
        const statuses = [];
        for (let i = 0; i < 6; i++) {
            statuses.push((await send(env, { key: `sk_fake${i}` })).status);
        }
        expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);

        const blocked = await send(env, { key: "sk_fake6" });
        expect(blocked.status).toBe(429);
        expect(blocked.headers.get("Retry-After")).toBe("10");
        expect(
            (await send(env, { key: "sk_fake7", ip: "198.51.100.1" })).status,
        ).toBe(200);
    });

    it("caps one key at its own limit across IPs", async () => {
        const env = bindings();
        const statuses = [];
        for (let i = 0; i < 4; i++) {
            const ip = `198.51.100.${i}`;
            statuses.push((await send(env, { key: "sk_one", ip })).status);
        }
        expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it("caps requests without a key per IP at the key limit", async () => {
        const env = bindings();
        const statuses = [];
        for (let i = 0; i < 4; i++) {
            statuses.push((await send(env, {})).status);
        }
        expect(statuses).toEqual([200, 200, 200, 429]);
        expect((await send(env, { ip: "198.51.100.1" })).status).toBe(200);
    });
});

// Enter's limiter: keys only, plus unkeyed requests that carry a client IP.
const enterApp = new Hono()
    .use(rateLimit({ byIp: false }))
    .get("/", (c) => c.text("ok"));

describe("enter rate limit", () => {
    it("caps requests without a key per client IP", async () => {
        const env = bindings();
        const statuses = [];
        for (let i = 0; i < 4; i++) {
            const headers = { "CF-Connecting-IP": "203.0.113.7" };
            statuses.push(
                (await enterApp.request("/", { headers }, env)).status,
            );
        }
        expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it("caps rotating made-up keys from one client IP", async () => {
        const env = bindings();
        const statuses = [];
        for (let i = 0; i < 4; i++) {
            const headers = {
                "CF-Connecting-IP": "203.0.113.7",
                Authorization: `Bearer sk_fake${i}`,
            };
            statuses.push(
                (await enterApp.request("/", { headers }, env)).status,
            );
        }
        expect(statuses).toEqual([200, 200, 200, 429]);
    });

    it("leaves internal calls without a client IP alone", async () => {
        const env = bindings();
        const statuses = [];
        for (let i = 0; i < 5; i++) {
            const headers = { Authorization: `Bearer sk_internal${i}` };
            statuses.push((await enterApp.request("/", {}, env)).status);
            statuses.push(
                (await enterApp.request("/", { headers }, env)).status,
            );
        }
        expect(statuses).toEqual(Array(10).fill(200));
    });
});

describe("edge rate limit coverage on routes outside proxyRoutes", () => {
    function limitedEnv() {
        return {
            ...env,
            ENVIRONMENT: "production" as const,
            EDGE_RATE_LIMITER: limiter(0),
            EDGE_IP_RATE_LIMITER: limiter(0),
        };
    }

    it("refuses /v1/messages before its body is parsed", async () => {
        const ctx = createExecutionContext();
        // Invalid JSON: without a limiter on the route this is a 400 from
        // the body validator, proving the parse ran — after the fix the
        // limiter answers before the 32 MiB body is read.
        const response = await worker.fetch(
            new Request("https://gen.pollinations.ai/v1/messages", {
                method: "POST",
                headers: {
                    "CF-Connecting-IP": "203.0.113.7",
                    "Content-Type": "application/json",
                },
                body: "{",
            }),
            limitedEnv(),
            ctx,
        );
        await waitOnExecutionContext(ctx);
        expect(response.status).toBe(429);
        expect(response.headers.get("Retry-After")).toBe("10");
    });

    it("refuses /internal/generation handoffs before the coordinator RPC", async () => {
        const ctx = createExecutionContext();
        // The nonce check lives inside the Durable Object; without a
        // limiter this request performs a DO stub call (instantiating an
        // attacker-chosen object) and then 404s.
        const response = await worker.fetch(
            new Request(
                `https://gen.pollinations.ai/internal/generation/${"a".repeat(64)}`,
                {
                    method: "POST",
                    headers: {
                        "CF-Connecting-IP": "203.0.113.7",
                        "x-generation-handoff": "x",
                    },
                },
            ),
            limitedEnv(),
            ctx,
        );
        await waitOnExecutionContext(ctx);
        expect(response.status).toBe(429);
    });

    it("refuses /openapi.json floods", async () => {
        const ctx = createExecutionContext();
        const response = await worker.fetch(
            new Request("https://gen.pollinations.ai/openapi.json", {
                headers: { "CF-Connecting-IP": "203.0.113.7" },
            }),
            limitedEnv(),
            ctx,
        );
        await waitOnExecutionContext(ctx);
        expect(response.status).toBe(429);
    });
});

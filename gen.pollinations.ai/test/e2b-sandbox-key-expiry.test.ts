import { createApiKeyAuth, findUsableApiKey } from "@shared/auth/api-key.ts";
import { createApiKeyForUser } from "@shared/auth/api-key-creation.ts";
import { apikey as apiKeyTable } from "@shared/db/better-auth.ts";
import { requestId } from "@shared/middleware/request-id.ts";
import { createTestApiKey, test } from "@shared/test/fixtures/index.ts";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, expect, vi } from "vitest";
import { logger } from "../src/middleware/logger.ts";
import { E2B_PATH, e2bRoutes } from "../src/routes/e2b.ts";

const GEN_ORIGIN = "https://gen.pollinations.ai";

// Same mounting as gen's index.ts: requestId + logger, then the e2b routes.
const mountRealE2bRoutes = () =>
    new Hono().use(requestId()).use(logger).route(E2B_PATH, e2bRoutes);

type EnterCall = { url: string; body: unknown };

afterEach(() => {
    vi.unstubAllGlobals();
});

test("the polli login written into every sandbox expires with it", async () => {
    // A caller like the docs describe: all polli permissions, funded account.
    const caller = await createTestApiKey({
        accountPermissions: ["profile", "usage", "machines", "keys"],
        user: { tierBalance: 10 },
    });

    const enterCalls: EnterCall[] = [];
    const writtenFiles: { path: string | null; content: string }[] = [];
    const realFetch = globalThis.fetch;

    vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (url.origin === new URL(env.TINYBIRD_INGEST_URL).origin) {
                return new Response(null, { status: 202 });
            }
            if (url.origin === "https://api.e2b.app") {
                if (url.pathname === "/v2/sandboxes" && request.method === "POST") {
                    return Response.json({
                        sandboxID: "poc1",
                        domain: null,
                        envdAccessToken: "envd",
                        trafficAccessToken: null,
                    });
                }
                if (url.pathname === "/v2/sandboxes" && request.method === "GET") {
                    return Response.json([]); // requireCapacity: none running
                }
                const get = url.pathname.match(/^\/(?:v2\/)?sandboxes\/([^/]+)$/);
                if (get && request.method === "GET") {
                    return Response.json({
                        sandboxID: get[1],
                        startedAt: new Date(Date.now() - 1000).toISOString(),
                        endAt: new Date(Date.now() + 300_000).toISOString(),
                        cpuCount: 2,
                        memoryMB: 512,
                        state: "running",
                        metadata: { pollinations_user: caller.userId },
                    });
                }
            }
            const envd = url.hostname.match(/^49983-(\w+)\.e2b\.app$/);
            if (envd && url.pathname === "/files") {
                writtenFiles.push({
                    path: url.searchParams.get("path"),
                    content: await request.text(),
                });
                return new Response(null, { status: 200 });
            }
            return realFetch(input, init);
        },
    );

    const testEnv = {
        ...env,
        E2B_API_KEY: "test-e2b-key",
        // enter as a service binding: record what gen asks for.
        ENTER: {
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = new Request(input, init);
                enterCalls.push({
                    url: request.url,
                    body: await request.json(),
                });
                return Response.json({
                    id: "test-enter-key",
                    key: "sk_test_enter_key",
                });
            },
        },
    };

    const app = mountRealE2bRoutes();
    const ctx = createExecutionContext();
    const response = await app.fetch(
        new Request(`${GEN_ORIGIN}/alpha/e2b/v2/sandboxes`, {
            method: "POST",
            headers: {
                "x-api-key": caller.key,
                "content-type": "application/json",
            },
            body: JSON.stringify({ templateID: "pollinations" }),
        }),
        testEnv,
        ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(201);

    // 1) What logIn() asked enter's key API for: no keep in the request, so
    //    the key expires at E2B's 24h run cap instead of never.
    expect(enterCalls).toHaveLength(1);
    const asked = enterCalls[0].body as Record<string, unknown>;
    expect(asked).toEqual({
        name: "polli-sandbox-poc1",
        type: "secret",
        accountPermissions: ["profile", "usage", "machines"],
        expiresIn: 86_400,
    });

    // 2) The credentials file now lives inside the sandbox, as before.
    expect(writtenFiles).toHaveLength(1);
    expect(writtenFiles[0].path).toBe(
        "/home/user/.pollinations/credentials.staging.json",
    );

    // 3) Replay the captured request through enter's REAL key-creation stack
    //    (real createApiKeyForUser -> real better-auth -> real D1).
    const sandboxKey = await createApiKeyForUser({
        authClient: createApiKeyAuth(env),
        dbBinding: env.DB,
        userId: caller.userId,
        name: asked.name as string,
        type: asked.type as "secret",
        accountPermissions: asked.accountPermissions as string[],
        expiresIn: asked.expiresIn as number,
    });
    const row = await drizzle(env.DB)
        .select()
        .from(apiKeyTable)
        .where(eq(apiKeyTable.id, sandboxKey.id))
        .get();
    expect(row?.expiresAt).not.toBeNull();
    expect((row?.expiresAt as number) * 1000).toBeGreaterThan(Date.now());

    // 4) Time retires an expiring key — the enforcement the fix relies on.
    const control = await createApiKeyForUser({
        authClient: createApiKeyAuth(env),
        dbBinding: env.DB,
        userId: caller.userId,
        name: "control-1s",
        type: "secret",
        expiresIn: 1,
        accountPermissions: [],
    });
    expect(await findUsableApiKey(env, control.key)).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await findUsableApiKey(env, control.key)).toBeNull();
});

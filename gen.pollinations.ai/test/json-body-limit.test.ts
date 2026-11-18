import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from "cloudflare:test";
import { test as baseTest } from "@shared/test/fixtures/index.ts";
import {
    createFetchMock,
    type MockAPI,
    teardownFetchMock,
} from "@shared/test/mocks/fetch.ts";
import { createMockTinybird } from "@shared/test/mocks/tinybird.ts";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { Hono } from "hono";
import { jsonBodyLimit } from "../src/routes/generation-handlers.ts";
import worker from "../src/index.ts";
import googleCloudAuth from "../src/text/auth/googleCloudAuth.ts";
import { withInlineGenerationCoordinator } from "./helpers/inline-generation-coordinator.ts";

const TINYBIRD_STATS_HOST = "api.europe-west2.gcp.tinybird.co";

beforeEach(() => {
    vi.spyOn(googleCloudAuth, "getAccessToken").mockResolvedValue(
        "test-google-access-token",
    );
});

afterEach(async () => {
    await teardownFetchMock();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const test = baseTest.extend<{
    mocks: {
        enable: (...names: ("tinybird" | "tinybirdStats")[]) => Promise<void>;
    };
}>({
    // biome-ignore lint/correctness/noEmptyPattern: vitest fixture pattern requires object destructuring
    mocks: async ({}, use) => {
        env.GOOGLE_PROJECT_ID = "test-project";
        process.env.GOOGLE_PROJECT_ID = env.GOOGLE_PROJECT_ID;
        const mock = createFetchMock({
            tinybird: createMockTinybird(),
            tinybirdStats: {
                state: {},
                handlerMap: {
                    [TINYBIRD_STATS_HOST]: async () =>
                        Response.json({ data: [] }),
                },
                reset: () => {},
            } satisfies MockAPI<Record<string, never>>,
        });
        await use({ enable: mock.enable });
    },
});

async function fetchWorker(path: string, init: RequestInit = {}) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
        new Request(`https://gen.pollinations.ai${path}`, init),
        withInlineGenerationCoordinator(env),
        ctx,
    );
    return {
        response,
        wait: () => waitOnExecutionContext(ctx),
    };
}

describe("jsonBodyLimit", () => {
    test("gates a declared (content-length) JSON body at 32 MiB before parsing", async () => {
        const gateApp = new Hono();
        let parsed = false;
        gateApp.use(jsonBodyLimit);
        gateApp.post("/x", async (c) => {
            // If the gate passed, the body is actually parsed here — an
            // oversized declaration must never reach this point.
            parsed = true;
            return c.text("parsed");
        });

        const oversized = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": String(33 * 1024 * 1024),
                },
                body: "x",
            }),
        );
        expect(oversized.status).toBe(413);
        expect(await oversized.text()).toMatch(/32 MiB/i);
        expect(parsed).toBe(false);

        // A declared body under the limit reaches the route unmodified.
        const fine = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": String(1024),
                },
                body: "x",
            }),
        );
        expect(fine.status).toBe(200);
        expect(await fine.text()).toBe("parsed");
    });

    test("lets non-JSON content types through untouched", async () => {
        const gateApp = new Hono();
        let parsed = false;
        gateApp.use(jsonBodyLimit);
        gateApp.post("/x", async (c) => {
            parsed = true;
            return c.text("parsed");
        });

        // A huge multipart declaration is the multipart gate's business.
        const multipart = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: {
                    "content-type": "multipart/form-data; boundary=x",
                    "content-length": String(60 * 1024 * 1024),
                },
                body: "x",
            }),
        );
        expect(multipart.status).toBe(200);
        expect(parsed).toBe(true);
    });

    test("matches JSON content types with parameters and vendor suffixes", async () => {
        const gateApp = new Hono();
        gateApp.use(jsonBodyLimit);
        gateApp.post("/x", async (c) => c.text("parsed"));

        const vendorJson = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: {
                    "content-type": "application/vnd.api+json; charset=utf-8",
                    "content-length": String(33 * 1024 * 1024),
                },
                body: "x",
            }),
        );
        expect(vendorJson.status).toBe(413);
    });

    test("rejects an oversized declared JSON body on /v1/audio/speech before any buffering", async ({
        paidApiKey: apiKey,
    }) => {
        const { response, wait } = await fetchWorker("/v1/audio/speech", {
            method: "POST",
            headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
                "content-length": String(60 * 1024 * 1024),
            },
            body: "x",
        });

        try {
            const body = await response.text();
            expect(response.status).toBe(413);
            expect(body).toMatch(/32 MiB/i);
        } finally {
            await wait();
        }
    });

    test("does not block a normal JSON speech request", async ({
        paidApiKey: apiKey,
        mocks,
    }) => {
        await mocks.enable("tinybird", "tinybirdStats");
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "audio/mpeg" },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const { response, wait } = await fetchWorker("/v1/audio/speech", {
            method: "POST",
            headers: {
                authorization: `Bearer ${apiKey}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: "openai/tts-1",
                input: "hello",
            }),
        });

        try {
            const body = await response.text();
            expect(body).not.toMatch(/32 MiB/i);
            expect(response.status).not.toBe(413);
        } finally {
            await wait();
        }
    });
});

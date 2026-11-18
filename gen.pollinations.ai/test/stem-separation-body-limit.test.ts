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
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import worker from "../src/index.ts";
import { stemBodyLimit } from "../src/routes/stem-separation.ts";
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

describe("stemBodyLimit", () => {
    test("enforces the ceiling on a streamed body without a declaration", async () => {
        const gateApp = new Hono();
        let produced = 0;
        const chunk = new Uint8Array(64 * 1024);
        gateApp.use(stemBodyLimit);
        gateApp.post("/x", async (c) => {
            // Consume the rewired stream so the counting reader runs.
            await c.req.arrayBuffer();
            return c.text("parsed");
        });

        const response = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                // No content-length declaration: hono's bodyLimit counts the
                // stream itself, so a chunked attacker cannot slip past.
                headers: { "content-type": "application/json" },
                body: new ReadableStream({
                    pull(controller) {
                        // 640 x 64 KiB = 40 MiB, under the 52 MiB ceiling.
                        if (produced >= 640 * chunk.byteLength) {
                            controller.close();
                            return;
                        }
                        produced += chunk.byteLength;
                        controller.enqueue(chunk);
                    },
                }),
                // @ts-expect-error duplex is required for streaming bodies
                duplex: "half",
            }),
        );
        expect(produced).toBe(640 * chunk.byteLength);
        expect(response.status).toBe(200);

        // A stream past the ceiling is cut at the cap, not drained.
        let hugeProduced = 0;
        const huge = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: new ReadableStream({
                    pull(controller) {
                        // 1280 x 64 KiB = 80 MiB, past the 52 MiB ceiling.
                        if (hugeProduced >= 1280 * chunk.byteLength) {
                            controller.close();
                            return;
                        }
                        hugeProduced += chunk.byteLength;
                        controller.enqueue(chunk);
                    },
                }),
                // @ts-expect-error duplex is required for streaming bodies
                duplex: "half",
            }),
        );
        expect(huge.status).toBe(413);
        expect(await huge.text()).toMatch(/52 MiB/i);
        expect(hugeProduced).toBeLessThanOrEqual(
            52 * 1024 * 1024 + 2 * chunk.byteLength,
        );
    });

    test("rejects an oversized declared multipart body on /alpha/audio/stem-separation before the pre-auth parse", async () => {
        const { response, wait } = await fetchWorker(
            "/alpha/audio/stem-separation",
            {
                method: "POST",
                headers: {
                    "content-type": "multipart/form-data; boundary=x",
                    "content-length": String(60 * 1024 * 1024),
                },
                body: "x",
            },
        );

        try {
            const body = await response.text();
            expect(response.status).toBe(413);
            expect(body).toMatch(/52 MiB/i);
        } finally {
            await wait();
        }
    });

    test("rejects an oversized declared JSON body on /alpha/audio/stem-separation before the pre-auth parse", async () => {
        const { response, wait } = await fetchWorker(
            "/alpha/audio/stem-separation",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "content-length": String(60 * 1024 * 1024),
                },
                body: "x",
            },
        );

        try {
            const body = await response.text();
            expect(response.status).toBe(413);
            expect(body).toMatch(/52 MiB/i);
        } finally {
            await wait();
        }
    });

    test("does not block a normal-sized stem-separation request", async () => {
        const { response, wait } = await fetchWorker(
            "/alpha/audio/stem-separation",
            {
                method: "POST",
                headers: {
                    "content-type": "multipart/form-data; boundary=x",
                    "content-length": String(1024),
                },
                body: "x",
            },
        );

        try {
            const body = await response.text();
            expect(body).not.toMatch(/52 MiB/i);
            expect(response.status).not.toBe(413);
        } finally {
            await wait();
        }
    });
});

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
import { multipartBodyLimit } from "../../src/routes/generation-handlers.ts";
import worker from "../../src/index.ts";
import googleCloudAuth from "../../src/text/auth/googleCloudAuth.ts";
import { withInlineGenerationCoordinator } from "../helpers/inline-generation-coordinator.ts";

const TINYBIRD_STATS_HOST = "api.europe-west2.gcp.tinybird.co";

beforeEach(() => {
    vi.spyOn(googleCloudAuth, "getAccessToken").mockResolvedValue(
        "test-google-access-token",
    );
});

afterEach(async () => {
    await teardownFetchMock();
    vi.restoreAllMocks();
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

function editsForm(options: {
    fileCount?: number;
    fileBytes?: number;
}) {
    const { fileCount = 1, fileBytes = 1024 } = options;
    const form = new FormData();
    form.set("model", "openai/gpt-image-1-mini");
    form.set("prompt", "brighten");
    for (let index = 0; index < fileCount; index += 1) {
        form.append(
            "image",
            new File([new Uint8Array(fileBytes).fill(65)], `src-${index}.png`, {
                type: "image/png",
            }),
        );
    }
    return form;
}

describe("POST /v1/images/edits multipart input caps", () => {
    test("rejects more than 8 image files in one request", async ({
        paidApiKey: apiKey,
        mocks,
    }) => {
        await mocks.enable("tinybird", "tinybirdStats");
        const { response, wait } = await fetchWorker("/v1/images/edits", {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}` },
            body: editsForm({ fileCount: 9 }),
        });

        try {
            const body = await response.text();
            expect(response.status).toBe(400);
            expect(body).toMatch(/too many image files/i);
        } finally {
            await wait();
        }
    });

    test("rejects a single image file above the 20 MiB per-file limit before the base64 copies", async ({
        paidApiKey: apiKey,
        mocks,
    }) => {
        await mocks.enable("tinybird", "tinybirdStats");
        const { response, wait } = await fetchWorker("/v1/images/edits", {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}` },
            body: editsForm({ fileCount: 1, fileBytes: 21 * 1024 * 1024 }),
        });

        try {
            const body = await response.text();
            expect(response.status).toBe(413);
            expect(body).toMatch(/per-file limit/i);
        } finally {
            await wait();
        }
    });

    test("gates a declared (content-length) multipart body at 52 MiB before parsing", async () => {
        const gateApp = new Hono();
        let parsed = false;
        gateApp.use(multipartBodyLimit);
        gateApp.post("/x", async (c) => {
            // If the gate passed, the body is actually parsed here — a
            // spoofed 53 MiB declaration must never reach this point.
            parsed = true;
            return c.text("parsed");
        });

        const oversized = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: {
                    "content-type": "multipart/form-data; boundary=x",
                    "content-length": String(53 * 1024 * 1024),
                },
                body: "x",
            }),
        );
        expect(oversized.status).toBe(413);
        expect(await oversized.text()).toMatch(/52 MiB/i);
        expect(parsed).toBe(false);

        // A declared body under the limit reaches the route unmodified.
        const fine = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: {
                    "content-type": "multipart/form-data; boundary=x",
                    "content-length": String(1024),
                },
                body: "x",
            }),
        );
        expect(fine.status).toBe(200);
        expect(await fine.text()).toBe("parsed");
    });

    test("does not block a normal two-file edit request at the input caps", async ({
        paidApiKey: apiKey,
        mocks,
    }) => {
        await mocks.enable("tinybird", "tinybirdStats");
        const { response, wait } = await fetchWorker("/v1/images/edits", {
            method: "POST",
            headers: { authorization: `Bearer ${apiKey}` },
            body: editsForm({ fileCount: 2, fileBytes: 2048 }),
        });

        try {
            const body = await response.text();
            // The request passes every input cap (it may still fail later on
            // the unmocked provider — that is expected and fine here).
            expect(body).not.toMatch(
                /too many image files|per-file limit|52 MiB multipart limit|too many media bytes/i,
            );
            expect(response.status).not.toBe(413);
        } finally {
            await wait();
        }
    });
});

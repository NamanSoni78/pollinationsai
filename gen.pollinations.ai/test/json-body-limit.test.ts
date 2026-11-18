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
import { jsonBodyLimit } from "../src/routes/generation-handlers.ts";
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

    test("gates multipart bodies at their own 52 MiB ceiling, counted by stream when undeclared", async () => {
        const gateApp = new Hono();
        gateApp.use(jsonBodyLimit);
        gateApp.post("/x", async (c) => {
            // A real formData() parse proves the counting wrap keeps workerd's
            // multipart parser working for undeclared (fetch FormData) bodies.
            const form = await c.req.formData();
            return c.text(`parsed:${form.get("field")}`);
        });

        // A huge declared multipart upload is rejected at the 52 MiB ceiling
        // (the same cap multipartBodyLimit enforces on the declared length).
        const oversized = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: {
                    "content-type": "multipart/form-data; boundary=x",
                    "content-length": String(60 * 1024 * 1024),
                },
                body: "x",
            }),
        );
        expect(oversized.status).toBe(413);
        expect(await oversized.text()).toMatch(/52 MiB/i);

        // An undeclared (streamed) multipart body — the shape fetch() with a
        // FormData body produces — parses fine through the counting wrap.
        const form = new FormData();
        form.append("field", "value");
        const undeclared = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                body: form,
            }),
        );
        expect(undeclared.status).toBe(200);
        expect(await undeclared.text()).toBe("parsed:value");

        // ...and an undeclared multipart stream over the ceiling is counted
        // and rejected instead of buffering unboundedly.
        const undeclaredOversized = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: { "content-type": "multipart/form-data; boundary=x" },
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode(
                                "x".repeat(53 * 1024 * 1024),
                            ),
                        );
                        controller.close();
                    },
                }),
                duplex: "half",
            } as RequestInit),
        );
        expect(undeclaredOversized.status).toBe(413);
    });

    test("gates an oversized body declared text/plain (parse sites ignore the content type)", async () => {
        const gateApp = new Hono();
        let parsed = false;
        gateApp.use(jsonBodyLimit);
        gateApp.post("/x", async (c) => {
            parsed = true;
            return c.text("parsed");
        });

        const textPlain = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: {
                    "content-type": "text/plain",
                    "content-length": String(33 * 1024 * 1024),
                },
                body: "x",
            }),
        );
        expect(textPlain.status).toBe(413);
        expect(parsed).toBe(false);

        // Same for a request with no content-type header at all.
        const untyped = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: { "content-length": String(33 * 1024 * 1024) },
                body: "x",
            }),
        );
        expect(untyped.status).toBe(413);
    });

    test("gates an oversized body with no content-length by counting streamed bytes", async () => {
        const gateApp = new Hono();
        gateApp.use(jsonBodyLimit);
        gateApp.post("/x", async (c) => c.text(`parsed:${(await c.req.text()).length}`));

        // Chunked/streamed body: no content-length to check, so the gate
        // wraps the stream and counts. Small bodies still parse.
        const small = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode("hello"));
                        controller.close();
                    },
                }),
                duplex: "half",
            } as RequestInit),
        );
        expect(small.status).toBe(200);
        expect(await small.text()).toBe("parsed:5");

        const oversized = await gateApp.request(
            new Request("http://test/x", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode(
                                "x".repeat(33 * 1024 * 1024),
                            ),
                        );
                        controller.close();
                    },
                }),
                duplex: "half",
            } as RequestInit),
        );
        expect(oversized.status).toBe(413);
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

describe("jsonBodyLimit on /register", () => {
    test("rejects an oversized declared JSON body before the pre-auth parse", async () => {
        // /register parses its JSON before checking PLN_GPU_TOKEN, so the
        // anonymous parse is exactly the surface the cap must bound.
        const { response, wait } = await fetchWorker("/register", {
            method: "POST",
            headers: {
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

    test("still parses a normal-sized /register body ahead of its token check", async () => {
        // A well-formed anonymous body keeps reaching the parser and is
        // answered by the PLN_GPU_TOKEN check (401 without a token).
        const { response, wait } = await fetchWorker("/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: "https://gpu.test" }),
        });

        try {
            expect(response.status).toBe(401);
        } finally {
            await wait();
        }
    });

    test("rejects an oversized text/plain body before the pre-auth parse", async () => {
        // The parse is c.req.json(), which ignores the declared content type:
        // a text/plain declaration must not smuggle the body past the gate.
        const { response, wait } = await fetchWorker("/register", {
            method: "POST",
            headers: {
                "content-type": "text/plain",
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

    test("aborts an oversized undeclared (streamed) body at the cap", async () => {
        // No content-length header: the gate counts the streamed bytes and
        // errors the stream at 32 MiB. The body is deliberately VALID JSON:
        // without the gate it would parse fully and reach the token check
        // (401); with the gate the aborted read surfaces as Invalid JSON
        // (400) after a bounded read instead.
        const oversizedUrl = `https://gpu.test/${"x".repeat(33 * 1024 * 1024)}`;
        const { response, wait } = await fetchWorker("/register", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(
                        new TextEncoder().encode(
                            JSON.stringify({ url: oversizedUrl }),
                        ),
                    );
                    controller.close();
                },
            }),
            duplex: "half",
        } as RequestInit);

        try {
            expect(response.status).toBe(400);
            expect(await response.text()).toMatch(/invalid json/i);
        } finally {
            await wait();
        }
    });
});

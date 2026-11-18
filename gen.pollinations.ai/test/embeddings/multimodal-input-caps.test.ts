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
import worker from "../../src/index.ts";
import googleCloudAuth from "../../src/text/auth/googleCloudAuth.ts";
import { withInlineGenerationCoordinator } from "../helpers/inline-generation-coordinator.ts";

const TEST_EMBEDDING_MODEL = "google/gemini-embedding-2";
const VERTEX_HOST = "aiplatform.us.rep.googleapis.com";
const TINYBIRD_STATS_HOST = "api.europe-west2.gcp.tinybird.co";
const MEDIA_HOST = "media.example.test";
const BIG_VIDEO_HOST = "big-video.example.test";

// The platform-wide user-media budget: every other multimodal input path
// shares one 20 MiB aggregate (MAX_IMAGE_SIZE in gen.pollinations.ai/src/userImage.ts,
// imageUrlToBase64Transform.ts in the chat path). The embeddings parts path
// is the one surface with no count cap and no aggregate budget.
const MEDIA_CAP_BYTES = 20 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

beforeEach(() => {
    vi.spyOn(googleCloudAuth, "getAccessToken").mockResolvedValue(
        "test-google-access-token",
    );
});

afterEach(async () => {
    await teardownFetchMock();
    vi.restoreAllMocks();
});

type VertexState = {
    requests: {
        parts: Array<Record<string, unknown>>;
        inlineBytes: number;
    }[];
};

function createVertexMock(): MockAPI<VertexState> {
    const state: VertexState = { requests: [] };
    return {
        state,
        handlerMap: {
            [VERTEX_HOST]: async (request) => {
                const body = (await request.json()) as {
                    content?: { parts?: Array<Record<string, unknown>> };
                };
                const parts =
                    (body.content?.parts as
                        | Array<{ inlineData?: { data?: unknown } }>
                        | undefined) ?? [];
                state.requests.push({
                    parts,
                    inlineBytes: parts.reduce(
                        (total, part) =>
                            total +
                            (typeof part.inlineData?.data === "string"
                                ? part.inlineData.data.length
                                : 0),
                        0,
                    ),
                });
                return Response.json({
                    embedding: { values: [0, 0.1, 0.2] },
                    usageMetadata: {
                        promptTokenCount: 5,
                        totalTokenCount: 5,
                        // Multimodal embeds are billed per modality: the handler
                        // fails closed when Vertex does not report the split.
                        promptTokensDetails: [
                            { modality: "TEXT", tokenCount: 5 },
                        ],
                    },
                });
            },
        },
        reset: () => {
            state.requests = [];
        },
    };
}

type MediaState = { requests: number };

function createMediaHost(): MockAPI<MediaState> {
    const state: MediaState = { requests: 0 };
    const body = new Uint8Array(1024).fill(65);
    return {
        state,
        handlerMap: {
            [MEDIA_HOST]: async () => {
                state.requests += 1;
                return new Response(body, {
                    headers: { "content-type": "video/mp4" },
                });
            },
        },
        reset: () => {
            state.requests = 0;
        },
    };
}

type BigVideoState = { requests: number };

function createBigVideoHost(chunkCount: number): MockAPI<BigVideoState> {
    const state: BigVideoState = { requests: 0 };
    return {
        state,
        handlerMap: {
            [BIG_VIDEO_HOST]: async () => {
                state.requests += 1;
                return new Response(
                    new ReadableStream({
                        start(controller) {
                            const chunk = new Uint8Array(CHUNK_BYTES).fill(65);
                            for (let i = 0; i < chunkCount; i += 1) {
                                controller.enqueue(chunk);
                            }
                            controller.close();
                        },
                    }),
                    { headers: { "content-type": "video/mp4" } },
                );
            },
        },
        reset: () => {
            state.requests = 0;
        },
    };
}

type EmbeddingCapsMocks = {
    tinybird: ReturnType<typeof createMockTinybird>;
    tinybirdStats: MockAPI<Record<string, never>>;
    vertex: ReturnType<typeof createVertexMock>;
    media: ReturnType<typeof createMediaHost>;
    bigVideo: ReturnType<typeof createBigVideoHost>;
};

const test = baseTest.extend<{
    mocks: {
        enable: (...names: (keyof EmbeddingCapsMocks)[]) => Promise<void>;
        media: EmbeddingCapsMocks["media"];
        bigVideo: EmbeddingCapsMocks["bigVideo"];
        vertex: EmbeddingCapsMocks["vertex"];
    };
}>({
    // biome-ignore lint/correctness/noEmptyPattern: vitest fixture pattern requires object destructuring
    mocks: async ({}, use) => {
        env.GOOGLE_PROJECT_ID = "test-project";
        process.env.GOOGLE_PROJECT_ID = env.GOOGLE_PROJECT_ID;
        const media = createMediaHost();
        const bigVideo = createBigVideoHost(15); // 15 MiB per response
        const vertex = createVertexMock();
        const mock = createFetchMock<EmbeddingCapsMocks>({
            tinybird: createMockTinybird(),
            tinybirdStats: {
                state: {},
                handlerMap: {
                    [TINYBIRD_STATS_HOST]: async () =>
                        Response.json({ data: [] }),
                },
                reset: () => {},
            } satisfies MockAPI<Record<string, never>>,
            media,
            bigVideo,
            vertex,
        });
        await use({
            enable: mock.enable,
            media,
            bigVideo,
            vertex,
        });
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

describe("POST /v1/embeddings multimodal input caps", () => {
    test("rejects more than 8 media parts before fetching any of them", async ({
        paidApiKey: apiKey,
        mocks,
    }) => {
        await mocks.enable(
            "tinybird",
            "tinybirdStats",
            "vertex",
            "media",
        );
        const input = Array.from({ length: 9 }, (_, i) => ({
            type: "video_url",
            video_url: { url: `http://${MEDIA_HOST}/clip-${i}.mp4` },
        }));
        const { response, wait } = await fetchWorker("/v1/embeddings", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: TEST_EMBEDDING_MODEL,
                input,
            }),
        });

        try {
            const body = await response.text();
            expect(response.status).toBe(400);
            expect(body).toMatch(/too big|too many|exceeds|at most/i);

            // No part is fetched and the provider is never called.
            expect(mocks.media.state.requests).toBe(0);
            expect(mocks.vertex.state.requests).toEqual([]);
        } finally {
            await wait();
        }
    });

    test("shares one 20 MiB budget across video parts of a request", async ({
        paidApiKey: apiKey,
        mocks,
    }) => {
        await mocks.enable(
            "tinybird",
            "tinybirdStats",
            "vertex",
            "bigVideo",
        );
        // Two 15 MiB videos: each passes the per-fetch cap, together they
        // exceed the platform's aggregate media budget.
        const input = [
            {
                type: "video_url",
                video_url: { url: `http://${BIG_VIDEO_HOST}/one.mp4` },
            },
            {
                type: "video_url",
                video_url: { url: `http://${BIG_VIDEO_HOST}/two.mp4` },
            },
        ];
        const { response, wait } = await fetchWorker("/v1/embeddings", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: TEST_EMBEDDING_MODEL,
                input,
            }),
        });

        try {
            const body = await response.text();
            expect(response.status).toBe(400);
            // The first video fills 15 MiB of the shared budget; the second
            // fetch starts but is bounded to the 5 MiB remainder and rejected.
            expect(body).toMatch(/too many media bytes|media too large/i);

            // Both fetches are bounded reads; the provider never receives the
            // over-budget aggregate.
            expect(mocks.bigVideo.state.requests).toBe(2);
            expect(mocks.vertex.state.requests).toEqual([]);
        } finally {
            await wait();
        }
    });

    test("counts data-URI media parts against the aggregate budget", async ({
        paidApiKey: apiKey,
        mocks,
    }) => {
        await mocks.enable("tinybird", "tinybirdStats", "vertex");
        // Three ~7.5 MiB-raw data URIs: each is fine alone, together they
        // cross the 20 MiB aggregate budget. No remote fetch is involved.
        const rawBytes = 7.5 * 1024 * 1024;
        const base64Length = Math.ceil(((rawBytes + 2) / 3) * 4);
        const data = "A".repeat(base64Length);
        const input = Array.from({ length: 3 }, () => ({
            type: "video_url",
            video_url: { url: `data:video/mp4;base64,${data}` },
        }));
        const { response, wait } = await fetchWorker("/v1/embeddings", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: TEST_EMBEDDING_MODEL,
                input,
            }),
        });

        try {
            const body = await response.text();
            expect(response.status).toBe(400);
            expect(body).toMatch(/too many media bytes/i);
            expect(mocks.vertex.state.requests).toEqual([]);
        } finally {
            await wait();
        }
    });

    test("still serves a normal multimodal request under both caps", async ({
        paidApiKey: apiKey,
        mocks,
    }) => {
        await mocks.enable(
            "tinybird",
            "tinybirdStats",
            "vertex",
            "media",
        );
        const input = [
            { type: "text", text: "describe these" },
            {
                type: "image_url",
                image_url: { url: "data:image/png;base64,aGVsbG8=" },
            },
            { type: "video_url", video_url: { url: `http://${MEDIA_HOST}/a.mp4` } },
            { type: "video_url", video_url: { url: `http://${MEDIA_HOST}/b.mp4` } },
        ];
        const { response, wait } = await fetchWorker("/v1/embeddings", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: TEST_EMBEDDING_MODEL,
                input,
            }),
        });

        try {
            const body = await response.text();
            if (response.status !== 200)
                console.log(
                    "CONTROL BODY:",
                    body.slice(0, 600),
                );
            expect(response.status).toBe(200);
            expect(mocks.media.state.requests).toBe(2);
            expect(mocks.vertex.state.requests).toHaveLength(1);
            expect(
                mocks.vertex.state.requests[0]?.parts,
            ).toHaveLength(4);
        } finally {
            await wait();
        }
    });
});

import { IMAGE_SERVICES } from "@shared/registry/image.ts";
import { UpstreamError } from "@shared/error.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncImageEnv } from "../../src/image/env.ts";
import { callAlibabaImage } from "../../src/image/models/alibabaImageModel.ts";
import { callAlibabaVideo } from "../../src/image/models/alibabaVideoModel.ts";
import { callKlingVideoAPI } from "../../src/image/models/klingVideoModel.ts";
import { callMinimaxH3API } from "../../src/image/models/minimaxH3Model.ts";
import { callXaiImageAPI } from "../../src/image/models/xaiModel.ts";
import type { ImageParams } from "../../src/image/params.ts";

// Issue 75's model3d/fal-fallback sweep left these media clients as the
// documented residual: every case below fails AFTER the provider's paid
// event (xAI's 200 with the image URL in hand; DashScope's SUCCEEDED task;
// fal's COMPLETED queue + receipt), so the caller must be settled via
// error.billedUsage exactly like the clients issues 25/72/75 fixed.

const KLING_TEXT_ENDPOINT =
    "https://queue.fal.run/fal-ai/kling-video/v3/standard/text-to-video";
const KLING_STATUS_URL =
    "https://queue.fal.run/fal-ai/kling-video/requests/test/status";
const KLING_RESULT_URL =
    "https://queue.fal.run/fal-ai/kling-video/requests/test";
const KLING_VIDEO_URL = "https://fal.media/kling-test.mp4";

const H3_ENDPOINT = "https://queue.fal.run/minimax/h3/text-to-video";
const H3_STATUS_URL = "https://queue.fal.run/minimax/h3/requests/test/status";
const H3_RESULT_URL = "https://queue.fal.run/minimax/h3/requests/test";
const H3_VIDEO_URL = "https://fal.media/minimax-h3-test.mp4";

const XAI_URL = "https://cdn.x.ai/result.png";

const realSetTimeout = globalThis.setTimeout;

const baseParams = (model: ImageParams["model"]): ImageParams => ({
    model,
    width: 1280,
    height: 720,
    dimensionsExplicit: true,
    seed: 42,
    safe: false,
    quality: "medium",
    image: [],
    transparent: false,
    reasoning: "balanced",
    audio: false,
    duration: 5,
});

async function expectBilled(
    fn: () => Promise<unknown>,
    check: (billedUsage: unknown, status: number) => void,
) {
    try {
        await fn();
        expect.unreachable("expected the call to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        const upstream = error as UpstreamError & {
            billedUsage?: Record<string, number>;
        };
        check(upstream.billedUsage, upstream.status);
    }
}

function stubFetch(
    route: (url: URL) => Response | Promise<Response>,
) {
    vi.spyOn(globalThis, "fetch").mockImplementation(
        ((input: RequestInfo | URL) =>
            route(
                new URL(input instanceof Request ? input.url : String(input)),
            )) as unknown as typeof fetch,
    );
}

function json(body: unknown, headers: Record<string, string> = {}) {
    return Response.json(body, {
        headers: { "content-type": "application/json", ...headers },
    });
}

function newResponse500() {
    return new Response("boom", { status: 500 });
}

// The fal queue poll sleeps between status checks; resolve immediately so
// kling's 5xx retry backoffs also finish inside the test timeout.
beforeEach(() => {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
        fn: () => void,
        _ms?: number,
    ) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
});

afterEach(() => {
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout =
        realSetTimeout;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("post-paid failure settlement media sweep", () => {
    it("X1: xAI image whose download fails settles the generation", async () => {
        syncImageEnv(
            { XAI_API_KEY: "xai-test-key" } as CloudflareBindings,
            ["XAI_API_KEY"],
        );
        stubFetch((url) => {
            if (url.href === "https://api.x.ai/v1/images/generations") {
                return json({ data: [{ url: XAI_URL }] });
            }
            if (url.href === XAI_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callXaiImageAPI(
                    "a cat",
                    baseParams("x-ai/grok-imagine-image"),
                ),
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("X2: xAI edit whose download fails settles the input+output tokens", async () => {
        syncImageEnv(
            { XAI_API_KEY: "xai-test-key" } as CloudflareBindings,
            ["XAI_API_KEY"],
        );
        stubFetch((url) => {
            if (url.href === "https://api.x.ai/v1/images/edits") {
                return json({ data: [{ url: XAI_URL }] });
            }
            if (url.href === XAI_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callXaiImageAPI("a cat", {
                    ...baseParams("x-ai/grok-imagine-image"),
                    image: ["https://a.example/1.png", "https://a.example/2.png"],
                }),
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    promptImageTokens: 2,
                    completionImageTokens: 1,
                }),
        );
    });

    it("AV1: Alibaba video whose download fails settles the reported seconds", async () => {
        syncImageEnv(
            { DASHSCOPE_API_KEY: "dashscope-test-key" } as CloudflareBindings,
            ["DASHSCOPE_API_KEY"],
        );
        stubFetch((url) => {
            if (
                url.href ===
                "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis"
            ) {
                return json({
                    output: {
                        task_id: "job",
                        task_status: "SUCCEEDED",
                        video_url: "https://example.com/result.mp4",
                    },
                    usage: {
                        input_video_duration: 3,
                        output_video_duration: 5,
                    },
                });
            }
            if (url.href === "https://example.com/result.mp4") {
                return newResponse500();
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callAlibabaVideo("a dog", baseParams("alibaba/wan-3.0"), "3.0"),
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 5,
                    promptVideoSeconds: 3,
                }),
        );
    });

    it("AV2: Alibaba video task SUCCEEDED without a video settles the requested duration", async () => {
        syncImageEnv(
            { DASHSCOPE_API_KEY: "dashscope-test-key" } as CloudflareBindings,
            ["DASHSCOPE_API_KEY"],
        );
        stubFetch((url) => {
            if (
                url.href ===
                "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis"
            ) {
                return json({
                    output: { task_id: "job", task_status: "SUCCEEDED" },
                    usage: { output_video_duration: 7 },
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callAlibabaVideo("a dog", baseParams("alibaba/wan-3.0"), "3.0"),
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 5,
                }),
        );
    });

    it("AI1: async Alibaba image whose download fails settles the counted images", async () => {
        syncImageEnv(
            { DASHSCOPE_API_KEY: "dashscope-test-key" } as CloudflareBindings,
            ["DASHSCOPE_API_KEY"],
        );
        stubFetch((url) => {
            if (
                url.href ===
                "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/image-generation/generation"
            ) {
                return json({
                    output: {
                        task_id: "job",
                        task_status: "SUCCEEDED",
                        choices: [
                            {
                                message: {
                                    content: [
                                        { image: "https://example.com/img.png" },
                                    ],
                                },
                            },
                        ],
                    },
                    usage: { output_image_count: 2, input_image_count: 3 },
                });
            }
            if (url.href === "https://example.com/img.png") {
                return newResponse500();
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callAlibabaImage(
                    "a cat",
                    { ...baseParams("alibaba/wan-2.7-image-pro"), width: 1024, height: 1024 },
                    "qwen-image-3.0-pro",
                ),
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    completionImageTokens: 2,
                    promptImageTokens: 3,
                }),
        );
    });

    it("AI2: async Alibaba image task SUCCEEDED without an image settles the flat unit", async () => {
        syncImageEnv(
            { DASHSCOPE_API_KEY: "dashscope-test-key" } as CloudflareBindings,
            ["DASHSCOPE_API_KEY"],
        );
        stubFetch((url) => {
            if (
                url.href ===
                "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/image-generation/generation"
            ) {
                return json({
                    output: { task_id: "job", task_status: "SUCCEEDED" },
                    usage: { output_image_count: 2, input_image_count: 1 },
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callAlibabaImage(
                    "a cat",
                    { ...baseParams("alibaba/wan-2.7-image-pro"), width: 1024, height: 1024 },
                    "qwen-image-3.0-pro",
                ),
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    completionImageTokens: 1,
                }),
        );
    });

    it("AI3: sync Alibaba image 200 without an image stays unbilled (not provably paid)", async () => {
        syncImageEnv(
            { DASHSCOPE_API_KEY: "dashscope-test-key" } as CloudflareBindings,
            ["DASHSCOPE_API_KEY"],
        );
        stubFetch((url) => {
            if (
                url.href ===
                "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
            ) {
                return json({
                    output: {
                        choices: [{ message: { content: [{ text: "no image" }] } }],
                    },
                    usage: { image_count: 1 },
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callAlibabaImage(
                    "a cat",
                    { ...baseParams("alibaba/wan-2.7-image"), width: 1024, height: 1024 },
                    "wan2.7-image",
                ),
            (billedUsage) => expect(billedUsage).toBeUndefined(),
        );
    });

    it("K1: Kling whose download fails settles the receipt-derived seconds", async () => {
        syncImageEnv(
            { FAL_KEY: "fal-test-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubFetch((url) => {
            if (url.href === KLING_TEXT_ENDPOINT) {
                return json({
                    status_url: KLING_STATUS_URL,
                    response_url: KLING_RESULT_URL,
                });
            }
            if (url.href === KLING_STATUS_URL) {
                return json({ status: "COMPLETED" });
            }
            if (url.href === KLING_RESULT_URL) {
                return json(
                    { video: { url: KLING_VIDEO_URL } },
                    { "x-fal-billable-units": "1.8" },
                );
            }
            if (url.href === KLING_VIDEO_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        const rates = IMAGE_SERVICES["kwaivgi/kling-v3.0-std"].cost;
        const expected = Number(
            ((1.8 * 0.14) / rates.completionVideoSeconds).toFixed(9),
        );
        await expectBilled(
            () =>
                callKlingVideoAPI(
                    "a dog",
                    baseParams("kwaivgi/kling-v3.0-std"),
                ),
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    completionVideoSeconds: expected,
                }),
        );
    });

    it("M1: MiniMax H3 whose download fails settles the reported seconds", async () => {
        syncImageEnv(
            { FAL_KEY: "fal-test-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubFetch((url) => {
            if (url.pathname.startsWith("/v1/models/pricing")) {
                return json({
                    prices: [
                        {
                            endpoint_id: url.searchParams.get("endpoint_id"),
                            unit_price: 0.025,
                            currency: "USD",
                        },
                    ],
                });
            }
            if (url.href === H3_ENDPOINT) {
                return json({
                    status_url: H3_STATUS_URL,
                    response_url: H3_RESULT_URL,
                });
            }
            if (url.href === H3_STATUS_URL) {
                return json({ status: "COMPLETED" });
            }
            if (url.href === H3_RESULT_URL) {
                return json(
                    { video: { url: H3_VIDEO_URL } },
                    { "x-fal-billable-units": "5" },
                );
            }
            if (url.href === H3_VIDEO_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callMinimaxH3API(
                    "a dog",
                    baseParams("minimax/minimax-h3"),
                ),
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 5,
                }),
        );
    });
});

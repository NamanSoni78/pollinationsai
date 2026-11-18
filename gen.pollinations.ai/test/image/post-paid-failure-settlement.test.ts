import { UpstreamError } from "@shared/error.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncImageEnv } from "../../src/image/env.ts";
import { callFalQwenImageAPI } from "../../src/image/models/falQwenImageModel.ts";
import { callFluxMaxVideoAPI } from "../../src/image/models/fluxMaxVideoModel.ts";
import { callGeminiOmniAPI } from "../../src/image/models/geminiOmniVideoModel.ts";
import { callGrokReplicateVideoAPI } from "../../src/image/models/grokReplicateVideoModel.ts";
import { callKreaImageAPI } from "../../src/image/models/kreaModel.ts";
import {
    callHappyHorseAPI,
} from "../../src/image/models/openRouterVideoModel.ts";
import { callVeoAPI } from "../../src/image/models/veoVideoModel.ts";
import { callWan3FalAPI } from "../../src/image/models/wan3FalVideoModel.ts";
import { callXaiVideoAPI } from "../../src/image/models/xaiVideoModel.ts";
import type { ImageParams } from "../../src/image/params.ts";
import googleCloudAuth from "../../src/text/auth/googleCloudAuth.ts";

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

const realNow = Date.now;
const realSetTimeout = globalThis.setTimeout;

async function expectBilled(
    fn: () => Promise<unknown>,
    status: number,
    checkBilledUsage: (billedUsage: unknown) => void,
) {
    try {
        await fn();
        expect.unreachable("expected the call to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        const upstream = error as UpstreamError & { billedUsage?: unknown };
        expect(upstream.status).toBe(status);
        checkBilledUsage(upstream.billedUsage);
    }
}

function json(body: unknown, headers: Record<string, string> = {}) {
    return Response.json(body, {
        headers: { "content-type": "application/json", ...headers },
    });
}

function stubFetch(
    route: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
    vi.stubGlobal(
        "fetch",
        ((input: RequestInfo | URL, init?: RequestInit) =>
            route(
                new URL(input instanceof Request ? input.url : String(input)),
                init,
            )) as typeof fetch,
    );
}

/** First status poll flips the clock past every deadline. */
function jumpClockAfterFirstStatusPoll(statusPath: string) {
    let jumped = false;
    vi.spyOn(Date, "now").mockImplementation(() =>
        jumped ? realNow() + 60 * 60_000 : realNow(),
    );
    return (url: URL) => {
        if (url.pathname.includes(statusPath)) jumped = true;
    };
}

// Poll sleeps resolve immediately so attempt-count loops (Veo's 90 polls)
// exhaust inside the test timeout.
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

describe("post-paid failure settlement sweep (issue 25 class-wide)", () => {
    it("V1: Veo poll timeout bills the requested seconds + audio leg", async () => {
        syncImageEnv(
            { GOOGLE_PROJECT_ID: "test-project" } as CloudflareBindings,
            ["GOOGLE_PROJECT_ID"],
        );
        vi.spyOn(googleCloudAuth, "getAccessToken").mockResolvedValue(
            "test-token",
        );
        const mark = jumpClockAfterFirstStatusPoll("fetchPredictOperation");
        stubFetch((url) => {
            if (url.href.endsWith(":predictLongRunning")) {
                return json({
                    name: "projects/test/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/op",
                });
            }
            if (url.href.endsWith(":fetchPredictOperation")) {
                mark(url);
                return json({ done: false });
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callVeoAPI("a dog", {
                    ...baseParams("google/veo-3.1-fast"),
                    duration: 4,
                    audio: true,
                }),
            504,
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 4,
                    completionAudioSeconds: 4,
                }),
        );
    });

    it("V2: Veo done-without-videos bills the requested seconds", async () => {
        syncImageEnv(
            { GOOGLE_PROJECT_ID: "test-project" } as CloudflareBindings,
            ["GOOGLE_PROJECT_ID"],
        );
        vi.spyOn(googleCloudAuth, "getAccessToken").mockResolvedValue(
            "test-token",
        );
        stubFetch((url) => {
            if (url.href.endsWith(":predictLongRunning")) {
                return json({
                    name: "projects/test/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/op",
                });
            }
            if (url.href.endsWith(":fetchPredictOperation")) {
                return json({ done: true, response: {} });
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callVeoAPI("a dog", {
                    ...baseParams("google/veo-3.1-fast"),
                    duration: 6,
                }),
            500,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 6 }),
        );
    });

    it("X1: xAI completed without a download URL bills the reported duration", async () => {
        syncImageEnv(
            { XAI_API_KEY: "xai-test-key" } as CloudflareBindings,
            ["XAI_API_KEY"],
        );
        stubFetch((url) => {
            if (url.pathname.endsWith("/generations")) {
                return json({ request_id: "req-1" });
            }
            return json({
                status: "done",
                video: { duration: 6 },
            });
        });
        await expectBilled(
            () =>
                callXaiVideoAPI(
                    "a dog",
                    baseParams("x-ai/grok-imagine-video-1.5"),
                    "grok-imagine-video-1.5",
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 6 }),
        );
    });

    it("X2: xAI poll timeout bills the requested duration and start frame", async () => {
        syncImageEnv(
            { XAI_API_KEY: "xai-test-key" } as CloudflareBindings,
            ["XAI_API_KEY"],
        );
        const mark = jumpClockAfterFirstStatusPoll("/videos/req-1");
        stubFetch((url) => {
            if (url.pathname.endsWith("/generations")) {
                return json({ request_id: "req-1" });
            }
            mark(url);
            return json({ status: "pending" });
        });
        await expectBilled(
            () =>
                callXaiVideoAPI(
                    "a dog",
                    {
                        ...baseParams("x-ai/grok-imagine-video-1.5"),
                        image: ["https://image.example.com/frame.png"],
                    },
                    "grok-imagine-video-1.5",
                ),
            504,
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    promptImageTokens: 1,
                    completionVideoSeconds: 5,
                }),
        );
    });

    it("O1: OpenRouter (HappyHorse) completed without URLs bills the duration", async () => {
        syncImageEnv(
            { OPENROUTER_API_KEY: "openrouter-test-key" } as CloudflareBindings,
            ["OPENROUTER_API_KEY"],
        );
        stubFetch((url) => {
            if (url.pathname.endsWith("/videos")) {
                return json({
                    id: "job-1",
                    polling_url: "https://openrouter.ai/api/v1/videos/job-1",
                });
            }
            return json({ status: "completed", usage: { cost: 0.1 } });
        });
        await expectBilled(
            () =>
                callHappyHorseAPI(
                    "a dog",
                    baseParams("alibaba/happyhorse-1.1"),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("O2: OpenRouter (HappyHorse) poll timeout bills the duration", async () => {
        syncImageEnv(
            { OPENROUTER_API_KEY: "openrouter-test-key" } as CloudflareBindings,
            ["OPENROUTER_API_KEY"],
        );
        const mark = jumpClockAfterFirstStatusPoll("/videos/job-1");
        stubFetch((url) => {
            if (url.pathname.endsWith("/videos")) {
                return json({
                    id: "job-1",
                    polling_url: "https://openrouter.ai/api/v1/videos/job-1",
                });
            }
            mark(url);
            return json({ status: "in_progress" });
        });
        await expectBilled(
            () =>
                callHappyHorseAPI(
                    "a dog",
                    baseParams("alibaba/happyhorse-1.1"),
                ),
            504,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("G1: Gemini Omni missing video usage bills reported legs + documented tokens", async () => {
        syncImageEnv(
            { GOOGLE_PROJECT_ID: "test-project" } as CloudflareBindings,
            ["GOOGLE_PROJECT_ID"],
        );
        vi.spyOn(googleCloudAuth, "getAccessToken").mockResolvedValue(
            "test-token",
        );
        const VIDEO_BYTES = new Uint8Array([1, 2, 3, 4]);
        stubFetch((url) => {
            if (url.pathname.endsWith("/interactions")) {
                return json({
                    status: "completed",
                    usage: {
                        input_tokens_by_modality: [
                            { modality: "text", tokens: 20 },
                        ],
                        output_tokens_by_modality: [
                            { modality: "text", tokens: 5 },
                        ],
                        total_thought_tokens: 425,
                    },
                    steps: [
                        {
                            content: [
                                {
                                    type: "video",
                                    mime_type: "video/mp4",
                                    data: Buffer.from(VIDEO_BYTES).toString(
                                        "base64",
                                    ),
                                },
                            ],
                        },
                    ],
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callGeminiOmniAPI("a dog", {
                    ...baseParams("google/gemini-omni-1.2-flash"),
                    duration: 5,
                    resolution: "720p",
                }),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    promptTextTokens: 20,
                    completionTextTokens: 5,
                    completionReasoningTokens: 425,
                    // Registry-documented 5792 tok/s at 720p x 5s.
                    completionVideoTokens: 28_960,
                }),
        );
    });

    it("K1: Krea poll timeout bills the flat image unit", async () => {
        syncImageEnv(
            { FAL_KEY: "test-fal-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        const mark = jumpClockAfterFirstStatusPoll("/status/");
        stubFetch((url) => {
            if (url.pathname.includes("/status/")) {
                mark(url);
                return json({ status: "IN_PROGRESS" });
            }
            return json({
                status_url: "https://queue.fal.run/status/krea",
                response_url: "https://queue.fal.run/resp/krea",
            });
        });
        await expectBilled(
            () => callKreaImageAPI("a dog", baseParams("krea/krea-2-medium")),
            504,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("K2: Krea completed without an image bills the flat image unit", async () => {
        syncImageEnv(
            { FAL_KEY: "test-fal-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubFetch((url) => {
            if (url.pathname.includes("/status/")) {
                return json({ status: "COMPLETED" });
            }
            if (url.pathname.includes("/resp/")) {
                return json({ images: [] });
            }
            return json({
                status_url: "https://queue.fal.run/status/krea",
                response_url: "https://queue.fal.run/resp/krea",
            });
        });
        await expectBilled(
            () => callKreaImageAPI("a dog", baseParams("krea/krea-2-medium")),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("W1: Wan 3.0 completed without a video bills the requested duration", async () => {
        syncImageEnv(
            { FAL_KEY: "test-fal-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubFetch((url) => {
            if (url.hostname === "api.fal.ai") {
                return json({
                    prices: [
                        {
                            endpoint_id: "alibaba/wan-3.0-prime/text-to-video",
                            unit_price: 0.05,
                            currency: "USD",
                        },
                    ],
                });
            }
            if (url.pathname.includes("/status/")) {
                return json({ status: "COMPLETED" });
            }
            if (url.pathname.includes("/resp/")) {
                return json({ video: {} }, { "x-fal-billable-units": "6.8" });
            }
            return json({
                status_url: "https://queue.fal.run/status/wan3",
                response_url: "https://queue.fal.run/resp/wan3",
            });
        });
        await expectBilled(
            () =>
                callWan3FalAPI(
                    "a dog",
                    baseParams("alibaba/wan-3.0"),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("W2: Wan 3.0 video URL without duration bills the requested duration", async () => {
        syncImageEnv(
            { FAL_KEY: "test-fal-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubFetch((url) => {
            if (url.hostname === "api.fal.ai") {
                return json({
                    prices: [
                        {
                            endpoint_id: "alibaba/wan-3.0-prime/text-to-video",
                            unit_price: 0.05,
                            currency: "USD",
                        },
                    ],
                });
            }
            if (url.pathname.includes("/status/")) {
                return json({ status: "COMPLETED" });
            }
            if (url.pathname.includes("/resp/")) {
                return json(
                    { video: { url: "https://fal.media/wan.mp4" } },
                    { "x-fal-billable-units": "6.8" },
                );
            }
            return json({
                status_url: "https://queue.fal.run/status/wan3",
                response_url: "https://queue.fal.run/resp/wan3",
            });
        });
        await expectBilled(
            () => callWan3FalAPI("a dog", baseParams("alibaba/wan-3.0")),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("W3: Wan 3.0 missing fal units header still bills the requested duration", async () => {
        syncImageEnv(
            { FAL_KEY: "test-fal-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubFetch((url) => {
            if (url.hostname === "api.fal.ai") {
                return json({
                    prices: [
                        {
                            endpoint_id: "alibaba/wan-3.0-prime/text-to-video",
                            unit_price: 0.05,
                            currency: "USD",
                        },
                    ],
                });
            }
            if (url.pathname.includes("/status/")) {
                return json({ status: "COMPLETED" });
            }
            if (url.pathname.includes("/resp/")) {
                // The job completed (fal billed it); the receipt header is
                // missing.
                return json({ video: { url: "https://fal.media/wan.mp4" } });
            }
            return json({
                status_url: "https://queue.fal.run/status/wan3",
                response_url: "https://queue.fal.run/resp/wan3",
            });
        });
        await expectBilled(
            () => callWan3FalAPI("a dog", baseParams("alibaba/wan-3.0")),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("F1: FLUX 3 Max completed without a video bills the requested duration", async () => {
        syncImageEnv(
            { FAL_KEY: "test-fal-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubFetch((url) => {
            if (url.hostname === "api.fal.ai") {
                return json({
                    prices: [
                        {
                            endpoint_id: "blackforestlabs/flux-3-max/text-to-video",
                            unit_price: 0.05,
                            currency: "USD",
                        },
                    ],
                });
            }
            if (url.pathname.includes("/status/")) {
                return json({ status: "COMPLETED" });
            }
            if (url.pathname.includes("/resp/")) {
                return json({}, { "x-fal-billable-units": "3" });
            }
            return json({
                status_url: "https://queue.fal.run/status/fm",
                response_url: "https://queue.fal.run/resp/fm",
            });
        });
        await expectBilled(
            () =>
                callFluxMaxVideoAPI(
                    "a dog",
                    baseParams("black-forest-labs/flux-3-max"),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("R1: Grok-on-Replicate missing duration bills the requested seconds", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (
                url.href ===
                "https://api.replicate.com/v1/models/xai/grok-imagine-video/predictions"
            ) {
                return json({
                    id: "pred-1",
                    status: "succeeded",
                    output: "https://replicate.delivery/grok.mp4",
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callGrokReplicateVideoAPI(
                    "a dog",
                    {
                        ...baseParams("x-ai/grok-imagine-video"),
                        image: ["https://image.example.com/frame.png"],
                    },
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    promptImageTokens: 1,
                    completionVideoSeconds: 5,
                }),
        );
    });

    it("Q1: fal sync image download failure bills the fal receipt units", async () => {
        syncImageEnv(
            { FAL_KEY: "test-fal-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubFetch((url) => {
            if (url.hostname === "fal.run") {
                return json(
                    { images: [{ url: "https://fal.media/klein.png" }] },
                    { "x-fal-billable-units": "2.1" },
                );
            }
            if (url.hostname === "fal.media") {
                return new Response("download failed", { status: 500 });
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callFalQwenImageAPI(
                    "a dog",
                    baseParams("black-forest-labs/flux-3-image-klein"),
                    "black-forest-labs/flux-3-image-klein",
                ),
            // fetchUpstream maps the fal.media 500 to its own upstream
            // status; the fix attaches billedUsage without changing it.
            500,
            (billedUsage) =>
                // falUnitUsage: units are counted in millionths.
                expect(billedUsage).toEqual({
                    completionImageTokens: 2_100_000,
                }),
        );
    });
});

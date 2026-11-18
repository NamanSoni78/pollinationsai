import { UpstreamError } from "@shared/error.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncImageEnv } from "../../src/image/env.ts";
import { callIdeogramTurboAPI } from "../../src/image/models/ideogramReplicateModel.ts";
import { callFluxSchnellDeepInfraAPI, callPrunaVideoAPI } from "../../src/image/models/prunaModel.ts";
import { callQwenImageAPI } from "../../src/image/models/qwenImageModel.ts";
import { callReplicateFallbackImage } from "../../src/image/models/replicateFallbackImageModel.ts";
import { callSeedanceProAPI } from "../../src/image/models/seedanceReplicateVideoModel.ts";
import { callSeedance25API } from "../../src/image/models/seedance25VideoModel.ts";
import { callSeedanceV2API } from "../../src/image/models/seedanceV2VideoModel.ts";
import { callSeedreamAPI } from "../../src/image/models/seedreamReplicateModel.ts";
import { callVeoReplicateAPI } from "../../src/image/models/veoVideoModel.ts";
import { callWanAPI } from "../../src/image/models/wanVideoModel.ts";
import { callWanImageAPI } from "../../src/image/models/wanImageModel.ts";
import type { ImageParams } from "../../src/image/params.ts";

// Issue 82's named residual, part 1: the Replicate fleet's post-paid legs.
// Every case below fails AFTER Replicate/DeepInfra's paid event (the
// prediction SUCCEEDED with the output URL in hand — or DeepInfra's 200
// carries the inference receipt), so the caller must be settled via
// error.billedUsage exactly like the clients issues 25/72/75/76 fixed.
// Controls pin the correctly-unbilled legs: a failed prediction is not
// charged by Replicate (replicate.com/docs/billing), and a null/empty
// output has no billable per-output units.

const VIDEO_URL = "https://video.example.com/out.mp4";
const IMAGE_URL = "https://image.example.com/out.png";
const INPUT_IMAGE_URL = "https://image.example.com/input.png";
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const DEEPINFRA_URL =
    "https://api.deepinfra.com/v1/inference/black-forest-labs/FLUX-1-schnell";

const baseParams = (model: ImageParams["model"]): ImageParams => ({
    model,
    width: 1024,
    height: 1024,
    dimensionsExplicit: false,
    seed: 42,
    safe: false,
    quality: "medium",
    image: [],
    transparent: false,
    reasoning: "balanced",
    audio: false,
    duration: 5,
    aspectRatio: "16:9",
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

function stubFetch(route: (url: URL) => Response | Promise<Response>) {
    vi.spyOn(globalThis, "fetch").mockImplementation(
        ((input: RequestInfo | URL) =>
            route(
                new URL(input instanceof Request ? input.url : String(input)),
            )) as unknown as typeof fetch,
    );
}

/** A succeeded prediction body with the given output and metrics. */
function predictionOk(output: unknown, metrics: Record<string, unknown> = {}) {
    return Response.json({
        id: "pred-test",
        status: "succeeded",
        output,
        metrics,
    });
}

function newResponse500() {
    return new Response("boom", { status: 500 });
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("post-paid failure settlement — Replicate video fleet", () => {
    it("RV1: seedance-2.0 download failure settles reported output seconds", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/bytedance/seedance-2.0-mini/predictions"))
                return predictionOk(VIDEO_URL, {
                    video_output_duration_seconds: 4,
                });
            if (url.href === VIDEO_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callSeedanceV2API("a cat", baseParams("bytedance/seedance-2.0-mini")),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 4,
                });
            },
        );
    });

    it("RV2: seedance-1-pro-fast download failure settles reported output seconds", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/bytedance/seedance-1-pro-fast/predictions"))
                return predictionOk(VIDEO_URL, {
                    video_output_duration_seconds: 5,
                });
            if (url.href === VIDEO_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callSeedanceProAPI("a cat", baseParams("bytedance/seedance-1-pro-fast")),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 5,
                });
            },
        );
    });

    it("RV3: wan-2.6 download failure settles reported output seconds", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/wan-video/wan-2.6-t2v/predictions"))
                return predictionOk(VIDEO_URL, {
                    video_output_duration_seconds: 5,
                });
            if (url.href === VIDEO_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callWanAPI("a cat", baseParams("alibaba/wan-2.6:replicate")),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 5,
                });
            },
        );
    });

    it("RV4: seedance-2.5 adaptive missing-duration guard settles the default floor", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/bytedance/seedance-2.5/predictions"))
                // Succeeded with the output URL in hand: paid output seconds,
                // but the duration metric is missing on an adaptive request.
                return predictionOk(VIDEO_URL, {});
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callSeedance25API("a cat", {
                    ...baseParams("bytedance/seedance-2.5"),
                    aspectRatio: "adaptive",
                    reference_videos: ["https://media.example.com/motion.mp4"],
                }),
            (billedUsage, status) => {
                expect(status).toBe(502);
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 4,
                });
            },
        );
    });

    it("RV5: seedance-2.5 download failure settles reported output seconds", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/bytedance/seedance-2.5/predictions"))
                return predictionOk(VIDEO_URL, {
                    video_output_duration_seconds: 9,
                });
            if (url.href === VIDEO_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callSeedance25API("a cat", baseParams("bytedance/seedance-2.5")),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 9,
                });
            },
        );
    });

    it("RV6: pruna p-video download failure settles reported output seconds", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/prunaai/p-video/predictions"))
                return predictionOk(VIDEO_URL, {
                    video_output_duration_seconds: 3,
                });
            if (url.href === VIDEO_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callPrunaVideoAPI("a cat", baseParams("prunaai/p-video")),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 3,
                });
            },
        );
    });

    it("RV7: veo:replicate download failure settles requested seconds and audio", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/google/veo-3.1-fast/predictions"))
                // No duration metric: the requested duration is the floor.
                return predictionOk(VIDEO_URL);
            if (url.href === VIDEO_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callVeoReplicateAPI("a cat", {
                    ...baseParams("google/veo-3.1-fast"),
                    duration: 6,
                    audio: true,
                }),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionVideoSeconds: 6,
                    completionAudioSeconds: 6,
                });
            },
        );
    });
});

describe("post-paid failure settlement — Replicate image fleet", () => {
    it("RI1: qwen-image download failure settles the flat per-image charge", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/qwen/qwen-image/predictions"))
                return predictionOk([IMAGE_URL]);
            if (url.href === IMAGE_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callQwenImageAPI("a cat", baseParams("qwen/qwen-image")),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionImageTokens: 1,
                });
            },
        );
    });

    it("RI2: wan-2.7-image download failure settles the flat per-image charge", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/wan-video/wan-2.7-image/predictions"))
                return predictionOk([IMAGE_URL]);
            if (url.href === IMAGE_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callWanImageAPI("a cat", baseParams("alibaba/wan-2.7-image")),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionImageTokens: 1,
                });
            },
        );
    });

    it("RI3: seedream download failure settles the flat per-image charge", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/bytedance/seedream-4/predictions"))
                return predictionOk([IMAGE_URL]);
            if (url.href === IMAGE_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callSeedreamAPI("a cat", baseParams("bytedance/seedream-4.0")),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionImageTokens: 1,
                });
            },
        );
    });

    it("RI4: ideogram download failure settles the flat per-image charge", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/ideogram-ai/ideogram-v4-turbo/predictions"))
                return predictionOk(IMAGE_URL);
            if (url.href === IMAGE_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callIdeogramTurboAPI("a cat", baseParams("ideogram-ai/ideogram-v4-turbo")),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionImageTokens: 1,
                });
            },
        );
    });

    it("RI5: flux.2-pro:replicate download failure settles the metered megapixels", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href === INPUT_IMAGE_URL)
                return new Response(PNG_BYTES, {
                    headers: { "Content-Type": "image/png" },
                });
            if (url.href.endsWith("/models/black-forest-labs/flux-2-pro/predictions"))
                return predictionOk(IMAGE_URL, {
                    image_input_megapixel_count: 2.2,
                    image_output_megapixel_count: 1.05,
                });
            if (url.href === IMAGE_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callReplicateFallbackImage("a cat", {
                    ...baseParams("black-forest-labs/flux.2-pro:replicate"),
                    image: [INPUT_IMAGE_URL],
                }),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    promptImageTokens: 2.2,
                    completionImageTokens: 1.05,
                });
            },
        );
    });

    it("RI6: flux.2-pro:replicate download failure without metrics settles the local estimate", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href === INPUT_IMAGE_URL)
                return new Response(PNG_BYTES, {
                    headers: { "Content-Type": "image/png" },
                });
            if (url.href.endsWith("/models/black-forest-labs/flux-2-pro/predictions"))
                return predictionOk(IMAGE_URL);
            if (url.href === IMAGE_URL) return newResponse500();
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callReplicateFallbackImage("a cat", {
                    ...baseParams("black-forest-labs/flux.2-pro:replicate"),
                    image: [INPUT_IMAGE_URL],
                }),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    // The local fallback math: 1024x1024 output megapixels.
                    completionImageTokens: (1024 * 1024) / 1_000_000,
                });
            },
        );
    });

    it("RI7: DeepInfra no-image with an inference receipt settles the flat image", async () => {
        syncImageEnv(
            {
                REPLICATE_API_TOKEN: "replicate-test-key",
                DEEPINFRA_API_KEY: "deepinfra-test-key",
            } as CloudflareBindings,
            ["REPLICATE_API_TOKEN", "DEEPINFRA_API_KEY"],
        );
        stubFetch((url) => {
            if (url.href === DEEPINFRA_URL)
                return Response.json({
                    images: [],
                    inference_status: { cost: 0.0042, runtime_ms: 1200 },
                });
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callFluxSchnellDeepInfraAPI("a cat", baseParams("black-forest-labs/flux.1-schnell:deepinfra")),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionImageTokens: 1,
                });
            },
        );
    });
});

describe("post-paid failure settlement — correctly-unbilled controls", () => {
    it("RC1: a FAILED prediction stays unbilled (Replicate does not charge failed runs)", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/bytedance/seedance-2.0-mini/predictions"))
                return Response.json({
                    id: "pred-failed",
                    status: "failed",
                    error: "boom",
                });
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callSeedanceV2API("a cat", baseParams("bytedance/seedance-2.0-mini")),
            (billedUsage) => {
                expect(billedUsage).toBeUndefined();
            },
        );
    });

    it("RC2: a succeeded prediction with null output stays unbilled (no billable units)", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/bytedance/seedance-2.0-mini/predictions"))
                return predictionOk(null);
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callSeedanceV2API("a cat", baseParams("bytedance/seedance-2.0-mini")),
            (billedUsage) => {
                expect(billedUsage).toBeUndefined();
            },
        );
    });

    it("RC3: qwen empty output array stays unbilled (no images, no per-image units)", async () => {
        syncImageEnv(
            { REPLICATE_API_TOKEN: "replicate-test-key" } as CloudflareBindings,
            ["REPLICATE_API_TOKEN"],
        );
        stubFetch((url) => {
            if (url.href.endsWith("/models/qwen/qwen-image/predictions"))
                return predictionOk([]);
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callQwenImageAPI("a cat", baseParams("qwen/qwen-image")),
            (billedUsage) => {
                expect(billedUsage).toBeUndefined();
            },
        );
    });

    it("RC4: DeepInfra no-image without an inference receipt stays unbilled", async () => {
        syncImageEnv(
            {
                REPLICATE_API_TOKEN: "replicate-test-key",
                DEEPINFRA_API_KEY: "deepinfra-test-key",
            } as CloudflareBindings,
            ["REPLICATE_API_TOKEN", "DEEPINFRA_API_KEY"],
        );
        stubFetch((url) => {
            if (url.href === DEEPINFRA_URL)
                return Response.json({
                    images: [],
                    inference_status: {},
                });
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () => callFluxSchnellDeepInfraAPI("a cat", baseParams("black-forest-labs/flux.1-schnell:deepinfra")),
            (billedUsage) => {
                expect(billedUsage).toBeUndefined();
            },
        );
    });
});

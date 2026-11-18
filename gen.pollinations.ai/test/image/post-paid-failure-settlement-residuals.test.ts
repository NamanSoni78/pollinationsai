import { UpstreamError } from "@shared/error.ts";
import type { Usage } from "@shared/registry/registry.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncImageEnv } from "../../src/image/env.ts";
import {
    callFalFallbackImage,
    callFalFallbackVideo,
    callMireloSfxAPI,
} from "../../src/image/models/falFallbackMediaModel.ts";
import type { ImageParams } from "../../src/image/params.ts";

// Issue 72's sweep left the fal fallback media model's non-grok legs and the
// Mirelo SFX download as named residuals. Every case below fails AFTER fal
// reported the queue job COMPLETED (fal bills completed jobs), so the caller
// must be settled via error.billedUsage exactly like the 11 clients issue 72
// fixed.

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
        const upstream = error as UpstreamError & { billedUsage?: Usage };
        expect(upstream.status, upstream.message).toBe(status);
        checkBilledUsage(upstream.billedUsage);
    }
}

function json(body: unknown, headers: Record<string, string> = {}) {
    return Response.json(body, {
        headers: { "content-type": "application/json", ...headers },
    });
}

function stubFetch(
    route: (url: URL) => Response | Promise<Response>,
) {
    vi.stubGlobal(
        "fetch",
        ((input: RequestInfo | URL) =>
            route(
                new URL(input instanceof Request ? input.url : String(input)),
            )) as typeof fetch,
    );
}

const STATUS = "https://queue.fal.run/status";
const RESPONSE = "https://queue.fal.run/response";

function queueFor(endpoint: string): Record<string, Response> {
    return {
        [`https://queue.fal.run/${endpoint}`]: json({
            status_url: STATUS,
            response_url: RESPONSE,
        }),
        [STATUS]: json({ status: "COMPLETED" }),
    };
}

function stubQueue(
    endpoint: string,
    responseBody: unknown,
    responseHeaders: Record<string, string> = {},
    extra: Record<string, Response> = {},
) {
    const routes = queueFor(endpoint);
    stubFetch((url) => {
        const hit = routes[url.href] ?? extra[url.href];
        if (hit) return hit;
        if (url.pathname.startsWith("/v1/models/pricing")) {
            const pricing = extra["pricing"];
            if (pricing) return pricing;
        }
        if (url.href === RESPONSE) {
            return json(responseBody, responseHeaders);
        }
        return new Response("unexpected", { status: 404 });
    });
}

// The fal queue poll sleeps 5 s between status checks; resolve immediately.
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

describe("post-paid failure settlement residuals (fal fallback media legs)", () => {
    it("F1: Seedream 5 Lite completed without an image settles the generation", async () => {
        syncImageEnv(
            { FAL_KEY: "fal-test-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubQueue(
            "bytedance/seedream/v5/lite/text-to-image",
            { images: [] },
        );
        await expectBilled(
            () =>
                callFalFallbackImage(
                    "a cat",
                    baseParams("bytedance/seedream-5.0-lite:fal"),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("F2: Seedream 5 Lite edit whose download fails settles the input+output tokens", async () => {
        syncImageEnv(
            { FAL_KEY: "fal-test-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubQueue(
            "bytedance/seedream/v5/lite/edit",
            { images: [{ url: "https://v3.fal.media/files/out.png" }] },
            {},
            { "https://v3.fal.media/files/out.png": new Response("boom", { status: 500 }) },
        );
        await expectBilled(
            () =>
                callFalFallbackImage("a cat", {
                    ...baseParams("bytedance/seedream-5.0-lite:fal"),
                    image: [
                        "https://a.example/1.png",
                        "https://a.example/2.png",
                    ],
                }),
            500,
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    promptImageTokens: 2,
                    completionImageTokens: 1,
                }),
        );
    });

    it("F3: wan-2.6 completed without a video settles the requested seconds", async () => {
        syncImageEnv(
            { FAL_KEY: "fal-test-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubQueue("wan/v2.6/text-to-video", { videos: [] });
        await expectBilled(
            () =>
                callFalFallbackVideo("a dog", baseParams("alibaba/wan-2.6:fal")),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("F4: wan-2.6 start-frame video whose download fails settles seconds + start frame", async () => {
        syncImageEnv(
            { FAL_KEY: "fal-test-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubQueue(
            "wan/v2.6/image-to-video",
            { video: { url: "https://v3.fal.media/files/v.mp4" } },
            {},
            { "https://v3.fal.media/files/v.mp4": new Response("boom", { status: 500 }) },
        );
        await expectBilled(
            () =>
                callFalFallbackVideo("a dog", {
                    ...baseParams("alibaba/wan-2.6:fal"),
                    image: ["https://image.example.com/frame.png"],
                }),
            500,
            (billedUsage) =>
                expect(billedUsage).toEqual({
                    promptImageTokens: 1,
                    completionVideoSeconds: 5,
                }),
        );
    });

    it("F5: heygen completed without a billable-units receipt still settles the requested seconds", async () => {
        syncImageEnv(
            { FAL_KEY: "fal-test-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        // providerPriced: the pricing lookup runs before submission.
        stubQueue("heygen/heygen-video/text-to-video", {}, {}, {
            pricing: json({
                prices: [
                    {
                        endpoint_id: "heygen/heygen-video/text-to-video",
                        unit_price: 0.01,
                        currency: "USD",
                    },
                ],
            }),
        });
        await expectBilled(
            () =>
                callFalFallbackVideo("a dog", baseParams("heygen/heygen-video-1")),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("F6: Mirelo SFX completed whose download fails settles fal's reported seconds", async () => {
        syncImageEnv(
            { FAL_KEY: "fal-test-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubQueue(
            "mirelo-ai/sfx2.0/video-to-video",
            { video: [{ url: "https://v3.fal.media/files/sfx.mp4" }] },
            { "x-fal-billable-units": "3" },
            {
                "https://v3.fal.media/files/sfx.mp4": new Response("boom", { status: 500 }),
                pricing: json({
                    prices: [
                        {
                            endpoint_id: "mirelo-ai/sfx2.0/video-to-video",
                            unit_price: 0.01,
                            currency: "USD",
                        },
                    ],
                }),
            },
        );
        await expectBilled(
            () =>
                callMireloSfxAPI("boom", {
                    ...baseParams("mirelo/sfx-2.0"),
                    reference_videos: ["https://example.com/src.mp4"],
                    duration: 3,
                }),
            500,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 3 }),
        );
    });

    it("F7: grok missing-duration stays with solution14's branch (unbilled here)", async () => {
        syncImageEnv(
            { FAL_KEY: "fal-test-key" } as CloudflareBindings,
            ["FAL_KEY"],
        );
        stubQueue(
            "xai/grok-imagine-video/text-to-video",
            { video: {} },
            { "x-fal-billable-units": "5" },
            {
                pricing: json({
                    prices: [
                        {
                            endpoint_id: "xai/grok-imagine-video/text-to-video",
                            unit_price: 0.01,
                            currency: "USD",
                        },
                    ],
                }),
            },
        );
        try {
            await callFalFallbackVideo(
                "a dog",
                baseParams("x-ai/grok-imagine-video:fal"),
            );
            expect.unreachable("expected the call to throw");
        } catch (error) {
            // The missing-duration site is issue 25/solution14's unmerged
            // fix; this branch deliberately does not settle it so the two
            // fixes compose without duplication.
            expect(error).toBeInstanceOf(UpstreamError);
            const upstream = error as UpstreamError & {
                billedUsage?: Usage;
            };
            expect(upstream.status).toBe(502);
            expect(upstream.billedUsage).toBeUndefined();
        }
    });
});

import { UpstreamError } from "@shared/error.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSoniloSfx } from "../../src/audio/sonilo.ts";
import { syncImageEnv } from "../../src/image/env.ts";
import { callFalFallbackVideo } from "../../src/image/models/falFallbackMediaModel.ts";
import { callKlingVideoAPI } from "../../src/image/models/klingVideoModel.ts";
import { callMinimaxH3API } from "../../src/image/models/minimaxH3Model.ts";
import type { ImageParams } from "../../src/image/params.ts";

const STATUS_URL = "https://queue.fal.run/status/abc";
const RESULT_URL = "https://queue.fal.run/resp/abc";
const VIDEO_URL = "https://fal.media/out.mp4";

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

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

let route: Route = () => {
    throw new Error("no route configured");
};

function json(body: unknown, headers: Record<string, string> = {}) {
    return Response.json(body, {
        headers: { "content-type": "application/json", ...headers },
    });
}

function queueRoute(
    opts: {
        status?: unknown;
        resultBody?: unknown;
        resultHeaders?: Record<string, string>;
    } = {},
): Route {
    return (url, init) => {
        if (init?.method === "POST") {
            return json({ status_url: STATUS_URL, response_url: RESULT_URL });
        }
        if (url.pathname.endsWith("/status/abc")) {
            return json(opts.status ?? { status: "COMPLETED" });
        }
        return json(opts.resultBody ?? {}, {
            "x-fal-billable-units": "6.2",
            ...(opts.resultHeaders ?? {}),
        });
    };
}

function pricingRoute(endpointId: string, unitPrice: number): Route {
    return (url, init) => {
        if (url.hostname === "api.fal.ai") {
            return json({
                prices: [
                    {
                        endpoint_id: endpointId,
                        unit_price: unitPrice,
                        currency: "USD",
                        unit: "seconds",
                    },
                ],
            });
        }
        return queueRoute({ resultBody: { video: { url: VIDEO_URL } } })(
            url,
            init,
        );
    };
}

const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;

function stubFetchWith(next: Route) {
    route = next;
    vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) =>
        route(
            new URL(input instanceof Request ? input.url : String(input)),
            init,
        )) as typeof fetch);
}

beforeEach(() => {
    syncImageEnv({ FAL_KEY: "test-fal-key" } as CloudflareBindings, [
        "FAL_KEY",
    ]);
    // Poll sleeps resolve immediately.
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
        fn: () => void,
        _ms?: number,
    ) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout =
        realSetTimeout;
    route = () => {
        throw new Error("no route configured");
    };
});

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

describe("fal-queue post-paid failures carry billedUsage", () => {
    it("S1: MiniMax H3 poll timeout bills the requested duration", async () => {
        let jumped = false;
        vi.spyOn(Date, "now").mockImplementation(() =>
            jumped ? realNow() + 11 * 60_000 : realNow(),
        );
        stubFetchWith((url, init) => {
            const response = queueRoute({
                status: { status: "IN_PROGRESS" },
            })(url, init);
            if (url.pathname.endsWith("/status/abc")) jumped = true;
            return response;
        });
        await expectBilled(
            () => callMinimaxH3API("a dog", baseParams("minimax/minimax-h3")),
            504,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("S2: MiniMax H3 completed without a video bills the requested duration", async () => {
        stubFetchWith(queueRoute({ resultBody: { videos: [] } }));
        await expectBilled(
            () => callMinimaxH3API("a dog", baseParams("minimax/minimax-h3")),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("S2b control: MiniMax H3 success still bills via trackingData", async () => {
        stubFetchWith((url, init) => {
            if (url.href === VIDEO_URL) {
                return new Response("fake-mp4-bytes", {
                    headers: { "content-type": "video/mp4" },
                });
            }
            return queueRoute({
                resultBody: { video: { url: VIDEO_URL } },
            })(url, init);
        });
        const result = await callMinimaxH3API(
            "a dog",
            baseParams("minimax/minimax-h3"),
        );
        expect(result.trackingData.usage).toEqual({
            completionVideoSeconds: 5,
        });
    });

    it("S3: Kling completed without a video bills the computed seconds", async () => {
        stubFetchWith(queueRoute({ resultBody: {} }));
        await expectBilled(
            () =>
                callKlingVideoAPI(
                    "a dog",
                    baseParams("kwaivgi/kling-v3.0-std"),
                ),
            502,
            (billedUsage) => {
                const seconds = (
                    billedUsage as { completionVideoSeconds?: number }
                )?.completionVideoSeconds;
                expect(typeof seconds).toBe("number");
                expect(seconds ?? 0).toBeGreaterThan(0);
            },
        );
    });

    it("S4: grok:fal missing output duration bills the requested duration", async () => {
        stubFetchWith(
            pricingRoute("xai/grok-imagine-video/text-to-video", 0.14),
        );
        await expectBilled(
            () =>
                callFalFallbackVideo(
                    "a dog",
                    baseParams("x-ai/grok-imagine-video:fal"),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("C4 control: grok:fal moderation rejection still bills (unchanged)", async () => {
        stubFetchWith((url, init) => {
            if (url.hostname === "api.fal.ai") {
                return json({
                    prices: [
                        {
                            endpoint_id: "xai/grok-imagine-video/text-to-video",
                            unit_price: 0.14,
                            currency: "USD",
                            unit: "seconds",
                        },
                    ],
                });
            }
            if (init?.method === "POST") {
                return new Response(
                    JSON.stringify({
                        detail: [
                            {
                                type: "content_policy_violation",
                                input: { duration: 5 },
                            },
                        ],
                    }),
                    {
                        status: 422,
                        headers: { "content-type": "application/json" },
                    },
                );
            }
            return json({});
        });
        await expectBilled(
            () =>
                callFalFallbackVideo(
                    "a dog",
                    baseParams("x-ai/grok-imagine-video:fal"),
                ),
            422,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionVideoSeconds: 5 }),
        );
    });

    it("S5: Sonilo completed without audio bills the reported units", async () => {
        stubFetchWith(pricingRoute("sonilo/v1.1/video-to-sound-effects", 0.05));
        await expectBilled(
            () =>
                generateSoniloSfx({
                    prompt: "whoosh",
                    referenceVideo: "https://example.com/v.mp4",
                    responseFormat: "mp3",
                    falKey: "test-fal-key",
                }),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionAudioSeconds: 6.2 }),
        );
    });
});

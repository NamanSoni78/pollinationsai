import { UpstreamError } from "@shared/error.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateLyria35 } from "../../src/audio/lyria.ts";
import { generateSoniloSfx } from "../../src/audio/sonilo.ts";

// The audio fleet's post-paid failure legs: fal bills a queue job the
// moment it reports COMPLETED (and Google charges the completed Lyria
// generation), so every failure after those events must settle the caller
// via error.billedUsage — mirroring the image/model3d clients issues
// 25/72/75 already fixed. Sonilo's no-audio site stays with solution14's
// unmerged branch so the fixes compose.

const SONILO_QUEUE = "https://queue.fal.run/sonilo/v1.1/video-to-sound-effects";
const LYRIA_QUEUE = "https://queue.fal.run/google/lyria-3.5";
const STATUS_URL = "https://queue.fal.run/status";
const RESPONSE_URL = "https://queue.fal.run/response";
const AUDIO_URL = "https://v3.fal.media/audio.mp3";

const realSetTimeout = globalThis.setTimeout;

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

function json(body: unknown, headers: Record<string, string> = {}) {
    return Response.json(body, {
        headers: { "content-type": "application/json", ...headers },
    });
}

function stubFetch(route: (url: URL) => Response | Promise<Response>) {
    vi.spyOn(globalThis, "fetch").mockImplementation(
        ((input: RequestInfo | URL) =>
            route(
                new URL(input instanceof Request ? input.url : String(input)),
            )) as unknown as typeof fetch,
    );
}

/** Queue stub: submit → COMPLETED → result body with a units receipt. */
function stubFalQueue(
    submitUrl: string,
    responseBody: unknown,
    receiptUnits: string | null,
    extra: Record<string, Response> = {},
) {
    stubFetch((url) => {
        const hit = extra[url.href];
        if (hit) return hit;
        if (url.pathname.startsWith("/v1/models/pricing")) {
            const pricing = extra["pricing"];
            if (pricing) return pricing;
        }
        if (url.href === submitUrl) {
            return json({ status_url: STATUS_URL, response_url: RESPONSE_URL });
        }
        if (url.href === STATUS_URL) return json({ status: "COMPLETED" });
        if (url.href === RESPONSE_URL) {
            return json(
                responseBody,
                receiptUnits === null
                    ? {}
                    : { "x-fal-billable-units": receiptUnits },
            );
        }
        return new Response("unexpected", { status: 404 });
    });
}

// The fal queue poll sleeps 5 s before its first status check.
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
});

describe("audio post-paid failure settlement", () => {
    it("S1: Sonilo whose download fails settles fal's reported seconds", async () => {
        stubFalQueue(
            SONILO_QUEUE,
            { audio: { url: AUDIO_URL } },
            "4",
            {
                pricing: json({
                    prices: [
                        {
                            endpoint_id: "sonilo/v1.1/video-to-sound-effects",
                            unit_price: 0.01,
                            currency: "USD",
                        },
                    ],
                }),
                [AUDIO_URL]: new Response("boom", { status: 500 }),
            },
        );
        await expectBilled(
            () =>
                generateSoniloSfx({
                    prompt: "whoosh",
                    referenceVideo: "https://example.com/src.mp4",
                    responseFormat: "mp3",
                    falKey: "fal-test-key",
                }),
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionAudioSeconds: 4 }),
        );
    });

    it("S2: Sonilo oversized output still settles the reported seconds", async () => {
        // readResponseBytes trips its cap on the declared total.
        stubFalQueue(
            SONILO_QUEUE,
            { audio: { url: AUDIO_URL } },
            "4",
            {
                pricing: json({
                    prices: [
                        {
                            endpoint_id: "sonilo/v1.1/video-to-sound-effects",
                            unit_price: 0.01,
                            currency: "USD",
                        },
                    ],
                }),
                [AUDIO_URL]: new Response(new Uint8Array(0), {
                    headers: { "content-length": String(70 * 1024 * 1024) },
                }),
            },
        );
        await expectBilled(
            () =>
                generateSoniloSfx({
                    prompt: "whoosh",
                    referenceVideo: "https://example.com/src.mp4",
                    responseFormat: "mp3",
                    falKey: "fal-test-key",
                }),
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionAudioSeconds: 4 }),
        );
    });

    it("L1: Lyria fal completed without audio settles the reported units", async () => {
        stubFalQueue(LYRIA_QUEUE, {}, "4");
        await expectBilled(
            () =>
                generateLyria35({
                    model: "google/lyria-3.5:fal",
                    prompt: "a chill loop",
                    responseFormat: "mp3",
                    falKey: "fal-test-key",
                }),
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionAudioTokens: 4 }),
        );
    });

    it("L2: Lyria fal whose download fails settles the reported units", async () => {
        stubFalQueue(LYRIA_QUEUE, { audio: { url: AUDIO_URL } }, "4", {
            [AUDIO_URL]: new Response("boom", { status: 500 }),
        });
        await expectBilled(
            () =>
                generateLyria35({
                    model: "google/lyria-3.5:fal",
                    prompt: "a chill loop",
                    responseFormat: "mp3",
                    falKey: "fal-test-key",
                }),
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionAudioTokens: 4 }),
        );
    });

    it("L3: Lyria fal empty audio still settles the reported units", async () => {
        stubFalQueue(LYRIA_QUEUE, { audio: { url: AUDIO_URL } }, "4", {
            [AUDIO_URL]: new Response(new Uint8Array(0), {
                headers: { "content-type": "audio/mpeg" },
            }),
        });
        await expectBilled(
            () =>
                generateLyria35({
                    model: "google/lyria-3.5:fal",
                    prompt: "a chill loop",
                    responseFormat: "mp3",
                    falKey: "fal-test-key",
                }),
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionAudioTokens: 4 }),
        );
    });

    it("L4: Lyria google completed with empty audio data stays unbilled (payment not provable)", async () => {
        stubFetch((url) => {
            if (url.href === "https://generativelanguage.googleapis.com/v1beta/interactions") {
                return json({
                    status: "completed",
                    steps: [
                        {
                            content: [
                                {
                                    type: "audio",
                                    mime_type: "audio/mpeg",
                                    data: "",
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
                generateLyria35({
                    model: "google/lyria-3.5",
                    prompt: "a chill loop",
                    responseFormat: "mp3",
                    geminiApiKey: "google-test-key",
                }),
            (billedUsage) => expect(billedUsage).toBeUndefined(),
        );
    });
});

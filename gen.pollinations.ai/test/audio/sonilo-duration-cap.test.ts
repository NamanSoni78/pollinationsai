/**
 * Sonilo SFX `reference_video` billed-seconds cap (issue 59).
 *
 * `generateSoniloSfx` forwards the caller's `reference_video` URL to fal's
 * `sonilo/v1.1/video-to-sound-effects`; fal bills the video's OWN seconds at
 * its live price (`x-fal-billable-units` x `falUnitPrice`). The worker never
 * fetches the video and nothing bounded its duration: a 1-hour video billed
 * ~$32.40 (verified red on unpatched main) while a $0.51 balance passed the
 * Tinybird-mean preflight. fal's OpenAPI declares no max duration/size.
 *
 * The fix declares the audio-family convention cap (380 s) on the registry
 * entry and enforces it after the job: a video whose fal-reported units
 * exceed the cap is refused 413 and the caller settles exactly what fal
 * billed (issue-25 `billedUsage` pattern) — no output is delivered.
 */
import {
    getRegistryModelDefinition,
    calculateUsageBilling,
} from "@shared/registry/registry.ts";
import { AUDIO_SERVICES } from "@shared/registry/audio.ts";
import {
    parseUsageHeaders,
    createCompletionAudioSecondsUsage,
} from "@shared/registry/usage-headers.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSoniloSfx, SONILO_MODEL } from "../../src/audio/sonilo.ts";

/** fal's live unit price for the endpoint (registry mirrors it). */
const UNIT_PRICE = 0.009;
/** A 1-hour reference video: fal reports its seconds as billable units. */
const ONE_HOUR_UNITS = 3600;

function mockFalUnits(units: number, unitPrice = UNIT_PRICE) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const href = String(url);
        if (href.startsWith("https://api.fal.ai/v1/models/pricing"))
            return Response.json({
                prices: [
                    {
                        endpoint_id: "sonilo/v1.1/video-to-sound-effects",
                        unit_price: unitPrice,
                        currency: "USD",
                    },
                ],
            });
        if (href === "https://queue.fal.run/sonilo/v1.1/video-to-sound-effects")
            return Response.json({
                status_url: "https://queue.fal.run/status",
                response_url: "https://queue.fal.run/result",
            });
        if (href === "https://queue.fal.run/status")
            return Response.json({ status: "COMPLETED" });
        if (href === "https://queue.fal.run/result")
            return Response.json(
                { audio: { url: "https://fal.media/sfx.mp3" } },
                { headers: { "x-fal-billable-units": String(units) } },
            );
        return new Response("ID3sfx", {
            headers: { "content-type": "audio/mpeg" },
        });
    });
}

describe("Sonilo reference_video billed seconds are capped at 380 s", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("registry declares a duration bound for the per-second sonilo charge", () => {
        const definition = getRegistryModelDefinition(SONILO_MODEL);
        // No request parameter bounds the billed video seconds; the registry
        // must express the audio-family cap so the bound is published in
        // /audio/models and available to estimators.
        expect(definition.maxDuration ?? definition.allowedDurations).toBeDefined();
    });

    it("a 1-hour video is refused 413 and settles exactly what fal billed", async () => {
        vi.useFakeTimers();
        mockFalUnits(ONE_HOUR_UNITS);

        const pending = generateSoniloSfx({
            prompt: "fire crackling, soft whoosh",
            referenceVideo: "https://example.com/one-hour-clip.mp4",
            responseFormat: "mp3",
            falKey: "test-fal",
        });
        await vi.advanceTimersByTimeAsync(5000);
        const outcome = await pending.then(
            (response) => ({ status: response.status }),
            (error) => ({
                status: error.status,
                billedUsage: error.billedUsage,
            }),
        );
        expect(outcome).toMatchObject({
            status: 413,
            // fal already billed the 3600 seconds; the caller pays them
            // (issue-25 billedUsage pattern) but no output is delivered.
            billedUsage: createCompletionAudioSecondsUsage(ONE_HOUR_UNITS),
        });

        // Magnitude for the record: what the platform owes fal for this job
        // (verified $32.40 on unpatched main).
        const billed = calculateUsageBilling({
            model: SONILO_MODEL,
            usage: createCompletionAudioSecondsUsage(ONE_HOUR_UNITS),
            servedBy: AUDIO_SERVICES[SONILO_MODEL],
            input: { providerBilling: { units: ONE_HOUR_UNITS, unitCost: UNIT_PRICE } },
        });
        expect(billed.price.totalPrice).toBeCloseTo(32.4, 9);
    });

    it("control: a 12-second video still succeeds and bills exactly", async () => {
        vi.useFakeTimers();
        mockFalUnits(12);
        const pending = generateSoniloSfx({
            prompt: "fire crackling, soft whoosh",
            referenceVideo: "https://example.com/clip.mp4",
            responseFormat: "mp3",
            falKey: "test-fal",
        });
        await vi.advanceTimersByTimeAsync(5000);
        const response = await pending;
        expect(response.status).toBe(200);
        expect(parseUsageHeaders(response.headers)).toMatchObject({
            completionAudioSeconds: 12,
        });
    });
});

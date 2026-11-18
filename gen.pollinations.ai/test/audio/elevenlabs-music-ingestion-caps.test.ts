/**
 * ElevenLabs Music ingestion + composition_plan caps (issue 60).
 *
 * Unpatched main gated `reference_audio` only by bytes (20 MB): 20 MB at
 * 32 kbps is ~5,242 s of provider-billed ingestion ($0.0025/s => ~$13.18 per
 * request, verified red) while preflight used the Tinybird mean. The upload
 * response's reference duration was parsed but only used for settlement
 * headers. Caller `composition_plan` (z.unknown()) bypassed the 3-300 s
 * output-duration contract that `resolveAudioDuration` enforces on the
 * plain-prompt path.
 *
 * The fix: references longer than the model's maxDuration (300 s) are
 * refused 413 with `billedUsage` for the already-billed ingestion
 * (issue-25 pattern) before the generation leg is dispatched; caller
 * composition plans are validated pre-dispatch (every chunk must declare
 * duration_ms or a time range; totals must stay within 300 s); and
 * `music_length_ms` is defensively clamped.
 */
import {
    getRegistryModelDefinition,
    calculateUsageBilling,
} from "@shared/registry/registry.ts";
import { AUDIO_SERVICES } from "@shared/registry/audio.ts";
import { parseUsageHeaders } from "@shared/registry/usage-headers.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    generateMusic,
    resolveAudioDuration,
} from "../../src/routes/audio.ts";

const MUSIC_MODELS = ["elevenlabs/music-v2", "elevenlabs/music-v2.5"] as const;
const PROMPT_AUDIO_RATE = 0.0025;
/** 20 MB at 32 kbps = 4,000 B/s of billable ingestion. */
const TWENTY_MB_BYTES = 20 * 1024 * 1024;
const INGESTION_SECONDS_AT_32KBPS = TWENTY_MB_BYTES / 4000; // 5,242.88 s

const log = { info: vi.fn(), warn: vi.fn() } as never;

/** Upload plan chunks whose durations sum to `milliseconds`. */
function planChunksTotaling(milliseconds: number) {
    // Provider-realistic shapes: per-chunk duration_ms <= 120,000 ms.
    const chunks: { duration_ms: number }[] = [];
    let remaining = milliseconds;
    while (remaining > 0) {
        const take = Math.min(120_000, remaining);
        chunks.push({ duration_ms: take });
        remaining -= take;
    }
    return chunks;
}

function mockElevenLabs(ingestionMs: number, outputSeconds = 30) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input, init) => {
            const request = new Request(input, init);
            if (request.url.endsWith("/v1/music/upload")) {
                return Response.json({
                    song_id: "reference-song",
                    composition_plan: {
                        chunks: planChunksTotaling(ingestionMs),
                    },
                });
            }
            // 192 kbps CBR MP3 = 24,000 B/s (the worker's own constant).
            return new Response(
                new Uint8Array(outputSeconds * 24_000),
                { headers: { "content-type": "audio/mpeg" } },
            );
        },
    );
}

describe("ElevenLabs Music ingestion is capped by seconds and plans validated", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it.each(MUSIC_MODELS)(
        "refuses a %s reference longer than the model's max duration (20 MB @ 32 kbps = %.2f s)",
        async (modelName) => {
            expect(INGESTION_SECONDS_AT_32KBPS).toBeCloseTo(5242.88, 2);
            const referenceBytes = new Uint8Array(TWENTY_MB_BYTES);
            const fetchMock = mockElevenLabs(
                Math.round(INGESTION_SECONDS_AT_32KBPS * 1000),
            );

            await expect(
                generateMusic({
                    modelName,
                    prompt: "warm indie disco",
                    durationSeconds: 30,
                    referenceAudio: new File([referenceBytes], "reference.mp3", {
                        type: "audio/mpeg",
                    }),
                    apiKey: "test-eleven-key",
                    log,
                }),
            ).rejects.toMatchObject({
                status: 413,
                // The upload already billed 5,242.88 s of ingestion; the
                // caller pays it (issue-25 billedUsage pattern).
                billedUsage: { promptAudioSeconds: INGESTION_SECONDS_AT_32KBPS },
            });
            // The generation leg must not run after an over-cap reference.
            expect(
                fetchMock.mock.calls.some(
                    ([url]) => String(url) === "https://api.elevenlabs.io/v1/music",
                ),
            ).toBe(false);

            // Magnitude for the record: ingestion + 30 s of output.
            const billed = calculateUsageBilling({
                model: modelName,
                usage: {
                    promptAudioSeconds: INGESTION_SECONDS_AT_32KBPS,
                    completionAudioSeconds: 30,
                },
                servedBy: AUDIO_SERVICES[modelName],
            });
            expect(billed.price.totalPrice).toBeCloseTo(
                (INGESTION_SECONDS_AT_32KBPS + 30) * PROMPT_AUDIO_RATE,
                5,
            );
            expect(billed.price.totalPrice).toBeGreaterThan(13);
        },
    );

    it.each(MUSIC_MODELS)(
        "control: a 30 s %s reference still succeeds and bills its ingestion",
        async (modelName) => {
            mockElevenLabs(30_000, 30);
            const response = await generateMusic({
                modelName,
                prompt: "warm indie disco",
                durationSeconds: 30,
                referenceAudio: new File(["reference"], "reference.mp3", {
                    type: "audio/mpeg",
                }),
                apiKey: "test-eleven-key",
                log,
            });
            expect(response.status).toBe(200);
            expect(parseUsageHeaders(response.headers)).toMatchObject({
                promptAudioSeconds: 30,
                completionAudioSeconds: 30,
            });
        },
    );

    it("plain path control: duration 500 s is refused by resolveAudioDuration", () => {
        const definition = getRegistryModelDefinition("elevenlabs/music-v2");
        expect(() =>
            resolveAudioDuration("elevenlabs/music-v2", definition, 500),
        ).toThrow(/Unsupported duration/);
    });

    it.each([
        {
            label: "single 600 s chunk (exceeds per-chunk and total)",
            plan: { chunks: [{ text: "[Verse]", duration_ms: 600_000 }] },
        },
        {
            label: "doc-compliant chunks totaling 400 s (aggregate gap)",
            plan: {
                chunks: [
                    { text: "[Verse]", duration_ms: 100_000 },
                    { text: "[Chorus]", duration_ms: 100_000 },
                    { text: "[Bridge]", duration_ms: 100_000 },
                    { text: "[Outro]", duration_ms: 100_000 },
                ],
            },
        },
    ])(
        "refuses a composition_plan whose total exceeds max duration: $label",
        async ({ plan }) => {
            const fetchMock = vi
                .spyOn(globalThis, "fetch")
                .mockResolvedValue(
                    new Response(new Uint8Array(30 * 24_000), {
                        headers: { "content-type": "audio/mpeg" },
                    }),
                );

            await expect(
                generateMusic({
                    modelName: "elevenlabs/music-v2",
                    prompt: "unused when composition_plan is provided",
                    compositionPlan: plan,
                    apiKey: "test-eleven-key",
                    log,
                }),
            ).rejects.toMatchObject({ status: 400 });
            // Refused before dispatch: nothing paid is sent upstream.
            expect(fetchMock).not.toHaveBeenCalled();
        },
    );

    it("control: a 30 s inpainting plan (keep-chunks) still passes", async () => {
        const fetchMock = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(
                new Response(new Uint8Array(30 * 24_000), {
                    headers: { "content-type": "audio/mpeg" },
                }),
            );
        // The exact plan shape pinned by test/elevenmusic-v2.test.ts.
        const compositionPlan = {
            chunks: [
                { song_id: "source-song", range: { start_ms: 0, end_ms: 10_000 } },
                {
                    text: "[Chorus]\nReplace this with brighter drums",
                    duration_ms: 8000,
                    positive_styles: ["bright drums", "same tempo"],
                    conditioning_ref: {
                        song_id: "source-song",
                        range: { start_ms: 10_000, end_ms: 18_000 },
                    },
                },
                { song_id: "source-song", range: { start_ms: 18_000, end_ms: 30_000 } },
            ],
        };
        const response = await generateMusic({
            modelName: "elevenlabs/music-v2",
            prompt: "unused when composition_plan is provided",
            compositionPlan,
            storeForInpainting: true,
            apiKey: "test-eleven-key",
            log,
        });
        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

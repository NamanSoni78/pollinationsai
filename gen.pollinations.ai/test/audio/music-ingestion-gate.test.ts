import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from "cloudflare:test";
import { getUserBalance } from "@shared/billing/balance.ts";
import { AUDIO_SERVICES } from "@shared/registry/audio.ts";
import {
    calculateUsageBilling,
    getRegistryModelDefinition,
} from "@shared/registry/registry.ts";
import { createTestApiKey } from "@shared/test/fixtures/index.ts";
import {
    createFetchMock,
    teardownFetchMock,
} from "@shared/test/mocks/fetch.ts";
import { createMockTinybird } from "@shared/test/mocks/tinybird.ts";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { stemInputSeconds } from "../../src/audio/stem-separation.ts";
import {
    requireMusicFunds,
    validatedMusicPlanSeconds,
} from "../../src/routes/audio.ts";
import worker from "../../src/index.ts";
import fixture from "../fixtures/music-ref.json";
import { withInlineGenerationCoordinator } from "../helpers/inline-generation-coordinator.ts";

// One second of 32 kbps silence, no Xing header: concatenating the frame
// buffer scales the parsed duration linearly, so the in-memory references
// below reach the byte-capped worst case (20 MB of low-bitrate audio) without
// a multi-megabyte fixture.
const baseBytes = () =>
    Uint8Array.from(atob(fixture.mp3), (c) => c.charCodeAt(0));

function referenceBytes(repeat: number) {
    const base = baseBytes();
    const bytes = new Uint8Array(base.length * repeat);
    for (let i = 0; i < repeat; i++) bytes.set(base, i * base.length);
    return bytes;
}

function referenceFile(repeat: number) {
    return new File([referenceBytes(repeat)], "reference.mp3", {
        type: "audio/mpeg",
    });
}

const MUSIC_MODEL = "elevenlabs/music-v2";
const UPLOAD_URL = "https://api.elevenlabs.io/v1/music/upload";
const GENERATE_URL = "https://api.elevenlabs.io/v1/music";
const REFERENCE_URL = "https://refs.example.com/music.mp3";

// 24,000 bytes read back as one second of MP3 by the response estimator.
const oneSecondMp3 = new Uint8Array(24_000).fill(0xff);

function fakeLog() {
    return {
        trace: () => undefined,
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
    };
}

afterEach(teardownFetchMock);
beforeEach(async () => {
    await createFetchMock({ tinybird: createMockTinybird() }).enable(
        "tinybird",
    );
});

async function musicRequest(
    key: string,
    body: Record<string, unknown>,
): Promise<{ response: Response; text: string }> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
        new Request("https://gen.pollinations.ai/v1/audio/speech", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ model: MUSIC_MODEL, input: "a song", ...body }),
        }),
        withInlineGenerationCoordinator({
            ...env,
            ELEVENLABS_API_KEY: "test",
        }),
        ctx,
    );
    const text = await response.text();
    await waitOnExecutionContext(ctx);
    return { response, text };
}

function mockElevenLabs(referenceMs: number) {
    const calls: string[] = [];
    return {
        calls,
        mocks: createFetchMock({
            tinybird: createMockTinybird(),
            elevenlabs: {
                state: {},
                reset() {},
                handlerMap: {
                    "api.elevenlabs.io": async (request) => {
                        calls.push(request.url);
                        if (request.url === UPLOAD_URL)
                            return Response.json({
                                song_id: "song-1",
                                composition_plan: {
                                    chunks: [{ duration_ms: referenceMs }],
                                },
                            });
                        if (request.url === GENERATE_URL)
                            return new Response(oneSecondMp3, {
                                headers: {
                                    "content-type": "audio/mpeg",
                                    "song-id": "song-2",
                                },
                            });
                        return new Response("unexpected", { status: 500 });
                    },
                },
            },
            refs: {
                state: {},
                reset() {},
                handlerMap: {
                    "refs.example.com": async (request) =>
                        new Response(
                            request.url.endsWith("short.mp3")
                                ? (referenceBytes(1) as unknown as BodyInit)
                                : (referenceBytes(600) as unknown as BodyInit),
                            { headers: { "content-type": "audio/mpeg" } },
                        ),
                },
            },
        }),
    };
}

describe("composition_plan contract", () => {
    const definition = AUDIO_SERVICES[MUSIC_MODEL];

    it("accepts a plan inside the model's duration range", () => {
        expect(
            validatedMusicPlanSeconds(
                { chunks: [{ duration_ms: 30_000 }] },
                definition,
            ),
        ).toBe(30);
        expect(
            validatedMusicPlanSeconds(
                {
                    chunks: [
                        { duration_ms: 150_000 },
                        { duration_ms: 150_000 },
                    ],
                },
                definition,
            ),
        ).toBe(300);
    });

    it("rejects a plan total outside the model's duration range", () => {
        // 60 minutes of chunks: the duration parameter is capped at 3-300 s,
        // but the plan replaced it upstream (music_length_ms is unsent).
        expect(() =>
            validatedMusicPlanSeconds(
                { chunks: [{ duration_ms: 3_600_000 }] },
                definition,
            ),
        ).toThrow("Unsupported duration for composition_plan: 3600");
    });

    it("rejects malformed plans", () => {
        for (const plan of [
            {},
            { chunks: [] },
            { chunks: [{}] },
            { chunks: [{ duration_ms: 0 }] },
            { chunks: [{ duration_ms: "30" }] },
        ]) {
            expect(() =>
                validatedMusicPlanSeconds(plan, definition),
            ).toThrow(expect.objectContaining({ status: 400 }));
        }
    });
});

const exactCharge = (referenceSeconds: number, outputSeconds = 0) =>
    calculateUsageBilling({
        model: MUSIC_MODEL,
        usage: {
            promptAudioSeconds: referenceSeconds,
            completionAudioSeconds: outputSeconds,
        },
        servedBy: getRegistryModelDefinition(MUSIC_MODEL),
    }).price.totalPrice;

function musicContext(packBalance: number, apiKey?: unknown) {
    return {
        var: {
            auth: {
                user: { id: "music-payer" },
                apiKey,
            },
            balance: {
                getBalance: async () => ({
                    tierBalance: 0,
                    packBalance,
                }),
            },
            model: {
                requested: MUSIC_MODEL,
                resolved: MUSIC_MODEL,
                definition: getRegistryModelDefinition(MUSIC_MODEL),
            },
            log: fakeLog(),
        },
        env: {},
    } as unknown as Parameters<typeof requireMusicFunds>[0];
}

describe("music ingestion funds gate", () => {
    it("prices the byte-capped worst case: 20 MB at 32 kbps", () => {
        // 20 MB / 4 kB/s = 5,242 billed ingestion seconds at $0.0025/s.
        expect(exactCharge(5_242)).toBeCloseTo(5_242 * 0.0025, 8);
        // Ingestion plus a full 300 s output on the same request.
        expect(exactCharge(5_242, 300)).toBeCloseTo((5_242 + 300) * 0.0025, 8);
    });

    it("meters the decoded reference before dispatch", async () => {
        // 600 repeats of the one-second fixture parse to ~646 s: the
        // byte-capped fetch (20 MB) admits thousands of billed seconds.
        const long = await stemInputSeconds(referenceFile(600));
        expect(long).toBeGreaterThan(600);
        expect(long).toBeLessThan(650);
        expect(await stemInputSeconds(referenceFile(1))).toBeCloseTo(
            1.0710204081632653,
            3,
        );
    });

    it("refuses a balance below the exact charge", async () => {
        // 700 s of ingestion costs $1.75: the mean-based estimate
        // (no Tinybird history: $0.0025) admitted any positive balance.
        await expect(
            requireMusicFunds(
                musicContext(1.5),
                MUSIC_MODEL,
                AUDIO_SERVICES[MUSIC_MODEL],
                700,
                undefined,
            ),
        ).rejects.toMatchObject({ status: 402 });
    });

    it("admits a balance covering ingestion plus the plan's output", async () => {
        await expect(
            requireMusicFunds(
                musicContext(3),
                MUSIC_MODEL,
                AUDIO_SERVICES[MUSIC_MODEL],
                700,
                300,
            ),
        ).resolves.toBeUndefined();
    });

    it("refuses through the key budget first", async () => {
        await expect(
            requireMusicFunds(
                musicContext(100, { id: "sk-music", pollenBalance: 0.5 }),
                MUSIC_MODEL,
                AUDIO_SERVICES[MUSIC_MODEL],
                600,
                300,
            ),
        ).rejects.toMatchObject({ status: 402 });
    });

    it("skips the gate when the caller is not authenticated", async () => {
        const anonymous = {
            var: {
                auth: {},
                balance: {
                    getBalance: async () => {
                        throw new Error("must not load balance");
                    },
                },
                model: {
                    requested: MUSIC_MODEL,
                    resolved: MUSIC_MODEL,
                    definition: getRegistryModelDefinition(MUSIC_MODEL),
                },
                log: fakeLog(),
            },
            env: {},
        } as unknown as Parameters<typeof requireMusicFunds>[0];
        await expect(
            requireMusicFunds(
                anonymous,
                MUSIC_MODEL,
                AUDIO_SERVICES[MUSIC_MODEL],
                5_242,
                300,
            ),
        ).resolves.toBeUndefined();
    });
});

describe("music route", () => {
    it("refuses a byte-capped long reference before ElevenLabs sees it", async () => {
        // 600 repeats ~ 646 s of audio inside the 20 MB fetch cap (~2.6 MB):
        // pre-fix the mean estimate admitted it and the upload was dispatched.
        const { calls, mocks } = mockElevenLabs(642_612);
        await mocks.enable("elevenlabs", "tinybird", "refs");
        const { key } = await createTestApiKey({
            user: { packBalance: 1 },
            allowedModels: [MUSIC_MODEL],
        });
        const { response } = await musicRequest(key, {
            reference_audio: REFERENCE_URL,
        });
        expect(response.status).toBe(402);
        expect(calls).toHaveLength(0);
    });

    it("uploads an affordable reference and bills its seconds", async () => {
        const { calls, mocks } = mockElevenLabs(1_071);
        await mocks.enable("elevenlabs", "tinybird", "refs");
        const { key, userId } = await createTestApiKey({
            user: { packBalance: 1 },
            allowedModels: [MUSIC_MODEL],
        });
        const { response } = await musicRequest(key, {
            reference_audio: REFERENCE_URL.replace("music.mp3", "short.mp3"),
        });
        expect(response.status).toBe(200);
        expect(calls).toEqual([UPLOAD_URL, GENERATE_URL]);
        // Ingestion seconds plus one second of generated output, at
        // $0.0025/s each.
        const balance = await getUserBalance(drizzle(env.DB), userId);
        expect(balance.packBalance).toBeCloseTo(
            1 - (1.0710204081632653 + 1) * 0.0025,
            6,
        );
    });

    it("rejects a composition_plan total beyond the model's range", async () => {
        const { calls, mocks } = mockElevenLabs(0);
        await mocks.enable("elevenlabs", "tinybird");
        const { key } = await createTestApiKey({
            user: { packBalance: 5 },
            allowedModels: [MUSIC_MODEL],
        });
        const { response, text } = await musicRequest(key, {
            composition_plan: {
                chunks: [
                    {
                        text: "a song",
                        duration_ms: 3_600_000,
                        positive_styles: ["great production quality"],
                    },
                ],
            },
        });
        expect(response.status).toBe(400);
        expect(text.includes("Unsupported duration for composition_plan")).toBe(
            true,
        );
        expect(calls).toHaveLength(0);
    });

    it("forwards a plan inside the range and gates on its total", async () => {
        const calls: string[] = [];
        let generateBody: Record<string, unknown> = {};
        const mocks = createFetchMock({
            tinybird: createMockTinybird(),
            elevenlabs: {
                state: {},
                reset() {},
                handlerMap: {
                    "api.elevenlabs.io": async (request) => {
                        calls.push(request.url);
                        if (request.url === GENERATE_URL) {
                            generateBody = (await request.json()) as Record<
                                string,
                                unknown
                            >;
                            return new Response(oneSecondMp3, {
                                headers: { "content-type": "audio/mpeg" },
                            });
                        }
                        return new Response("unexpected", { status: 500 });
                    },
                },
            },
        });
        await mocks.enable("elevenlabs", "tinybird");
        const { key, userId } = await createTestApiKey({
            user: { packBalance: 0.06 },
            allowedModels: [MUSIC_MODEL],
        });
        const { response } = await musicRequest(key, {
            composition_plan: {
                chunks: [
                    { text: "a song", duration_ms: 10_000 },
                    { text: "a chorus", duration_ms: 10_000 },
                ],
            },
        });
        expect(response.status).toBe(200);
        expect(calls).toEqual([GENERATE_URL]);
        expect(generateBody.composition_plan).toEqual({
            chunks: [
                { text: "a song", duration_ms: 10_000 },
                { text: "a chorus", duration_ms: 10_000 },
            ],
        });
        // The gate saw 20 s of output ($0.05); the settlement bills the
        // one second the mock returned.
        const balance = await getUserBalance(drizzle(env.DB), userId);
        expect(balance.packBalance).toBeCloseTo(0.06 - 1 * 0.0025, 6);
    });
});

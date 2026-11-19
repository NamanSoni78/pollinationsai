import { afterEach, describe, expect, it, vi } from "vitest";
import {
    changeVoiceWithElevenLabs,
    generateElevenLabsDialogue,
    generateElevenLabsSpeech,
    generateElevenLabsSpeechWithTimestamps,
    generateMusic,
    generateSoundEffect,
    isolateVoiceWithElevenLabs,
} from "../../src/routes/audio.ts";

const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
} as never;

afterEach(() => {
    vi.restoreAllMocks();
});

/**
 * Every api.elevenlabs.io fetch in this file must carry a 300 s deadline:
 * on unpatched main none of them does, so a silent model server pins the
 * request (and its generation slot) indefinitely.
 */
describe("ElevenLabs speech fetch deadlines (issue 124 family)", () => {
    function elevenLabsCalls(fetchMock: ReturnType<typeof vi.fn>) {
        return fetchMock.mock.calls.filter(([url]) =>
            String(url).includes("api.elevenlabs.io"),
        );
    }

    function mockProvider(json = false) {
        // A fresh Response per call: a shared instance would have its body
        // locked by the first consumer.
        return vi.fn().mockImplementation((url: unknown) =>
            Promise.resolve(
                json || String(url).includes("/music/upload")
                    ? new Response(
                          JSON.stringify({
                              song_id: "song-test",
                              composition_plan: { chunks: [{ duration_ms: 30000 }] },
                          }),
                          { headers: { "content-type": "application/json" } },
                      )
                    : new Response(new Uint8Array([1, 2, 3, 4]), {
                          headers: { "content-type": "audio/mpeg" },
                      }),
            ),
        );
    }

    it("generateElevenLabsSpeech passes a deadline", async () => {
        const fetchMock = mockProvider();
        vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
        await generateElevenLabsSpeech({
            modelName: "elevenlabs/eleven-v3",
            text: "hello",
            voice: "nova",
            responseFormat: "mp3",
            apiKey: "test-key",
            log,
        }).catch(() => {});
        const calls = elevenLabsCalls(fetchMock as ReturnType<typeof vi.fn>);
        expect(calls).toHaveLength(1);
        expect((calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it("generateElevenLabsSpeechWithTimestamps passes a deadline", async () => {
        const fetchMock = mockProvider();
        vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
        await generateElevenLabsSpeechWithTimestamps({
            modelName: "elevenlabs/eleven-flash-v2.5",
            text: "hello",
            voice: "nova",
            responseFormat: "mp3",
            apiKey: "test-key",
            log,
        }).catch(() => {});
        const calls = elevenLabsCalls(fetchMock as ReturnType<typeof vi.fn>);
        expect(calls).toHaveLength(1);
        expect((calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it("generateElevenLabsDialogue passes a deadline", async () => {
        const fetchMock = mockProvider();
        vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
        await generateElevenLabsDialogue({
            inputs: [{ text: "Hello.", voice: "nova" }],
            responseFormat: "mp3",
            apiKey: "test-key",
            log,
        }).catch(() => {});
        const calls = elevenLabsCalls(fetchMock as ReturnType<typeof vi.fn>);
        expect(calls).toHaveLength(1);
        expect((calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it("changeVoiceWithElevenLabs passes a deadline", async () => {
        const fetchMock = mockProvider();
        vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
        await changeVoiceWithElevenLabs({
            audio: new File([new Uint8Array([1, 2, 3])], "input.mp4", {
                type: "audio/mp4",
            }),
            voice: "nova",
            responseFormat: "mp3",
            apiKey: "test-key",
            log,
        }).catch(() => {});
        const calls = elevenLabsCalls(fetchMock as ReturnType<typeof vi.fn>);
        expect(calls).toHaveLength(1);
        expect((calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it("isolateVoiceWithElevenLabs passes a deadline", async () => {
        const fetchMock = mockProvider();
        vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
        await isolateVoiceWithElevenLabs({
            audio: new File([new Uint8Array([1, 2, 3])], "input.mp4", {
                type: "audio/mp4",
            }),
            apiKey: "test-key",
            log,
        }).catch(() => {});
        const calls = elevenLabsCalls(fetchMock as ReturnType<typeof vi.fn>);
        expect(calls).toHaveLength(1);
        expect((calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });

    it("generateMusic passes deadlines on the reference upload and the synthesis", async () => {
        const fetchMock = mockProvider();
        vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
        await generateMusic({
            modelName: "elevenlabs/music-v2",
            prompt: "upbeat synth pop",
            referenceAudio: new File(["reference"], "reference.mp3", {
                type: "audio/mpeg",
            }),
            apiKey: "test-key",
            log,
        }).catch(() => {});
        const calls = elevenLabsCalls(fetchMock as ReturnType<typeof vi.fn>);
        // The music-upload leg (v1/music/upload) plus the synthesis leg
        // (v1/music) — both must carry the deadline.
        expect(calls).toHaveLength(2);
        for (const call of calls) {
            expect((call[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
        }
    });

    it("generateSoundEffect passes a deadline on the direct leg", async () => {
        const fetchMock = mockProvider();
        vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
        await generateSoundEffect({
            modelName: "elevenlabs/eleven-text-to-sound-v3",
            prompt: "a door creak",
            apiKey: "test-key",
            log,
        }).catch(() => {});
        const calls = elevenLabsCalls(fetchMock as ReturnType<typeof vi.fn>);
        expect(calls).toHaveLength(1);
        expect((calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });
});

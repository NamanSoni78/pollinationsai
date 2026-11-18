import { afterEach, describe, expect, it, vi } from "vitest";
import {
    generateQwenTts,
    generateSoundEffect,
    generateStableAudio3Large,
    generateStableAudio3Medium,
} from "../../src/routes/audio.ts";

const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
} as never;

const MAX_BYTES = 64 * 1024 * 1024;
const OVERSIZED = String(MAX_BYTES + 1);

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/**
 * Dispatches fetch mocks by URL. The `artifact` handler serves the
 * provider-returned output URL; every other URL maps to a fal/Stability/
 * DashScope leg of the flow under test.
 */
function mockFetch(artifact: () => Response, legs: Record<string, () => Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const href = String(url);
        for (const [prefix, handler] of Object.entries(legs)) {
            if (href === prefix || href.startsWith(`${prefix}?`)) {
                return handler();
            }
        }
        return artifact();
    });
}

const falQueueLegs = {
    // fal queue submit → status → result chain shared by the fal-backed flows.
    "https://queue.fal.run/elevenlabs/sound-effects/v3": () =>
        Response.json({
            status_url: "https://queue.fal.run/sfx-status",
            response_url: "https://queue.fal.run/sfx-result",
        }),
    "https://queue.fal.run/fal-ai/stable-audio-3/medium/text-to-audio": () =>
        Response.json({
            status_url: "https://queue.fal.run/sa3m-status",
            response_url: "https://queue.fal.run/sa3m-result",
        }),
    "https://queue.fal.run/sfx-status": () =>
        Response.json({ status: "COMPLETED" }),
    "https://queue.fal.run/sa3m-status": () =>
        Response.json({ status: "COMPLETED" }),
    "https://queue.fal.run/sfx-result": () =>
        Response.json(
            { audio: { url: "https://fal.media/sfx.mp3" } },
            { headers: { "x-fal-billable-units": "2" } },
        ),
    "https://queue.fal.run/sa3m-result": () =>
        Response.json({ audio: { url: "https://fal.media/sa3m.mp3" } }),
};

describe("audio artifact download caps (issue 110)", () => {
    it("rejects an oversized fal sound-effects artifact", async () => {
        vi.useFakeTimers();
        mockFetch(
            () =>
                new Response("ID3", {
                    headers: { "content-length": OVERSIZED },
                }),
            falQueueLegs,
        );
        const pending = generateSoundEffect({
            modelName: "elevenlabs/eleven-text-to-sound-v3:fal",
            prompt: "a door closes",
            durationSeconds: 1,
            apiKey: "test-eleven",
            falKey: "test-fal",
            log,
        });
        const assertion = expect(pending).rejects.toMatchObject({
            status: 502,
            message: expect.stringContaining("too large"),
        });
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
    });

    it("passes an abort deadline to the fal sound-effects artifact fetch", async () => {
        vi.useFakeTimers();
        const fetchSpy = mockFetch(
            () => new Response("ID3audio", { headers: { "content-type": "audio/mpeg" } }),
            falQueueLegs,
        );
        const pending = generateSoundEffect({
            modelName: "elevenlabs/eleven-text-to-sound-v3:fal",
            prompt: "a door closes",
            apiKey: "test-eleven",
            falKey: "test-fal",
            log,
        });
        await vi.advanceTimersByTimeAsync(5000);
        const response = await pending;
        expect(await response.text()).toBe("ID3audio");
        const artifactCall = fetchSpy.mock.calls.find(
            ([url]) => String(url) === "https://fal.media/sfx.mp3",
        );
        expect(artifactCall).toBeDefined();
        expect(artifactCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it("rejects an oversized Qwen TTS artifact", async () => {
        mockFetch(
            () =>
                new Response("WAV", {
                    headers: { "content-length": OVERSIZED },
                }),
            {
                "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation":
                    () =>
                        Response.json({
                            output: {
                                audio: { url: "https://oss.example.com/out.wav" },
                            },
                            usage: { characters: 5 },
                        }),
            },
        );
        await expect(
            generateQwenTts({
                modelName: "qwen/qwen3-tts-flash",
                text: "hello there",
                voice: "alloy",
                apiKey: "test-dashscope",
                log,
            }),
        ).rejects.toMatchObject({
            status: 502,
            message: expect.stringContaining("too large"),
        });
    });

    it("rejects an oversized Stable Audio 3 Medium artifact", async () => {
        vi.useFakeTimers();
        mockFetch(
            () =>
                new Response("ID3", {
                    headers: { "content-length": OVERSIZED },
                }),
            falQueueLegs,
        );
        const pending = generateStableAudio3Medium({
            prompt: "ambient pad",
            seconds: 3,
            falKey: "test-fal",
            log,
        });
        const assertion = expect(pending).rejects.toMatchObject({
            status: 502,
            message: expect.stringContaining("too large"),
        });
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
    });

    it("rejects an oversized Stable Audio 3 Large result body", async () => {
        vi.useFakeTimers();
        let polls = 0;
        mockFetch(
            () => new Response("x", { status: 500 }),
            {
                "https://api.stability.ai/v2beta/audio/stable-audio/text-to-audio":
                    () => new Response(JSON.stringify({ id: "gen-123" }), { status: 202 }),
                "https://api.stability.ai/v2beta/results/gen-123": () => {
                    polls += 1;
                    if (polls === 1) return new Response(null, { status: 202 });
                    return new Response("x", {
                        status: 200,
                        headers: { "content-length": OVERSIZED },
                    });
                },
            },
        );
        const pending = generateStableAudio3Large({
            prompt: "orchestral swell",
            responseFormat: "mp3",
            apiKey: "test-stability",
            log,
        });
        const assertion = expect(pending).rejects.toMatchObject({
            status: 502,
            message: expect.stringContaining("too large"),
        });
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
    });

    it("still returns a small Stable Audio 3 Large result", async () => {
        vi.useFakeTimers();
        let polls = 0;
        mockFetch(() => new Response("x", { status: 500 }), {
            "https://api.stability.ai/v2beta/audio/stable-audio/text-to-audio":
                () => new Response(JSON.stringify({ id: "gen-456" }), { status: 202 }),
            "https://api.stability.ai/v2beta/results/gen-456": () => {
                polls += 1;
                if (polls === 1) return new Response(null, { status: 202 });
                return new Response("ID3audio", {
                    status: 200,
                    headers: { "content-type": "audio/mpeg" },
                });
            },
        });
        const pending = generateStableAudio3Large({
            prompt: "orchestral swell",
            responseFormat: "mp3",
            apiKey: "test-stability",
            log,
        });
        await vi.advanceTimersByTimeAsync(5000);
        const response = await pending;
        expect(await response.text()).toBe("ID3audio");
        expect(
            response.headers.get("x-usage-completion-audio-tokens"),
        ).toBe("1");
    });
});

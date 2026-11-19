import { UpstreamError } from "@shared/error.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateLyria35 } from "../../src/audio/lyria.ts";
import {
    generateGeminiSpeech,
    generateMaiSpeech,
} from "../../src/routes/audio.ts";

const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
} as never;

const TOO_LARGE = String(64 * 1024 * 1024 + 1);

afterEach(() => {
    vi.restoreAllMocks();
});

async function rejectionOf(promise: Promise<unknown>): Promise<UpstreamError> {
    try {
        await promise;
    } catch (error) {
        return error as UpstreamError;
    }
    throw new Error("expected the call to reject");
}

const maiGatewayOptions = {
    modelName: "microsoft/mai-voice-2.1",
    routeId: "microsoft/mai-voice-2.1:vercel",
    provider: "vercel",
    text: "hello",
    voice: "alloy",
    responseFormat: "mp3",
    apiKey: "test-gateway-key",
    log,
} as const;

describe("MAI speech gateway: inline-JSON cap, settle, deadline", () => {
    it("rejects a runaway response through the byte cap, not as a schema failure", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("{}", { headers: { "content-length": TOO_LARGE } }),
        );
        const error = await rejectionOf(generateMaiSpeech(maiGatewayOptions));
        expect(error.status).toBe(502);
        expect(error.message).toMatch(/too large/);
    });

    it("surfaces malformed JSON as a clean 502 that settles the input characters", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("not-json"),
        );
        const error = await rejectionOf(generateMaiSpeech(maiGatewayOptions));
        expect(error).toBeInstanceOf(UpstreamError);
        expect(error.status).toBe(502);
        expect(error.message).toMatch(/invalid JSON/);
        // The provider already synthesized and billed the 5-character input.
        expect(error.billedUsage).toMatchObject({ completionAudioTokens: 5 });
    });

    it("settles the input characters when the gateway schema fails", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            // Valid audio, but no providerMetadata gateway receipt.
            new Response(JSON.stringify({ audio: "AQID" })),
        );
        const error = await rejectionOf(generateMaiSpeech(maiGatewayOptions));
        expect(error.status).toBe(502);
        expect(error.billedUsage).toMatchObject({ completionAudioTokens: 5 });
    });

    it("accepts a legitimate zero-cost read instead of discarding the synthesis", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                JSON.stringify({
                    audio: "AQID",
                    usage: { inputCharacters: 5 },
                    providerMetadata: { gateway: { cost: 0 } },
                }),
            ),
        );
        const response = await generateMaiSpeech(maiGatewayOptions);
        expect(response.status).toBe(200);
        expect(response.headers.get("x-usage-provider-billable-units")).toBe(
            "0",
        );
    });

    it("passes an upstream deadline to the fetch", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response("not-json"));
        await rejectionOf(generateMaiSpeech(maiGatewayOptions));
        const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
});

describe("Gemini TTS direct: inline-JSON cap and deadline", () => {
    const geminiOptions = {
        modelName: "google/gemini-3.8-flash-tts" as const,
        text: "hello",
        voice: "alloy",
        responseFormat: "pcm",
        apiKey: "test-key",
        log,
    } as const;

    it("surfaces malformed JSON as a clean 502, not a raw SyntaxError", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("not-json"),
        );
        const error = await rejectionOf(
            generateGeminiSpeech(geminiOptions),
        );
        expect(error).toBeInstanceOf(UpstreamError);
        expect(error.status).toBe(502);
        expect(error.message).toMatch(/invalid JSON/);
    });

    it("rejects a runaway response through the byte cap", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("{}", { headers: { "content-length": TOO_LARGE } }),
        );
        const error = await rejectionOf(
            generateGeminiSpeech(geminiOptions),
        );
        expect(error.status).toBe(502);
        expect(error.message).toMatch(/too large/);
    });

    it("passes an upstream deadline to the fetch", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response("not-json"));
        await rejectionOf(generateGeminiSpeech(geminiOptions));
        const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
});

describe("Lyria direct: inline-JSON cap, settle, deadline", () => {
    const lyriaOptions = {
        model: "google/lyria-3.5",
        prompt: "A short folk song",
        responseFormat: "mp3",
        geminiApiKey: "test-gemini",
        falKey: "test-fal",
    } as const;

    it("surfaces malformed JSON as a clean 502, not a raw SyntaxError", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response("not-json"),
        );
        const error = await rejectionOf(generateLyria35(lyriaOptions));
        expect(error).toBeInstanceOf(UpstreamError);
        expect(error.status).toBe(502);
        expect(error.message).toMatch(/invalid JSON/);
    });

    it("settles the song when the provider completed but the audio block is malformed", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: "completed",
                    steps: [{ content: [{ type: "text", text: "Verse" }] }],
                }),
            ),
        );
        const error = await rejectionOf(generateLyria35(lyriaOptions));
        expect(error.status).toBe(502);
        // Google charges one song per completed interaction.
        expect(error.billedUsage).toMatchObject({ completionAudioTokens: 1 });
    });

    it("does not settle when the provider did not report completion", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: "failed",
                    steps: [],
                }),
            ),
        );
        const error = await rejectionOf(generateLyria35(lyriaOptions));
        expect(error.status).toBe(502);
        expect(error.billedUsage).toBeUndefined();
    });

    it("passes an upstream deadline to the fetch", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response("not-json"));
        await rejectionOf(generateLyria35(lyriaOptions));
        const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
});

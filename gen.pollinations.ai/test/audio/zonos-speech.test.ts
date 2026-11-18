import { AUDIO_SERVICES } from "@shared/registry/audio.ts";
import { calculatePrice } from "@shared/registry/registry.ts";
import { createAudioTokenUsage } from "@shared/registry/usage-headers.ts";
import { expect, it, vi } from "vitest";
import { generateZonosSpeech } from "../../src/routes/zonos-speech.ts";

const model = "zyphra/zonos3-mini";

it("limits ZONOS speech to the paid POST endpoint and meters input bytes", () => {
    const definition = AUDIO_SERVICES[model];
    expect(definition.paidOnly).toBe(true);
    expect(definition.supportedEndpoints).toEqual(["/v1/audio/speech"]);
    expect(definition.priceUnits.completionAudioTokens.unit).toBe("byte");
    const usage = createAudioTokenUsage(
        new TextEncoder().encode("Café").length,
    );
    expect(usage.completionAudioTokens).toBe(5);
    expect(calculatePrice(model, usage).totalPrice).toBeCloseTo(0.000025, 10);
});

it("rejects unsupported encodings and reports an unbound backend as unavailable", async () => {
    await expect(
        generateZonosSpeech(undefined, "Hello", "alloy", "wav"),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
        generateZonosSpeech(undefined, "Hello", "alloy", "pcm"),
    ).rejects.toMatchObject({ status: 503 });
});

it("bounds the tunnel fetch with a first-byte deadline", async () => {
    vi.useFakeTimers();
    try {
        let capturedSignal: AbortSignal | undefined;
        const binding = {
            // A GPU service that accepts the request but never sends the
            // first audio byte (headers): without a deadline this fetch —
            // and the worker request — hang until the client gives up.
            fetch: async (_url: unknown, init?: RequestInit) => {
                capturedSignal = init?.signal as AbortSignal | undefined;
                return new Promise<Response>((_resolve, reject) => {
                    capturedSignal?.addEventListener("abort", () =>
                        reject(new DOMException("Aborted", "AbortError")),
                    );
                });
            },
        };
        const pending = generateZonosSpeech(
            binding as unknown as Fetcher,
            "Hello",
            "alloy",
            "mp3",
        );
        // The tunnel fetch must carry a deadline signal at all.
        expect(capturedSignal).toBeInstanceOf(AbortSignal);
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(pending).rejects.toMatchObject({ status: 504 });
    } finally {
        vi.useRealTimers();
    }
});

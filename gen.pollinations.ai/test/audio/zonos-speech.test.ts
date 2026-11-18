import { AUDIO_SERVICES } from "@shared/registry/audio.ts";
import { calculatePrice } from "@shared/registry/registry.ts";
import { createAudioTokenUsage } from "@shared/registry/usage-headers.ts";
import { expect, it } from "vitest";
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

it("sends the GPU backend token on the tunnel request", async () => {
    const calls: { url: string; headers: Headers; body: string }[] = [];
    const binding = {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({
                url: String(url),
                headers: new Headers(init?.headers),
                body: String(init?.body),
            });
            return new Response(new Uint8Array([0xff, 0xfb]), {
                status: 200,
                headers: { "content-type": "audio/mpeg" },
            });
        },
    };
    const response = await generateZonosSpeech(
        binding as unknown as Fetcher,
        "Hello",
        "alloy",
        "mp3",
        "test-backend-token",
    );
    // Every sibling GPU service (flux, dreamshaper, klein) authenticates the
    // worker with this header; the zonos service must not be the outlier.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:1920/speech");
    expect(calls[0].headers.get("x-backend-token")).toBe("test-backend-token");
    expect(JSON.parse(calls[0].body)).toEqual({
        text: "Hello",
        format: "mp3",
    });
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
});

it("omits the backend token header when no token is configured", async () => {
    const calls: Headers[] = [];
    const binding = {
        fetch: async (_url: string | URL | Request, init?: RequestInit) => {
            calls.push(new Headers(init?.headers));
            return new Response(new Uint8Array([0xff]), { status: 200 });
        },
    };
    await generateZonosSpeech(
        binding as unknown as Fetcher,
        "Hello",
        "alloy",
        "mp3",
        undefined,
    );
    expect(calls[0].get("x-backend-token")).toBeNull();
    expect(calls[0].get("content-type")).toBe("application/json");
});

import { ensureUpstreamOk, UpstreamError } from "@shared/error.ts";
import {
    buildUsageHeaders,
    createAudioTokenUsage,
} from "@shared/registry/usage-headers.ts";

/**
 * The GPU service writes response headers with the first encoded audio byte,
 * so a deadline on the tunnel fetch bounds time-to-first-byte. After that the
 * body streams until completion, bounded by the service's own watchdog and
 * the caller's disconnect (which propagates through the tunnel).
 */
const ZONOS_FIRST_BYTE_TIMEOUT_MS = 60_000;

export async function generateZonosSpeech(
    binding: Fetcher | undefined,
    text: string,
    voice: string,
    format: string,
): Promise<Response> {
    if (voice !== "alloy" || (format !== "mp3" && format !== "pcm")) {
        throw new UpstreamError(400, {
            message:
                "ZONOS3-Mini supports the alloy preset and mp3 or pcm output.",
        });
    }
    if (!binding) {
        throw new UpstreamError(503, {
            message: "ZONOS3-Mini is unavailable.",
        });
    }

    const endpoint = "http://127.0.0.1:1920/speech";
    const deadline = new AbortController();
    const timer = setTimeout(
        () => deadline.abort(),
        ZONOS_FIRST_BYTE_TIMEOUT_MS,
    );
    let response: Response;
    try {
        response = await ensureUpstreamOk(
            await binding.fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, format }),
                signal: deadline.signal,
            }),
            endpoint,
        );
    } catch (error) {
        if (deadline.signal.aborted) {
            throw new UpstreamError(504, {
                message: `ZONOS3-Mini did not start speaking within ${ZONOS_FIRST_BYTE_TIMEOUT_MS / 1000} seconds.`,
            });
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
    const bytes = new TextEncoder().encode(text).byteLength;
    return new Response(response.body, {
        headers: {
            "Content-Type": format === "pcm" ? "audio/pcm" : "audio/mpeg",
            ...buildUsageHeaders(
                "zyphra/zonos3-mini",
                createAudioTokenUsage(bytes),
            ),
            "x-tts-voice": voice,
        },
    });
}

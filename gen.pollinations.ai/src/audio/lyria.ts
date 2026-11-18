import { ensureUpstreamOk, UpstreamError } from "@shared/error.ts";
import { AUDIO_SERVICES } from "@shared/registry/audio.ts";
import { buildUsageHeaders } from "@shared/registry/usage-headers.ts";
import { readResponseBytes } from "@shared/response-bytes.ts";
import { falBillableUnits } from "../image/utils/falBillableUnits.ts";
import { fetchUpstream } from "../image/utils/fetchUpstream.ts";
import { runFalJobResponse } from "../model3d/models/falClient.ts";
import { toUpstreamError } from "../model3d/modelUtils.ts";

type LyriaModel = "google/lyria-3.5" | "google/lyria-3.5:fal";

// Lyria songs are a few MB of MP3; 64 MiB mirrors sonilo's cap and keeps a
// runaway fal-storage response from buffering the whole isolate.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
// Audio-fleet artifact downloads use a bounded wait; 60 s matches the 3D
// fleet's mesh download deadline (solution88's convention).
const LYRIA_DOWNLOAD_TIMEOUT_MS = 60 * 1_000;

export async function generateLyria35(opts: {
    model: LyriaModel;
    prompt: string;
    responseFormat: string;
    durationSeconds?: number;
    referenceAudio?: File;
    geminiApiKey?: string;
    falKey?: string;
}): Promise<Response> {
    if (opts.responseFormat !== "mp3") {
        throw new UpstreamError(400, {
            message: "google/lyria-3.5 supports mp3 output only.",
        });
    }
    if (opts.durationSeconds !== undefined) {
        throw new UpstreamError(400, {
            message:
                "google/lyria-3.5 does not support duration; describe the approximate song length in the prompt.",
        });
    }
    if (opts.referenceAudio) {
        throw new UpstreamError(400, {
            message: "google/lyria-3.5 accepts text prompts only.",
        });
    }

    let bytes: Uint8Array<ArrayBuffer> | ArrayBuffer;
    let units: number;
    if (AUDIO_SERVICES[opts.model].provider === "fal") {
        if (!opts.falKey) {
            throw new UpstreamError(500, {
                message: "Lyria fallback is not configured",
            });
        }
        const result = await runFalJobResponse(
            { endpoint: "google/lyria-3.5", input: { prompt: opts.prompt } },
            opts.falKey,
        ).catch((error) => {
            throw toUpstreamError(error);
        });
        units = falBillableUnits(result);
        const data = (await result.json()) as { audio?: { url?: string } };
        if (!data.audio?.url) {
            throw new UpstreamError(502, {
                message: "Lyria returned no audio output",
            });
        }
        const audio = await fetchUpstream(data.audio.url, {
            errorLabel: "Failed to download Lyria output",
            signal: AbortSignal.timeout(LYRIA_DOWNLOAD_TIMEOUT_MS),
        });
        bytes = await readResponseBytes(audio, MAX_OUTPUT_BYTES, (total) =>
            UpstreamError.fromProvider(502, {
                message: `Lyria output is too large: ${total} bytes (max ${MAX_OUTPUT_BYTES})`,
            }),
        );
    } else {
        if (!opts.geminiApiKey) {
            throw new UpstreamError(500, {
                message: "Lyria is not configured",
            });
        }
        const endpoint =
            "https://generativelanguage.googleapis.com/v1beta/interactions";
        const response = await ensureUpstreamOk(
            await fetch(endpoint, {
                method: "POST",
                headers: {
                    "x-goog-api-key": opts.geminiApiKey,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model: "lyria-3.5",
                    input: [{ type: "text", text: opts.prompt }],
                }),
            }),
            endpoint,
        );
        const data = (await response.json()) as {
            status?: string;
            steps?: Array<{
                content?: Array<{
                    type?: string;
                    mime_type?: string;
                    data?: string;
                }>;
            }>;
        };
        const audio = data.steps
            ?.flatMap((step) => step.content ?? [])
            .find(
                (block) =>
                    block.type === "audio" &&
                    block.mime_type === "audio/mpeg" &&
                    typeof block.data === "string",
            );
        if (data.status !== "completed" || !audio?.data) {
            throw new UpstreamError(502, {
                message: "Lyria returned no completed MP3 audio output",
            });
        }
        bytes = Uint8Array.from(atob(audio.data), (char) =>
            char.charCodeAt(0),
        ).buffer;
        // Google charges one song; the response's text/token counts are bundled,
        // not separately billable tokens. No song quantity is reported upstream.
        units = 1;
    }
    if (!bytes.byteLength) {
        throw new UpstreamError(502, { message: "Lyria returned empty audio" });
    }
    return new Response(bytes, {
        headers: {
            "Content-Type": "audio/mpeg",
            ...buildUsageHeaders(opts.model, { completionAudioTokens: units }),
        },
    });
}

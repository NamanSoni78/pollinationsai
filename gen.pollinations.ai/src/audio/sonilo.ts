import { UpstreamError } from "@shared/error.ts";
import {
    buildUsageHeaders,
    createCompletionAudioSecondsUsage,
    PROVIDER_BILLING_HEADERS,
} from "@shared/registry/usage-headers.ts";
import { readResponseBytes } from "@shared/response-bytes.ts";
import { validateUserMediaUrl } from "@shared/user-media-url.ts";
import {
    falBillableUnits,
    falUnitPrice,
} from "../image/utils/falBillableUnits.ts";
import { fetchUpstream } from "../image/utils/fetchUpstream.ts";
import { runFalJobResponse } from "../model3d/models/falClient.ts";
import { toUpstreamError } from "../model3d/modelUtils.ts";

export const SONILO_MODEL = "sonilo/sonilo-1.1-sfx";
const ENDPOINT = "sonilo/v1.1/video-to-sound-effects";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** Audio-family convention cap on the reference video's billed seconds. */
const SONILO_MAX_VIDEO_SECONDS = 380;

/**
 * Sonilo returns sound effects timed to the whole `reference_video` as one
 * MP3 track. fal bills the video's seconds at its live price.
 */
export async function generateSoniloSfx(opts: {
    prompt: string;
    referenceVideo?: string;
    responseFormat: string;
    falKey?: string;
}): Promise<Response> {
    if (!opts.referenceVideo) {
        throw new UpstreamError(400, {
            message: `${SONILO_MODEL} needs reference_video: the video to add sound effects to.`,
        });
    }
    if (!validateUserMediaUrl(opts.referenceVideo).ok) {
        throw new UpstreamError(400, {
            message:
                "reference_video must be a public HTTP(S) URL without credentials",
        });
    }
    if (opts.responseFormat !== "mp3") {
        throw new UpstreamError(400, {
            message: `${SONILO_MODEL} supports mp3 output only.`,
        });
    }
    if (!opts.falKey) {
        throw new UpstreamError(500, { message: "Sonilo is not configured" });
    }

    let unitCost: number;
    let response: Response;
    try {
        unitCost = await falUnitPrice(ENDPOINT, opts.falKey);
        response = await runFalJobResponse(
            {
                endpoint: ENDPOINT,
                input: {
                    video_url: opts.referenceVideo,
                    prompt: opts.prompt,
                    audio_format: "mp3",
                },
            },
            opts.falKey,
        );
    } catch (error) {
        throw toUpstreamError(error);
    }
    const units = falBillableUnits(response);
    if (units > SONILO_MAX_VIDEO_SECONDS) {
        // fal already billed the video's seconds; settle the caller's
        // charge (issue-25 billedUsage pattern) but deliver no output.
        throw new UpstreamError(413, {
            message: `${SONILO_MODEL} reference_video is too long: fal billed ${units}s (max ${SONILO_MAX_VIDEO_SECONDS}s)`,
            billedUsage: createCompletionAudioSecondsUsage(units),
        });
    }
    const data = (await response.json()) as { audio?: { url?: string } };
    if (!data.audio?.url) {
        throw new UpstreamError(502, {
            message: "Sonilo returned no audio output",
        });
    }
    const audio = await fetchUpstream(data.audio.url, {
        errorLabel: `Failed to download ${SONILO_MODEL} output`,
    });
    const bytes = await readResponseBytes(audio, MAX_OUTPUT_BYTES, (total) =>
        UpstreamError.fromProvider(502, {
            message: `${SONILO_MODEL} output is too large: ${total} bytes (max ${MAX_OUTPUT_BYTES})`,
        }),
    );
    return new Response(bytes, {
        headers: {
            "Content-Type": "audio/mpeg",
            ...buildUsageHeaders(
                SONILO_MODEL,
                createCompletionAudioSecondsUsage(units),
            ),
            [PROVIDER_BILLING_HEADERS.units]: String(units),
            [PROVIDER_BILLING_HEADERS.unitCost]: String(unitCost),
        },
    });
}

import { UpstreamError } from "@shared/error.ts";
import type { VideoGenerationResult } from "../createAndReturnVideos.ts";
import type { ImageParams } from "../params.ts";
import { fetchUpstream } from "../utils/fetchUpstream.ts";
import {
    runReplicatePrediction,
    toReplicateUpstreamError,
} from "../utils/replicateClient.ts";
import { resolveGrokAspectRatio } from "./openRouterVideoModel.ts";

export async function callGrokReplicateVideoAPI(
    prompt: string,
    params: ImageParams,
): Promise<VideoGenerationResult> {
    const input = {
        prompt,
        duration: params.duration ?? 5,
        resolution: "720p",
        aspect_ratio: resolveGrokAspectRatio(params),
        ...(params.seed === undefined ? {} : { seed: params.seed }),
        ...(params.image[0] ? { image: params.image[0] } : {}),
    };
    try {
        const result = await runReplicatePrediction<typeof input, string>({
            model: "xai/grok-imagine-video",
            input,
            // Replicate's documented platform prediction limit.
            predictionDeadlineMinutes: 30,
        });
        const seconds = result.videoOutputDurationSeconds;
        if (
            typeof seconds !== "number" ||
            !Number.isFinite(seconds) ||
            seconds <= 0
        ) {
            throw UpstreamError.fromProvider(502, {
                message:
                    "Replicate Grok response is missing output video duration",
                // The prediction succeeded, so Replicate billed it; bill
                // the requested duration the success path falls back to.
                billedUsage: {
                    ...(params.image[0] ? { promptImageTokens: 1 } : {}),
                    completionVideoSeconds: params.duration ?? 5,
                },
            });
        }
        const response = await fetchUpstream(result.output, {
            errorLabel: "Failed to download Grok video",
        }).catch((error: unknown) => {
            // The video is generated and billed; a failed download must
            // still settle it.
            throw Object.assign(error as object, {
                billedUsage: {
                    ...(params.image[0] ? { promptImageTokens: 1 } : {}),
                    completionVideoSeconds: seconds,
                },
            });
        });
        return {
            buffer: Buffer.from(await response.arrayBuffer()),
            mimeType: "video/mp4",
            durationSeconds: seconds,
            trackingData: {
                actualModel: params.model,
                usage: {
                    ...(params.image[0] ? { promptImageTokens: 1 } : {}),
                    completionVideoSeconds: seconds,
                },
            },
        };
    } catch (error) {
        throw toReplicateUpstreamError(error, "Grok video generation failed");
    }
}

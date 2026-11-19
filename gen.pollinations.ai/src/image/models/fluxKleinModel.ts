import { detectImageMimeType } from "@shared/image-mime.ts";
import { UpstreamError } from "@shared/error.ts";
import debug from "debug";
import type { ImageGenerationResult } from "../createAndReturnImages.ts";
import { getImageEnv } from "../env.ts";
import type { ImageParams } from "../params.ts";
import { fetchUpstream } from "../utils/fetchUpstream.ts";
import {
    base64ToBuffer,
    downloadUserImage,
    readImageDimensions,
} from "../utils/imageDownload.ts";

const logOps = debug("pollinations:flux-klein:ops");
const logError = debug("pollinations:flux-klein:error");

let kleinVpc: Fetcher | undefined;

export function setKleinVpcBinding(binding: Fetcher | undefined): void {
    kleinVpc = binding;
}

// Production uses the private Vast tunnel; other environments retain KLEIN_URL.
const getKleinGenerateUrl = (): string => {
    if (kleinVpc) {
        return "http://127.0.0.1:8000/generate";
    }
    const url = getImageEnv("KLEIN_URL");
    if (!url) {
        throw UpstreamError.fromProvider(500, {
            message: "KLEIN_URL is not configured",
        });
    }
    return `${url}/generate`;
};

/**
 * The PNG trailer is always the IEND chunk: a zero-length chunk, the type
 * bytes, then the fixed CRC. A body cut before it is incomplete.
 */
function isCompletePng(buffer: Uint8Array): boolean {
    return (
        buffer.length >= 12 &&
        buffer[buffer.length - 12] === 0 &&
        buffer[buffer.length - 11] === 0 &&
        buffer[buffer.length - 10] === 0 &&
        buffer[buffer.length - 9] === 0 &&
        String.fromCharCode(
            buffer[buffer.length - 8],
            buffer[buffer.length - 7],
            buffer[buffer.length - 6],
            buffer[buffer.length - 5],
        ) === "IEND"
    );
}

/**
 * A 200 from the Klein box must carry a complete, decodable image before it
 * is cached and billed. The worker answers PNG today and its sibling pools
 * answer JPEG, so the completeness check is format-aware: a JPEG must end in
 * its EOI marker and a PNG in its IEND chunk. A body cut mid-stream used to
 * flow through as a successful generation — the gap #18202 closed for the
 * three self-hosted pools, with the same fix shape applied here.
 */
function assertCompleteKleinImage(
    buffer: Uint8Array,
    requestUrl: string,
): asserts buffer {
    const mimeType = detectImageMimeType(buffer);
    const endsCleanly =
        mimeType === "image/jpeg"
            ? buffer[buffer.length - 2] === 0xff &&
              buffer[buffer.length - 1] === 0xd9
            : mimeType === "image/png" && isCompletePng(buffer);
    if (!mimeType || !endsCleanly || !readImageDimensions(buffer, mimeType)) {
        throw UpstreamError.fromProvider(502, {
            message: "Klein API returned an invalid or incomplete image",
            requestUrl: new URL(requestUrl),
        });
    }
}

/**
 * Calls the self-hosted Flux Klein 4B API. Production uses the Vast VPC binding.
 */
export const callFluxKleinAPI = async (
    prompt: string,
    safeParams: ImageParams,
): Promise<ImageGenerationResult> => {
    try {
        // Download and encode reference images if provided
        const downloads = await Promise.all(
            safeParams.image.map((url) => downloadUserImage(url)),
        );
        const imagesB64 = downloads.map(({ buffer }) =>
            buffer.toString("base64"),
        );

        const body: Record<string, unknown> = {
            prompts: [prompt],
            width: safeParams.width || 1024,
            height: safeParams.height || 1024,
            ...(safeParams.seed !== undefined && { seed: safeParams.seed }),
            ...(safeParams.guidance_scale !== undefined && {
                guidance_scale: safeParams.guidance_scale,
            }),
            ...(imagesB64.length > 0 && { images: imagesB64 }),
        };

        logOps(
            "Klein request to",
            getKleinGenerateUrl(),
            "keys:",
            Object.keys(body).join(", "),
        );

        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        const backendToken = getImageEnv("PLN_GPU_TOKEN");
        if (backendToken) {
            headers["x-backend-token"] = backendToken;
        }

        const kleinUrl = getKleinGenerateUrl();
        const response = await fetchUpstream(
            kleinUrl,
            {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                errorLabel: "Klein API request failed",
            },
            kleinVpc?.fetch.bind(kleinVpc),
        );

        const result = await response.json();
        const item = Array.isArray(result) ? result[0] : result;

        if (!item?.image) {
            throw UpstreamError.fromProvider(500, {
                message: "Klein API returned no image",
                requestUrl: new URL(kleinUrl),
            });
        }

        const imageBuffer = base64ToBuffer(item.image);
        assertCompleteKleinImage(imageBuffer, kleinUrl);
        logOps(
            "Klein generation complete, buffer size:",
            imageBuffer.length,
            "seed:",
            item.seed,
        );

        return {
            buffer: imageBuffer,
            trackingData: {
                actualModel: "black-forest-labs/flux.2-klein-4b",
                usage: {
                    completionImageTokens: 1,
                    totalTokenCount: 1,
                },
            },
        };
    } catch (error) {
        logError("Error calling Flux Klein API:", error);
        if (error instanceof UpstreamError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Flux Klein API generation failed: ${message}`);
    }
};

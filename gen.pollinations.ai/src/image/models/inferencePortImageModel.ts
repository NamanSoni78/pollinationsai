import { collectUpstreamHeaders, UpstreamError } from "@shared/error.ts";
import debug from "debug";
import type {
    AuthResult,
    ImageGenerationResult,
} from "../createAndReturnImages.ts";
import { getImageEnv } from "../env.ts";
import type { ImageParams } from "../params.ts";
import { sanitizeString } from "../util.ts";
import {
    analyzeImageSafety,
    requireSafePrompt,
} from "../utils/azureContentSafety.ts";
import { logGptImageError } from "../utils/gptImageLogger.ts";
import { base64ToBuffer, downloadUserImage } from "../utils/imageDownload.ts";

const logCloudflare = debug("pollinations:cloudflare");

const INFERENCEPORT_BASE_URL = "https://api.inferenceport.ai/v1/images";
const INFERENCEPORT_UPSTREAM_MODEL = "lightning-image-turbo";
const INFERENCEPORT_TITLE = "Lightning Image Turbo";

type InferencePortResponse = {
    data?: Array<{ b64_json?: string; url?: string }>;
    usage?: { image_count?: number; payg_credits_charged?: number };
};

async function downloadAndSafetyCheck(
    imageUrl: string,
    prompt: string,
    safeParams: ImageParams,
    userInfo: AuthResult,
): Promise<{ buffer: Buffer; mimeType: string }> {
    const { buffer, mimeType } = await downloadUserImage(imageUrl);
    const imageSafetyResult = await analyzeImageSafety(buffer);
    if (!imageSafetyResult.safe) {
        const error = UpstreamError.fromProvider(400, {
            message: `Input image contains unsafe content: ${imageSafetyResult.formattedViolations}`,
        });
        await logGptImageError(
            prompt,
            safeParams,
            userInfo,
            error,
            imageSafetyResult,
        );
        throw error;
    }
    return { buffer, mimeType };
}

export async function callInferencePortImage(
    prompt: string,
    safeParams: ImageParams,
    userInfo: AuthResult,
): Promise<ImageGenerationResult> {
    // Lightning Image Turbo only outputs 1024x1024; other sizes are ignored.
    const apiKey = getImageEnv("INFERENCEPORT_API_KEY");
    if (!apiKey) {
        throw new Error(
            "INFERENCEPORT_API_KEY not found in environment variables",
        );
    }

    await requireSafePrompt(prompt, safeParams, userInfo);

    const endpoint = `${INFERENCEPORT_BASE_URL}/generations`;
    const imageUrls: string[] = [];
    for (const imageUrl of safeParams.image) {
        const { buffer, mimeType } = await downloadAndSafetyCheck(
            imageUrl,
            prompt,
            safeParams,
            userInfo,
        );
        imageUrls.push(`data:${mimeType};base64,${buffer.toString("base64")}`);
    }
    logCloudflare(`Calling InferencePort ${INFERENCEPORT_TITLE}`);
    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: INFERENCEPORT_UPSTREAM_MODEL,
            prompt: sanitizeString(prompt),
            n: 1,
            ...(imageUrls.length ? { image_urls: imageUrls } : {}),
        }),
    });

    if (!response.ok) {
        let responseBody: string | undefined;
        try {
            responseBody = await response.text();
        } catch {}
        throw UpstreamError.fromProvider(response.status, {
            message: `InferencePort ${INFERENCEPORT_TITLE} returned ${response.status}`,
            requestUrl: new URL(endpoint),
            upstreamStatus: response.status,
            responseBody,
            upstreamHeaders: collectUpstreamHeaders(response.headers),
        });
    }

    const data = (await response.json()) as InferencePortResponse;
    const encodedImage = data.data?.[0]?.b64_json;
    const imageUrl = data.data?.[0]?.url;
    const responseSummary = JSON.stringify({
        responseKeys: Object.keys(data).sort(),
        dataCount: Array.isArray(data.data) ? data.data.length : undefined,
    });
    // InferencePort charges the completed inference (payg credits per
    // image); the usage receipt rides the same response as the image.
    const reportedCount = data.usage?.image_count;
    const validCount =
        typeof reportedCount === "number" &&
        Number.isInteger(reportedCount) &&
        reportedCount > 0
            ? reportedCount
            : undefined;

    let buffer: Buffer;
    if (encodedImage) {
        try {
            buffer = base64ToBuffer(encodedImage);
        } catch (error) {
            // The image is in hand: the inference ran and the provider
            // billed it; a decode failure still settles the image (n: 1).
            throw Object.assign(error as object, {
                billedUsage: { completionImageTokens: 1 },
            });
        }
    } else if (imageUrl) {
        buffer = (
            await downloadUserImage(imageUrl).catch((error: unknown) => {
                // The image URL in hand means the charge already settled
                // provider-side; a failed download still bills the image.
                throw Object.assign(error as object, {
                    billedUsage: {
                        completionImageTokens: validCount ?? 1,
                    },
                });
            })
        ).buffer;
    } else {
        throw new UpstreamError(502, {
            message: `InferencePort ${INFERENCEPORT_TITLE} returned no image`,
            requestUrl: new URL(endpoint),
            upstreamStatus: response.status,
            responseBody: responseSummary,
            upstreamHeaders: collectUpstreamHeaders(response.headers),
            // A 200 with no image is paid only when the usage receipt
            // proves the charge; otherwise it stays unbilled.
            ...(validCount
                ? { billedUsage: { completionImageTokens: validCount } }
                : {}),
        });
    }

    if (!validCount) {
        // The image was delivered: the inference ran and the provider
        // billed it; an unreadable receipt still settles the image (n: 1).
        throw new UpstreamError(502, {
            message: "InferencePort returned no valid image usage",
            requestUrl: new URL(endpoint),
            upstreamStatus: response.status,
            billedUsage: { completionImageTokens: 1 },
        });
    }
    // payg_credits_charged is the total for these images, not an extra fee.
    return {
        buffer,
        trackingData: {
            actualModel: safeParams.model,
            usage: {
                completionImageTokens: validCount,
                totalTokenCount: validCount,
            },
        },
    };
}

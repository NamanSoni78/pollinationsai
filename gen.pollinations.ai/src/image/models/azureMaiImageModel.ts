import { collectUpstreamHeaders, UpstreamError } from "@shared/error.ts";
import type { Usage } from "@shared/registry/registry.ts";
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
import {
    base64ToBuffer,
    bufferToUint8Array,
    downloadUserImage,
} from "../utils/imageDownload.ts";
import { ensureAzureImageOk } from "./azureFluxKontextModel.ts";

const logCloudflare = debug("pollinations:cloudflare");

const AZURE_MAI_ENDPOINT =
    "https://myceli-prod-eastus.services.ai.azure.com/mai/v1/images";
const MAI_ROUTES: Record<string, { deployment: string; title: string }> = {
    "microsoft/mai-image-2.7": {
        deployment: "MAI-Image-2.7",
        title: "MAI Image 2.7",
    },
    "microsoft/mai-image-2.7-flash": {
        deployment: "MAI-Image-2.7-Flash",
        title: "MAI Image 2.7 Flash",
    },
    "microsoft/mai-image-2.6-flash": {
        deployment: "MAI-Image-2.6-Flash",
        title: "MAI Image 2.6 Flash",
    },
    "microsoft/mai-image-2.6": {
        deployment: "MAI-Image-2.6",
        title: "MAI Image 2.6",
    },
};
type MaiRoute = (typeof MAI_ROUTES)[string];
// Azure MAI rejects out-of-range sizes itself, but snaps sizes that are not
// 16px steps down silently.
const AZURE_MAI_DIMENSION_STEP = 16;

/**
 * Microsoft's published per-image output token schedule at 1024x1024, used
 * only to settle requests whose delivered image proves the render was paid
 * but whose usage receipt's output leg was missing: MAI Image 2.7 ~$35 per
 * 1,000 images at $34/M output tokens and 2.7 Flash ~$10/1,000 at $10/M
 * (microsoft.ai, 2026-11-17) → ~1,030/1,000 tokens per image; the 2.6 Flash
 * generation measured $19.46/1,000 images at $19/M → 1,024. 2.6 itself has
 * no published per-image figure, so it borrows 2.7's count (same family and
 * output caps).
 */
const MAI_IMAGE_OUTPUT_TOKENS_PER_IMAGE: Record<string, number> = {
    "MAI-Image-2.7": 1030,
    "MAI-Image-2.7-Flash": 1000,
    "MAI-Image-2.6": 1030,
    "MAI-Image-2.6-Flash": 1024,
};

function maiImageOutputTokens(deployment: string): number {
    return (
        MAI_IMAGE_OUTPUT_TOKENS_PER_IMAGE[deployment] ??
        MAI_IMAGE_OUTPUT_TOKENS_PER_IMAGE["MAI-Image-2.7"]
    );
}

type AzureMaiResponse = {
    data?: Array<{ b64_json?: string }>;
    usage?: {
        num_input_text_tokens?: number;
        num_input_image_tokens?: number;
        num_output_tokens?: number;
    };
};

function validateMaiDimensions(
    width: number,
    height: number,
    route: MaiRoute,
): void {
    if (
        width % AZURE_MAI_DIMENSION_STEP !== 0 ||
        height % AZURE_MAI_DIMENSION_STEP !== 0
    ) {
        throw UpstreamError.fromProvider(400, {
            message: `${route.title} requires width and height to be multiples of ${AZURE_MAI_DIMENSION_STEP}px`,
        });
    }
}

function tokenCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : 0;
}

/**
 * Checks the prompt and every reference with Azure Content Safety and returns
 * the downloaded references. Shared with the OpenRouter fallback.
 */
export async function checkMaiInputs(
    prompt: string,
    safeParams: ImageParams,
    userInfo: AuthResult,
): Promise<Awaited<ReturnType<typeof downloadUserImage>>[]> {
    await requireSafePrompt(prompt, safeParams, userInfo);
    return await Promise.all(
        safeParams.image.map(async (imageUrl) => {
            const image = await downloadUserImage(imageUrl);
            const imageSafetyResult = await analyzeImageSafety(image.buffer);
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
            return image;
        }),
    );
}

function editFormData(
    prompt: string,
    images: Awaited<ReturnType<typeof downloadUserImage>>[],
    route: MaiRoute,
): FormData {
    // Edits take references as repeated multipart `image` fields (up to 5);
    // Azure rejects width/height here.
    const formData = new FormData();
    formData.append("model", route.deployment);
    formData.append("prompt", sanitizeString(prompt));
    for (const { buffer, mimeType } of images) {
        formData.append(
            "image",
            new Blob([bufferToUint8Array(buffer)], { type: mimeType }),
            `image.${mimeType.split("/")[1] || "png"}`,
        );
    }
    return formData;
}

export async function callAzureMaiImage(
    prompt: string,
    safeParams: ImageParams,
    userInfo: AuthResult,
): Promise<ImageGenerationResult> {
    const route = MAI_ROUTES[safeParams.model];
    if (!route) {
        throw new Error(`Unknown Azure MAI image route: ${safeParams.model}`);
    }
    const isEdit = safeParams.image.length > 0;
    if (!isEdit) {
        validateMaiDimensions(safeParams.width, safeParams.height, route);
    }

    const apiKey = getImageEnv("AZURE_MYCELI_PROD_API_KEY");
    if (!apiKey) {
        throw new Error(
            "AZURE_MYCELI_PROD_API_KEY not found in environment variables",
        );
    }

    const images = await checkMaiInputs(prompt, safeParams, userInfo);

    const endpoint = `${AZURE_MAI_ENDPOINT}/${isEdit ? "edits" : "generations"}`;
    const headers: Record<string, string> = { "api-key": apiKey };
    let body: BodyInit;
    if (isEdit) {
        body = editFormData(prompt, images, route);
    } else {
        headers["Content-Type"] = "application/json";
        // Only these fields are accepted; seed, quality and guidance are 400s.
        body = JSON.stringify({
            model: route.deployment,
            prompt: sanitizeString(prompt),
            width: safeParams.width,
            height: safeParams.height,
        });
    }

    logCloudflare(
        `Calling Azure ${route.title} in ${isEdit ? "edit" : "generation"} mode`,
    );
    const response = await fetch(endpoint, { method: "POST", headers, body });
    await ensureAzureImageOk(response, endpoint);

    const data = (await response.json()) as AzureMaiResponse;
    const encodedImage = data.data?.[0]?.b64_json;
    const responseSummary = JSON.stringify({
        responseKeys: Object.keys(data).sort(),
        dataCount: Array.isArray(data.data) ? data.data.length : undefined,
        usage: data.usage,
    });
    // Azure bills a completed render even when the receipt or payload is
    // unusable; settle every reported leg that is readable.
    const settleMaiUsage = (includeOutput: boolean): Usage | undefined => {
        const promptTextTokens = tokenCount(data.usage?.num_input_text_tokens);
        const promptImageTokens = tokenCount(
            data.usage?.num_input_image_tokens,
        );
        const completionImageTokens = includeOutput
            ? tokenCount(data.usage?.num_output_tokens)
            : 0;
        const usage: Usage = {
            ...(promptTextTokens > 0 ? { promptTextTokens } : {}),
            ...(promptImageTokens > 0 ? { promptImageTokens } : {}),
            ...(completionImageTokens > 0 ? { completionImageTokens } : {}),
        };
        return Object.keys(usage).length ? usage : undefined;
    };
    if (!encodedImage) {
        const settle = settleMaiUsage(true);
        throw new UpstreamError(502, {
            message: `Azure ${route.title} returned no image`,
            requestUrl: new URL(endpoint),
            upstreamStatus: response.status,
            responseBody: responseSummary,
            upstreamHeaders: collectUpstreamHeaders(response.headers),
            ...(settle ? { billedUsage: settle } : {}),
        });
    }

    const completionImageTokens = tokenCount(data.usage?.num_output_tokens);
    if (completionImageTokens === 0) {
        const settle = settleMaiUsage(false);
        throw new UpstreamError(502, {
            message: `Azure ${route.title} returned no billing metadata`,
            requestUrl: new URL(endpoint),
            upstreamStatus: response.status,
            responseBody: responseSummary,
            upstreamHeaders: collectUpstreamHeaders(response.headers),
            // The image was delivered, so the render was billed. The input
            // legs are the readable part of the receipt; the output leg —
            // the dominant cost at Azure's $34/$19/$10 per million output
            // tokens — settles from Microsoft's published per-image output
            // token schedule (issue 91's companion: the unreadable-output
            // case previously dropped it).
            billedUsage: {
                ...(settle ?? {}),
                completionImageTokens:
                    Math.max(1, data.data?.length ?? 1) *
                    maiImageOutputTokens(route.deployment),
            },
        });
    }
    const promptTextTokens = tokenCount(data.usage?.num_input_text_tokens);
    const promptImageTokens = tokenCount(data.usage?.num_input_image_tokens);

    return {
        buffer: base64ToBuffer(encodedImage),
        trackingData: {
            actualModel: safeParams.model,
            usage: {
                ...(promptTextTokens > 0 ? { promptTextTokens } : {}),
                ...(promptImageTokens > 0 ? { promptImageTokens } : {}),
                completionImageTokens,
            },
        },
    };
}

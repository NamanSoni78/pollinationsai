import { UpstreamError } from "@shared/error.ts";
import type { ImageGenerationResult } from "../createAndReturnImages.ts";
import { getImageEnv } from "../env.ts";
import type { ImageParams } from "../params.ts";
import { falBillableUnits } from "../utils/falBillableUnits.ts";
import { fetchUpstream } from "../utils/fetchUpstream.ts";

const ZIMAGE_FAL_ENDPOINT = "https://fal.run/fal-ai/z-image/turbo";
const ZIMAGE_FAL_TIMEOUT_MS = 120_000;

// The z-image pool workers only serve what their hardware can: sides between
// 256 and 4096 and at most 768*768*4 total pixels (their MAX_FINAL_PIXELS
// upscaled cap), answering anything larger with a 422 that never falls back.
// The fal route must honor the same cap: fal bills per rounded-up megapixel
// while the caller pays the pool's flat quote, so an oversized request that
// sheds to fal while the pool is saturated or down would turn the platform's
// fallback subsidy into an unbounded cost gap (4096x4096 bills 17 fal units,
// ~21x the flat price the caller pays).
const ZIMAGE_MIN_SIDE = 256;
const ZIMAGE_MAX_SIDE = 4096;
const ZIMAGE_MAX_PIXELS = 768 * 768 * 4;

function assertWithinZImagePoolCap(width: number, height: number): void {
    const pixels = width * height;
    if (
        width < ZIMAGE_MIN_SIDE ||
        height < ZIMAGE_MIN_SIDE ||
        width > ZIMAGE_MAX_SIDE ||
        height > ZIMAGE_MAX_SIDE ||
        pixels > ZIMAGE_MAX_PIXELS
    ) {
        throw UpstreamError.fromProvider(422, {
            message: `Requested ${width}x${height} = ${pixels.toLocaleString("en-US")} pixels exceeds the z-image limit of ${ZIMAGE_MAX_PIXELS.toLocaleString("en-US")} pixels. Max: 1536x1536 or equivalent area.`,
        });
    }
}

type FalZImageResponse = {
    images?: Array<{
        url?: string;
        content_type?: string;
    }>;
};

async function readFalResponse(response: Response): Promise<FalZImageResponse> {
    try {
        return (await response.json()) as FalZImageResponse;
    } catch {
        throw UpstreamError.fromProvider(502, {
            message: "Z-Image Fal returned invalid JSON",
        });
    }
}

export async function callZImageFalAPI(
    prompt: string,
    safeParams: ImageParams,
): Promise<ImageGenerationResult> {
    const apiKey = getImageEnv("FAL_KEY");
    if (!apiKey) {
        throw UpstreamError.fromProvider(500, {
            message: "Z-Image Fal fallback is not configured",
        });
    }
    assertWithinZImagePoolCap(
        safeParams.width ?? 1024,
        safeParams.height ?? 1024,
    );

    const response = await fetchUpstream(ZIMAGE_FAL_ENDPOINT, {
        method: "POST",
        headers: {
            Authorization: `Key ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            prompt,
            image_size: {
                width: safeParams.width,
                height: safeParams.height,
            },
            num_inference_steps: 4,
            seed: safeParams.seed,
            num_images: 1,
            output_format: "jpeg",
            enable_prompt_expansion: false,
        }),
        signal: AbortSignal.timeout(ZIMAGE_FAL_TIMEOUT_MS),
        errorLabel: "Z-Image Fal generation failed",
    });
    const result = await readFalResponse(response);
    const image = result.images?.[0];
    if (!image?.url) {
        throw UpstreamError.fromProvider(502, {
            message: "Z-Image Fal returned no image",
        });
    }
    const billedMegapixels = falBillableUnits(response);

    const imageResponse = await fetchUpstream(image.url, {
        signal: AbortSignal.timeout(ZIMAGE_FAL_TIMEOUT_MS),
        errorLabel: "Failed to download Z-Image Fal output",
    });

    return {
        buffer: Buffer.from(await imageResponse.arrayBuffer()),
        mimeType:
            image.content_type ||
            imageResponse.headers.get("content-type") ||
            undefined,
        trackingData: {
            actualModel: "tongyi-mai/z-image-turbo:fal",
            usage: { completionImageTokens: 1 },
            // Fal rounds each image up to whole megapixels.
            pricingInput: { megapixels: billedMegapixels },
        },
    };
}

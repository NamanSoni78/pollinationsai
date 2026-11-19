import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamError } from "@shared/error.ts";
import {
    HOTSHOT_XL_GPU_SECOND_COST,
    IMAGE_SERVICES,
} from "@shared/registry/image.ts";
import { calculateUsageBilling } from "@shared/registry/registry.ts";
import {
    type AuthResult,
    callGPTImage,
} from "../../src/image/createAndReturnImages.ts";
import { syncImageEnv } from "../../src/image/env.ts";
import { callHotshotXL } from "../../src/image/models/hotshotXLModel.ts";
import type { ImageParams } from "../../src/image/params.ts";

// A minimal valid two-frame GIF (the same fixture the sibling routing tests use).
const GIF_BYTES = Buffer.from(
    "R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQADwAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBDwABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7",
    "base64",
);

const PREDICTIONS_URL = "https://api.replicate.com/v1/predictions";
const ARTIFACT_URL = "https://replicate.delivery/hotshot/x.gif";
const FAL_URL =
    "https://fal.run/openai/gpt-image-2.6/sunburst/text-to-image";

const hotshotParams: ImageParams = {
    model: "hotshotco/hotshot-xl",
    width: 512,
    height: 512,
    dimensionsExplicit: true,
    seed: 42,
    safe: false,
    quality: "medium",
    image: [],
    transparent: false,
    reasoning: "balanced",
    audio: false,
};

const FAL_MODEL = "openai/gpt-image-2.6-sunburst:fal" as const;
const falParams: ImageParams = {
    model: FAL_MODEL,
    width: 512,
    height: 512,
    dimensionsExplicit: true,
    seed: 42,
    safe: false,
    quality: "low",
    image: [],
    transparent: false,
    reasoning: "balanced",
    audio: false,
    output_format: "png",
};

const userInfo: AuthResult = {
    tokenAuth: true,
    userId: "test-user",
};

function replicateSucceeded(predictTime: number): Response {
    return Response.json({
        id: "hotshot-1",
        status: "succeeded",
        output: ARTIFACT_URL,
        metrics: { predict_time: predictTime },
        urls: {
            get: `${PREDICTIONS_URL}/hotshot-1`,
            cancel: `${PREDICTIONS_URL}/hotshot-1/cancel`,
        },
    });
}

function falResponse(
    units: string | null,
    body: BodyInit,
    headers: Record<string, string> = {},
): Response {
    const allHeaders = new Headers(headers);
    if (units !== null) allHeaders.set("x-fal-billable-units", units);
    return new Response(body, { status: 200, headers: allHeaders });
}

beforeEach(() => {
    syncImageEnv(
        {
            REPLICATE_API_TOKEN: "replicate-test-key",
            FAL_KEY: "fal-test-key",
        } as CloudflareBindings,
        ["REPLICATE_API_TOKEN", "FAL_KEY"],
    );
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("Hotshot-XL post-paid settlement (Replicate GPU seconds)", () => {
    it("settles the GPU-second receipt when the artifact download fails after a SUCCEEDED prediction", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            if (String(url) === PREDICTIONS_URL) {
                return replicateSucceeded(9.95);
            }
            return Promise.reject(new TypeError("Network connection lost"));
        });

        const error = await callHotshotXL("test", hotshotParams).then(
            () => undefined,
            (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).billedProviderBilling).toEqual({
            units: 9.95,
            unitCost: HOTSHOT_XL_GPU_SECOND_COST,
        });
    });

    it("settles the receipt when the downloaded artifact is not a GIF", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            if (String(url) === PREDICTIONS_URL) {
                return replicateSucceeded(12.5);
            }
            return new Response("<html>not a gif</html>", {
                headers: { "content-type": "text/html" },
            });
        });

        const error = await callHotshotXL("test", hotshotParams).then(
            () => undefined,
            (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).billedProviderBilling).toEqual({
            units: 12.5,
            unitCost: HOTSHOT_XL_GPU_SECOND_COST,
        });
    });

    it("wraps a torn artifact body read as a receipt-carrying 502 instead of a raw TypeError", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            if (String(url) === PREDICTIONS_URL) {
                return replicateSucceeded(7.25);
            }
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.error(new Error("torn body read"));
                    },
                }),
                { headers: { "content-type": "image/gif" } },
            );
        });

        const error = await callHotshotXL("test", hotshotParams).then(
            () => undefined,
            (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).status).toBe(502);
        expect((error as UpstreamError).billedProviderBilling).toEqual({
            units: 7.25,
            unitCost: HOTSHOT_XL_GPU_SECOND_COST,
        });
    });

    it("settles the 1-GPU-second floor when a SUCCEEDED run reports no predict_time", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            if (String(url) === PREDICTIONS_URL) {
                return replicateSucceeded(0);
            }
            return new Response(GIF_BYTES, {
                headers: { "content-type": "image/gif" },
            });
        });

        const error = await callHotshotXL("test", hotshotParams).then(
            () => undefined,
            (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).billedProviderBilling).toEqual({
            units: 1,
            unitCost: HOTSHOT_XL_GPU_SECOND_COST,
        });
    });

    it("keeps prediction-phase failures unbilled (Replicate does not charge failed runs)", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(String(url)).toBe(PREDICTIONS_URL);
            return Response.json({
                id: "hotshot-1",
                status: "failed",
                error: "model crashed",
                urls: {
                    get: `${PREDICTIONS_URL}/hotshot-1`,
                    cancel: `${PREDICTIONS_URL}/hotshot-1/cancel`,
                },
            });
        });

        const error = await callHotshotXL("test", hotshotParams).then(
            () => undefined,
            (e: unknown) => e,
        );

        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).billedProviderBilling).toBeUndefined();
        expect((error as UpstreamError).billedUsage).toBeUndefined();
    });

    it("keeps the success path's receipt untouched", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            if (String(url) === PREDICTIONS_URL) {
                return replicateSucceeded(9.95);
            }
            return new Response(GIF_BYTES, {
                headers: { "content-type": "image/gif" },
            });
        });

        const result = await callHotshotXL("test", hotshotParams);

        expect(result.mimeType).toBe("image/gif");
        expect(result.trackingData.providerBilling).toEqual({
            units: 9.95,
            unitCost: HOTSHOT_XL_GPU_SECOND_COST,
        });
    });
});

describe("Fal GPT Image post-paid settlement (billable-units receipt)", () => {
    it("settles the fal receipt when the 200 body fails to parse as JSON", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(String(url)).toBe(FAL_URL);
            return falResponse("0.05", "not-json{");
        });

        const error = await callGPTImage(
            "test",
            falParams,
            userInfo,
            FAL_MODEL,
        ).then(() => undefined, (e: unknown) => e);

        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).billedProviderBilling).toEqual({
            units: 0.05,
            unitCost: 1,
        });
    });

    it("settles the fal receipt when the parsed body carries no image", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(String(url)).toBe(FAL_URL);
            return falResponse("0.05", JSON.stringify({ images: [] }));
        });

        const error = await callGPTImage(
            "test",
            falParams,
            userInfo,
            FAL_MODEL,
        ).then(() => undefined, (e: unknown) => e);

        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).billedProviderBilling).toEqual({
            units: 0.05,
            unitCost: 1,
        });
    });

    it("settles the fal receipt when the artifact download fails", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            if (String(url) === FAL_URL) {
                return falResponse(
                    "0.0248",
                    JSON.stringify({
                        images: [
                            {
                                url: "https://artifact.example/x.png",
                                content_type: "image/png",
                            },
                        ],
                    }),
                );
            }
            return Promise.reject(new TypeError("Network connection lost"));
        });

        const error = await callGPTImage(
            "test",
            falParams,
            userInfo,
            FAL_MODEL,
        ).then(() => undefined, (e: unknown) => e);

        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).billedProviderBilling).toEqual({
            units: 0.0248,
            unitCost: 1,
        });
    });

    it("stays unbilled when the response carries no billable-units receipt", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(String(url)).toBe(FAL_URL);
            return falResponse(null, JSON.stringify({ images: [] }));
        });

        const error = await callGPTImage(
            "test",
            falParams,
            userInfo,
            FAL_MODEL,
        ).then(() => undefined, (e: unknown) => e);

        expect(error).toBeInstanceOf(UpstreamError);
        expect((error as UpstreamError).billedProviderBilling).toBeUndefined();
        expect((error as UpstreamError).billedUsage).toBeUndefined();
    });

    it("keeps the success path's receipt untouched", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
            expect(String(url)).toBe(FAL_URL);
            return falResponse(
                "0.0248",
                JSON.stringify({
                    images: [
                        {
                            url: "data:image/png;base64,AQID",
                            content_type: "image/png",
                        },
                    ],
                }),
            );
        });

        const result = await callGPTImage(
            "test",
            falParams,
            userInfo,
            FAL_MODEL,
        );

        expect(result.trackingData.providerBilling).toEqual({
            units: 0.0248,
            unitCost: 1,
        });
    });
});

describe("Receipt-only error settlement (registry math)", () => {
    it("settles a receipt-only failure at units x unitCost through calculateUsageBilling", () => {
        const billing = calculateUsageBilling({
            model: "hotshotco/hotshot-xl",
            usage: {},
            servedBy: IMAGE_SERVICES["hotshotco/hotshot-xl"],
            input: {
                providerBilling: {
                    units: 10,
                    unitCost: HOTSHOT_XL_GPU_SECOND_COST,
                },
            },
        });
        // 10 GPU seconds x $0.000975, priceMultiplier 1.
        expect(billing.cost.totalCost).toBeCloseTo(0.00975, 10);
        expect(billing.price.totalPrice).toBeCloseTo(0.00975, 10);
    });
});

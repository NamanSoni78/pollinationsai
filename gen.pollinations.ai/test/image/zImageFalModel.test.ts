import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncImageEnv } from "../../src/image/env.ts";
import { callZImageFalAPI } from "../../src/image/models/zImageFalModel.ts";
import type { ImageParams } from "../../src/image/params.ts";

const FAL_ENDPOINT = "https://fal.run/fal-ai/z-image/turbo";
const IMAGE_URL = "https://fal.media/zimage-output.jpg";
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const params: ImageParams = {
    model: "tongyi-mai/z-image-turbo:fal",
    width: 1024,
    height: 768,
    dimensionsExplicit: true,
    seed: 42,
    safe: false,
    quality: "medium",
    image: [],
    transparent: false,
    reasoning: "balanced",
    audio: false,
};

beforeEach(() => {
    syncImageEnv({ FAL_KEY: "test-fal-key" } as CloudflareBindings, [
        "FAL_KEY",
    ]);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("callZImageFalAPI", () => {
    it("generates one image with the public Z-Image parameters", async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
            const href = url.toString();
            requests.push({ url: href, init });
            if (href === FAL_ENDPOINT) {
                return Response.json(
                    {
                        images: [
                            {
                                url: IMAGE_URL,
                                content_type: "image/jpeg",
                                width: 1024,
                                height: 768,
                            },
                        ],
                        seed: 42,
                        has_nsfw_concepts: [false],
                    },
                    { headers: { "x-fal-billable-units": "1" } },
                );
            }
            if (href === IMAGE_URL) {
                return new Response(JPEG_BYTES, {
                    headers: { "content-type": "image/jpeg" },
                });
            }
            return new Response("unexpected URL", { status: 404 });
        });

        const result = await callZImageFalAPI("a red apple", params);

        expect(requests.map(({ url }) => url)).toEqual([
            FAL_ENDPOINT,
            IMAGE_URL,
        ]);
        expect(JSON.parse(requests[0].init?.body as string)).toEqual({
            prompt: "a red apple",
            image_size: { width: 1024, height: 768 },
            num_inference_steps: 4,
            seed: 42,
            num_images: 1,
            output_format: "jpeg",
            enable_prompt_expansion: false,
        });
        expect(requests[0].init?.headers).toMatchObject({
            Authorization: "Key test-fal-key",
        });
        expect(result.buffer).toEqual(Buffer.from(JPEG_BYTES));
        expect(result.mimeType).toBe("image/jpeg");
        // 1024x768 is 0.75 MP; fal bills it as one whole megapixel.
        expect(result.trackingData).toEqual({
            actualModel: "tongyi-mai/z-image-turbo:fal",
            usage: { completionImageTokens: 1 },
            pricingInput: { megapixels: 1 },
        });
    });

    it("rejects a response without fal billable units", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            Response.json({ images: [{ url: IMAGE_URL }] }),
        );

        await expect(
            callZImageFalAPI("a red apple", params),
        ).rejects.toMatchObject({
            status: 502,
            message: "Fal response has no billable units",
        });
    });

    it("rejects a successful response without an image", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            Response.json({ images: [] }),
        );

        await expect(
            callZImageFalAPI("a red apple", params),
        ).rejects.toMatchObject({ status: 502 });
    });

    it("rejects invalid Fal JSON as an upstream error", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
            new Response("not json"),
        );

        await expect(
            callZImageFalAPI("a red apple", params),
        ).rejects.toMatchObject({
            status: 502,
            message: "Z-Image Fal returned invalid JSON",
        });
    });

    it.each([
        ["4096x4096 (17x the pool's pixel cap)", 4096, 4096],
        ["2048x2048", 2048, 2048],
        ["below the pool's minimum side", 100, 100],
        ["above the pool's maximum side", 8192, 256],
    ])(
        "refuses %s without calling fal, mirroring the pool workers' 422",
        async (_name, width, height) => {
            const fetchSpy = vi
                .spyOn(globalThis, "fetch")
                .mockResolvedValueOnce(new Response("unexpected", {
                    status: 500,
                }));

            await expect(
                callZImageFalAPI("a red apple", {
                    ...params,
                    width,
                    height,
                }),
            ).rejects.toMatchObject({
                status: 422,
                message: expect.stringContaining("exceeds the z-image limit"),
            });
            expect(fetchSpy).not.toHaveBeenCalled();
        },
    );

    it("serves dimensions at the pool cap exactly", async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
            const href = url.toString();
            requests.push({ url: href, init });
            if (href === FAL_ENDPOINT) {
                return Response.json(
                    {
                        images: [
                            { url: IMAGE_URL, content_type: "image/jpeg" },
                        ],
                    },
                    { headers: { "x-fal-billable-units": "3" } },
                );
            }
            return new Response(JPEG_BYTES, {
                headers: { "content-type": "image/jpeg" },
            });
        });

        // 1536x1536 = 2,359,296 px, exactly the pool's MAX_FINAL_PIXELS.
        await callZImageFalAPI("a red apple", {
            ...params,
            width: 1536,
            height: 1536,
        });

        expect(JSON.parse(requests[0].init?.body as string)).toMatchObject({
            image_size: { width: 1536, height: 1536 },
        });
    });
});

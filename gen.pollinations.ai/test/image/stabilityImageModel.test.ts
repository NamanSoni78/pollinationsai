import { UpstreamError } from "@shared/error.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncImageEnv } from "../../src/image/env.ts";
import { callStabilityImage } from "../../src/image/models/stabilityImageModel.ts";
import type { ImageParams } from "../../src/image/params.ts";

const baseParams = (model: ImageParams["model"]): ImageParams => ({
    model,
    width: 1024,
    height: 1024,
    dimensionsExplicit: true,
    seed: 42,
    safe: false,
    quality: "medium",
    image: [],
    transparent: false,
    reasoning: "balanced",
    audio: false,
    duration: 5,
});

const PNG_MAGIC = Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG_MAGIC = Buffer.of(0xff, 0xd8, 0xff, 0xe0);

const BEDROCK_MODEL = "stability-ai/stable-image-core";
const DIRECT_MODEL = "stability-ai/stable-image-core:stability";

async function expectUpstream(
    fn: () => Promise<unknown>,
): Promise<UpstreamError> {
    try {
        await fn();
        expect.unreachable("expected the call to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        return error as UpstreamError;
    }
}

function json(body: unknown) {
    return Response.json(body, {
        headers: { "content-type": "application/json" },
    });
}

function stubFetch(
    route: (url: URL) => Response | Promise<Response>,
) {
    vi.stubGlobal(
        "fetch",
        ((input: RequestInfo | URL) =>
            route(new URL(input instanceof Request ? input.url : String(input)))) as typeof fetch,
    );
}

beforeEach(() => {
    syncImageEnv(
        {
            AWS_ACCESS_KEY_ID: "test-access-key",
            AWS_SECRET_ACCESS_KEY: "test-secret-key",
            STABILITY_API_KEY: "test-stability-key",
        } as CloudflareBindings,
        ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "STABILITY_API_KEY"],
    );
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("stability image post-invoke settlement (issue 131)", () => {
    it("Bedrock: malformed 200 JSON body settles the image rate", async () => {
        stubFetch((url) => {
            if (url.href.includes("bedrock-runtime")) {
                return new Response("not-json{", {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        const error = await expectUpstream(() =>
            callStabilityImage("a cat", baseParams(BEDROCK_MODEL), "core"),
        );
        expect(error.status).toBe(502);
        expect(error.message).toContain("Failed to parse");
        expect(error.billedUsage).toEqual({ completionImageTokens: 1 });
    });

    it("Bedrock: empty images array settles via the PNG check", async () => {
        stubFetch((url) => {
            if (url.href.includes("bedrock-runtime")) {
                return json({ images: [] });
            }
            return new Response("unexpected", { status: 404 });
        });
        const error = await expectUpstream(() =>
            callStabilityImage("a cat", baseParams(BEDROCK_MODEL), "core"),
        );
        expect(error.status).toBe(502);
        expect(error.message).toContain("no valid PNG");
        expect(error.billedUsage).toEqual({ completionImageTokens: 1 });
    });

    it("Bedrock: invalid base64 image settles the image rate", async () => {
        stubFetch((url) => {
            if (url.href.includes("bedrock-runtime")) {
                return json({ images: ["@@not-base64@@"] });
            }
            return new Response("unexpected", { status: 404 });
        });
        const error = await expectUpstream(() =>
            callStabilityImage("a cat", baseParams(BEDROCK_MODEL), "core"),
        );
        expect(error.status).toBe(502);
        expect(error.billedUsage).toEqual({ completionImageTokens: 1 });
    });

    it("Bedrock: content-filter rejection stays unbilled (control)", async () => {
        stubFetch((url) => {
            if (url.href.includes("bedrock-runtime")) {
                return json({ finish_reasons: ["Filter reason: policy"] });
            }
            return new Response("unexpected", { status: 404 });
        });
        const error = await expectUpstream(() =>
            callStabilityImage("a cat", baseParams(BEDROCK_MODEL), "core"),
        );
        expect(error.status).toBe(400);
        expect(error.billedUsage).toBeUndefined();
    });

    it("Bedrock: valid PNG settles with the success usage (control)", async () => {
        stubFetch((url) => {
            if (url.href.includes("bedrock-runtime")) {
                return json({
                    images: [
                        Buffer.concat([PNG_MAGIC, Buffer.alloc(16)]).toString(
                            "base64",
                        ),
                    ],
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        const result = await callStabilityImage(
            "a cat",
            baseParams(BEDROCK_MODEL),
            "core",
        );
        expect(result.trackingData.usage).toEqual({
            completionImageTokens: 1,
        });
    });

    it("direct: truncated 200 body settles the image rate", async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(PNG_MAGIC);
                controller.error(new TypeError("network connection lost"));
            },
        });
        stubFetch((url) => {
            if (url.hostname === "api.stability.ai") {
                return new Response(stream, {
                    status: 200,
                    headers: { "content-type": "image/png" },
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        const error = await expectUpstream(() =>
            callStabilityImage("a cat", baseParams(DIRECT_MODEL), "core"),
        );
        expect(error.status).toBe(502);
        expect(error.message).toContain("Failed to read");
        expect(error.billedUsage).toEqual({ completionImageTokens: 1 });
    });

    it("direct: non-PNG 200 body settles via the PNG check", async () => {
        stubFetch((url) => {
            if (url.hostname === "api.stability.ai") {
                return new Response(JPEG_MAGIC, {
                    status: 200,
                    headers: { "content-type": "image/jpeg" },
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        const error = await expectUpstream(() =>
            callStabilityImage("a cat", baseParams(DIRECT_MODEL), "core"),
        );
        expect(error.status).toBe(502);
        expect(error.message).toContain("no valid PNG");
        expect(error.billedUsage).toEqual({ completionImageTokens: 1 });
    });

    it("direct: valid PNG settles with the success usage (control)", async () => {
        stubFetch((url) => {
            if (url.hostname === "api.stability.ai") {
                return new Response(
                    Buffer.concat([PNG_MAGIC, Buffer.alloc(16)]),
                    { status: 200, headers: { "content-type": "image/png" } },
                );
            }
            return new Response("unexpected", { status: 404 });
        });
        const result = await callStabilityImage(
            "a cat",
            baseParams(DIRECT_MODEL),
            "core",
        );
        expect(result.trackingData.usage).toEqual({
            completionImageTokens: 1,
        });
    });
});

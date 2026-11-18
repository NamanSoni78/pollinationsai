import { UpstreamError } from "@shared/error.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthResult } from "../../src/image/createAndReturnImages.ts";
import { syncImageEnv } from "../../src/image/env.ts";
import { callInferencePortImage } from "../../src/image/models/inferencePortImageModel.ts";
import type { ImageParams } from "../../src/image/params.ts";
import { mockImageProviderFetch } from "./mockImageProviderFetch.ts";

// Issue 91's named residual: inferencePortImageModel's DOWNLOAD leg (and
// the b64-decode leg it did not list) still settle $0 when they fail after
// the paid 200. The guards (no-image, no-valid-usage) are owned by the
// concurrent solution77-usage-guard-settlement-sweep (PR #107, diff
// verified); this companion touches only the two legs that branch does
// not, and composes with it line-disjointly.

const OUTPUT_URL = "https://cdn.inferenceport.example/out.png";
const USER_INFO = {} as AuthResult;

const baseParams: ImageParams = {
    model: "inferenceport-ai/lightning-image-turbo",
    width: 1024,
    height: 1024,
    dimensionsExplicit: false,
    seed: 42,
    safe: false,
    quality: "medium",
    image: [],
    transparent: false,
    reasoning: "balanced",
    audio: false,
    duration: 0,
};

async function expectBilled(
    fn: () => Promise<unknown>,
    check: (billedUsage: unknown, status: number) => void,
) {
    try {
        await fn();
        expect.unreachable("expected the call to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        const upstream = error as UpstreamError & {
            billedUsage?: Record<string, number>;
        };
        check(upstream.billedUsage, upstream.status);
    }
}

beforeEach(() => {
    syncImageEnv(
        { INFERENCEPORT_API_KEY: "test-ip-key" } as CloudflareBindings,
        ["INFERENCEPORT_API_KEY"],
    );
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("post-paid failure settlement — InferencePort download/decode legs", () => {
    it("D1: a failed download of the delivered URL settles the receipt count", async () => {
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockImplementation(async (input) => {
            const href = typeof input === "string" ? input : input.toString();
            if (href.includes("/v1/images/generations"))
                return Response.json({
                    data: [{ url: OUTPUT_URL }],
                    usage: { image_count: 2, payg_credits_charged: 0.04 },
                });
            if (href === OUTPUT_URL) return new Response("boom", { status: 500 });
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callInferencePortImage("a lighthouse", baseParams, USER_INFO),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionImageTokens: 2,
                });
            },
        );
    });

    it("D2: a failed download without a readable receipt settles the delivered image", async () => {
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockImplementation(async (input) => {
            const href = typeof input === "string" ? input : input.toString();
            if (href.includes("/v1/images/generations"))
                return Response.json({ data: [{ url: OUTPUT_URL }] });
            if (href === OUTPUT_URL) return new Response("boom", { status: 500 });
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callInferencePortImage("a lighthouse", baseParams, USER_INFO),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionImageTokens: 1,
                });
            },
        );
    });

    it("B1: a decode failure of the delivered b64 image settles the image", async () => {
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockResolvedValue(
            Response.json({
                // Carries characters base64ToBuffer rejects.
                data: [{ b64_json: "!!!not-base64!!!" }],
                usage: { image_count: 1, payg_credits_charged: 0.02 },
            }),
        );
        await expectBilled(
            () =>
                callInferencePortImage("a lighthouse", baseParams, USER_INFO),
            (billedUsage, status) => {
                expect(status).toBe(502);
                expect(billedUsage).toEqual({
                    completionImageTokens: 1,
                });
            },
        );
    });
});

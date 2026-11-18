import { UpstreamError } from "@shared/error.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthResult } from "../../src/image/createAndReturnImages.ts";
import { syncImageEnv } from "../../src/image/env.ts";
import { callInferencePortImage } from "../../src/image/models/inferencePortImageModel.ts";
import type { ImageParams } from "../../src/image/params.ts";
import { mockImageProviderFetch } from "./mockImageProviderFetch.ts";

// Issue 82's named residual, part 2: inferencePortImageModel's post-paid
// legs. InferencePort charges the completed inference (payg credits per
// image) at the 200 whose usage receipt rides the same response — so a
// failed download of the delivered URL, an unreadable receipt after a
// delivered image, and a no-image 200 with the receipt in hand all settle
// via error.billedUsage exactly like the clients issues 25/72/75/76 fixed.
// The no-receipt/no-image shape stays unbilled (pinned as the control —
// a filter-refusal-like 200 without a charge is not provably paid).

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

describe("post-paid failure settlement — InferencePort image legs", () => {
    it("IP1: a failed download of the delivered URL settles the receipt count", async () => {
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockImplementation(async (input) => {
            const href =
                typeof input === "string" ? input : input.toString();
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

    it("IP2: a delivered image with an unreadable receipt settles the image", async () => {
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockResolvedValue(
            Response.json({
                data: [
                    {
                        b64_json: Buffer.from("inferenceport-output").toString(
                            "base64",
                        ),
                    },
                ],
                usage: { image_count: 0 },
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

    it("IP3: a no-image 200 with the usage receipt settles the charged images", async () => {
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockResolvedValue(
            Response.json({
                data: [],
                usage: { image_count: 3, payg_credits_charged: 0.06 },
            }),
        );
        await expectBilled(
            () =>
                callInferencePortImage("a lighthouse", baseParams, USER_INFO),
            (billedUsage) => {
                expect(billedUsage).toEqual({
                    completionImageTokens: 3,
                });
            },
        );
    });

    it("IP4: a no-image 200 without a receipt stays unbilled (control)", async () => {
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockResolvedValue(
            Response.json({
                data: [],
            }),
        );
        await expectBilled(
            () =>
                callInferencePortImage("a lighthouse", baseParams, USER_INFO),
            (billedUsage) => {
                expect(billedUsage).toBeUndefined();
            },
        );
    });
});

import { UpstreamError } from "@shared/error.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertNonEmptyMedia } from "../../src/model3d/handler.ts";
import { syncModel3dEnvironment } from "../../src/model3d/env.ts";
import { callAssetHarvester } from "../../src/model3d/models/assetHarvesterModel.ts";
import { callRodinFalAPI } from "../../src/model3d/models/rodinModel.ts";
import { callTrellis2 } from "../../src/model3d/models/trellis2Model.ts";
import { callTrellis2Fal } from "../../src/model3d/models/trellis2FalModel.ts";
import { callTripoP2 } from "../../src/model3d/models/tripoP2Model.ts";
import type { Model3dParams } from "../../src/model3d/params.ts";
import type { Model3dGenerationResult } from "../../src/model3d/createAndReturnModel3d.ts";

// The model3d fleet's post-paid failure legs (issue 72's named residuals):
// fal bills a queue job the moment it reports COMPLETED and InferencePort
// charges payg credits on completion, so every failure AFTER those events
// must settle the caller via error.billedUsage — mirroring the 11 image
// clients issue 72 already fixed.

const FAL_STATUS = "https://queue.fal.run/status";
const FAL_RESPONSE = "https://queue.fal.run/response";

beforeEach(() => {
    syncModel3dEnvironment({
        FAL_KEY: "fal_test_key",
        INFERENCEPORT_API_KEY: "ip_test_token",
    } as CloudflareBindings);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function params(overrides: Partial<Model3dParams> = {}): Model3dParams {
    return {
        model: "microsoft/trellis-2",
        resolution: "low",
        image: ["https://example.com/ref.jpg"],
        safe: false,
        ...overrides,
    };
}

async function expectBilled(
    fn: () => Promise<unknown>,
    status: number,
    checkBilledUsage: (billedUsage: unknown) => void,
) {
    try {
        await fn();
        expect.unreachable("expected the call to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        const upstream = error as UpstreamError & {
            billedUsage?: Record<string, number>;
        };
        expect(upstream.status, upstream.message).toBe(status);
        checkBilledUsage(upstream.billedUsage);
    }
}

/** Run a fal-queue call with the poll sleeps resolved via fake timers. */
async function runFal(fn: () => Promise<unknown>) {
    vi.useFakeTimers();
    const promise = fn();
    // Mark rejections handled while the timers advance past the polls.
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(20_000);
    vi.useRealTimers();
    return promise;
}

function stubRoutes(routes: Record<string, Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
        ((input: RequestInfo | URL) => {
            const url = new URL(
                input instanceof Request ? input.url : String(input),
            );
            const hit = routes[url.href];
            return Promise.resolve(
                hit ?? new Response("unexpected", { status: 404 }),
            );
        }) as typeof fetch,
    );
}

function falQueue(
    endpoint: string,
    responseBody: unknown,
    responseHeaders: Record<string, string> = {},
    extra: Record<string, Response> = {},
) {
    const routes: Record<string, Response> = {
        [`https://queue.fal.run/${endpoint}`]: Response.json({
            status_url: FAL_STATUS,
            response_url: FAL_RESPONSE,
        }),
        [FAL_STATUS]: Response.json({ status: "COMPLETED" }),
        ...extra,
    };
    if (!(FAL_RESPONSE in extra)) {
        routes[FAL_RESPONSE] = Response.json(responseBody, {
            headers: { "content-type": "application/json", ...responseHeaders },
        });
    }
    return stubRoutes(routes);
}

function stubInferenceport(jobBody: unknown) {
    return stubRoutes({
        "https://api.inferenceport.ai/v1/3d/generations": Response.json(
            { job_id: "job_1" },
            { status: 202 },
        ),
        "https://api.inferenceport.ai/v1/3d/jobs/job_1": Response.json(
            jobBody,
        ),
    });
}

describe("model3d post-paid failure settlement (issue 72 residuals)", () => {
    it("I1: InferencePort completed with an invalid charge still settles", async () => {
        stubInferenceport({
            status: "completed",
            usage: { payg_credits_charged: -5 },
            data: [{ model_glb_b64_bytes: "abc" }],
        });
        await expectBilled(
            () => callTrellis2(params()),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("I2: InferencePort completed without output still settles", async () => {
        stubInferenceport({ status: "completed", data: [{}] });
        await expectBilled(
            () => callTrellis2(params()),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("I3: trellis-2 completed with PLY but no GLB still settles", async () => {
        stubInferenceport({
            status: "completed",
            usage: { payg_credits_charged: 0.29 },
            data: [{ model_ply_b64_bytes: "cGx5" }],
        });
        await expectBilled(
            () => callTrellis2(params()),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("I4: asset-harvester completed without PLY still settles", async () => {
        stubInferenceport({
            status: "completed",
            data: [{ model_glb_b64_bytes: "abc" }],
        });
        await expectBilled(
            () =>
                callAssetHarvester(
                    params({ model: "nvidia/asset-harvester" }),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("R1: rodin completed without a mesh still settles", async () => {
        falQueue("fal-ai/hyper3d/rodin/v2.5/text-to-3d/fast", {});
        await expectBilled(
            () =>
                runFal(() =>
                    callRodinFalAPI("a low-poly fox", params({ image: [] })),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("R2: rodin result fetch failing after COMPLETED still settles", async () => {
        falQueue("fal-ai/hyper3d/rodin/v2.5/text-to-3d/fast", null, {}, {
            [FAL_RESPONSE]: new Response("gone", { status: 500 }),
        });
        await expectBilled(
            () =>
                runFal(() =>
                    callRodinFalAPI("a low-poly fox", params({ image: [] })),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("R3: rodin mesh download failing still settles", async () => {
        falQueue(
            "fal-ai/hyper3d/rodin/v2.5/text-to-3d/fast",
            { model_mesh: { url: "https://v3.fal.media/x.glb" } },
            {},
            { "https://v3.fal.media/x.glb": new Response("boom", { status: 500 }) },
        );
        await expectBilled(
            () =>
                runFal(() =>
                    callRodinFalAPI("a low-poly fox", params({ image: [] })),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("T1: trellis-2:fal completed without a mesh still settles", async () => {
        falQueue("fal-ai/trellis-2", {});
        await expectBilled(
            () =>
                runFal(() =>
                    callTrellis2Fal(params({ model: "microsoft/trellis-2:fal" })),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("T2: trellis-2:fal mesh download failing still settles", async () => {
        falQueue(
            "fal-ai/trellis-2",
            { model_glb: { url: "https://v3.fal.media/t.glb" } },
            {},
            { "https://v3.fal.media/t.glb": new Response("boom", { status: 500 }) },
        );
        await expectBilled(
            () =>
                runFal(() =>
                    callTrellis2Fal(params({ model: "microsoft/trellis-2:fal" })),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 1 }),
        );
    });

    it("P1: tripo3d/p2 mesh download failing settles the reported units", async () => {
        falQueue(
            "tripo3d/p2/text-to-3d",
            { model_mesh: { url: "https://v3.fal.media/p.glb" } },
            { "x-fal-billable-units": "220" },
            { "https://v3.fal.media/p.glb": new Response("boom", { status: 500 }) },
        );
        await expectBilled(
            () =>
                runFal(() =>
                    callTripoP2(
                        "a chair",
                        params({ model: "tripo3d/p2", image: [] }),
                    ),
                ),
            502,
            (billedUsage) =>
                expect(billedUsage).toEqual({ completionImageTokens: 2 }),
        );
    });

    it("H1: empty provider response settles the model's own usage", () => {
        const empty = (trackingData?: Model3dGenerationResult["trackingData"]) =>
            ({
                buffer: Buffer.alloc(0),
                contentType: "model/gltf-binary",
                ...(trackingData ? { trackingData } : {}),
            }) as Model3dGenerationResult;

        try {
            assertNonEmptyMedia(
                empty({
                    actualModel: "m",
                    usage: { completionImageTokens: 2 },
                }),
            );
            expect.unreachable("expected the call to throw");
        } catch (error) {
            expect(error).toBeInstanceOf(UpstreamError);
            const upstream = error as UpstreamError & {
                billedUsage?: Record<string, number>;
            };
            expect(upstream.billedUsage).toEqual({
                completionImageTokens: 2,
            });
        }

        try {
            assertNonEmptyMedia(empty());
            expect.unreachable("expected the call to throw");
        } catch (error) {
            expect(error).toBeInstanceOf(UpstreamError);
            const upstream = error as UpstreamError & {
                billedUsage?: Record<string, number>;
            };
            // Providers without tracking data settle at the handler's
            // default flat 3D unit, matching mediaHeaders.
            expect(upstream.billedUsage).toEqual({
                completionImageTokens: 1,
            });
        }
    });
});

import { UpstreamError } from "@shared/error.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncImageEnv } from "../../src/image/env.ts";
import { callAlibabaImage } from "../../src/image/models/alibabaImageModel.ts";
import { callAlibabaVideo } from "../../src/image/models/alibabaVideoModel.ts";
import { callAzureFlux2 } from "../../src/image/models/azureFluxKontextModel.ts";
import { callAzureMaiImage } from "../../src/image/models/azureMaiImageModel.ts";
import { callInferencePortImage } from "../../src/image/models/inferencePortImageModel.ts";
import {
    callOpenRouterMaiImageAPI,
    callOpenRouterSeedreamFlashAPI,
} from "../../src/image/models/openRouterImageModel.ts";
import { callVercelGeminiImageAPI } from "../../src/image/models/vercelGeminiImageModel.ts";
import { callVertexAIGeminiImageAPI } from "../../src/image/models/vertexAIGeminiImageModel.ts";
import type { ImageParams } from "../../src/image/params.ts";
import googleCloudAuth from "../../src/text/auth/googleCloudAuth.ts";
import { mockImageProviderFetch } from "./mockImageProviderFetch.ts";

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

async function expectBilled(
    fn: () => Promise<unknown>,
    check: (error: UpstreamError & { billedUsage?: unknown }) => void,
) {
    try {
        await fn();
        expect.unreachable("expected the call to throw");
    } catch (error) {
        expect(error).toBeInstanceOf(UpstreamError);
        check(error as UpstreamError & { billedUsage?: unknown });
    }
}

function json(body: unknown, headers: Record<string, string> = {}) {
    return Response.json(body, {
        headers: { "content-type": "application/json", ...headers },
    });
}

function stubFetch(
    route: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
    vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) =>
        route(
            new URL(input instanceof Request ? input.url : String(input)),
            init,
        )) as typeof fetch);
}

/** Queue sleeps resolve immediately so polls don't stall. */
beforeEach(() => {
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
        fn: () => void,
        _ms?: number,
    ) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("usage-guard settlement sweep (the issue-82 named residual)", () => {
    it("A1: Alibaba video duration guard settles requested seconds + reported input", async () => {
        syncImageEnv({ DASHSCOPE_API_KEY: "test-key" } as CloudflareBindings, [
            "DASHSCOPE_API_KEY",
        ]);
        stubFetch((url) => {
            if (url.pathname.endsWith("/video-synthesis")) {
                return json({
                    output: { task_id: "task-1", task_status: "PENDING" },
                });
            }
            if (url.pathname.includes("/tasks/task-1")) {
                // SUCCEEDED (billed) with the video in hand but no output
                // duration in the receipt.
                return json({
                    output: {
                        task_status: "SUCCEEDED",
                        video_url: "https://cdn.example.com/v.mp4",
                    },
                    usage: { input_video_duration: 3 },
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callAlibabaVideo("a dog", baseParams("alibaba/wan-3.0"), "3.0"),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.message).toContain(
                    "invalid output video duration",
                );
                expect(error.billedUsage).toEqual({
                    completionVideoSeconds: 5,
                    promptVideoSeconds: 3,
                });
            },
        );
    });

    it("A2: Alibaba image count guard settles the flat request quantity", async () => {
        syncImageEnv({ DASHSCOPE_API_KEY: "test-key" } as CloudflareBindings, [
            "DASHSCOPE_API_KEY",
        ]);
        stubFetch((url) => {
            if (url.pathname.endsWith("/generation")) {
                return json({
                    output: { task_id: "task-3", task_status: "PENDING" },
                });
            }
            if (url.pathname.includes("/tasks/task-3")) {
                // SUCCEEDED with the image URL in hand; output_image_count
                // is unusable, input_image_count is readable.
                return json({
                    output: {
                        task_status: "SUCCEEDED",
                        choices: [
                            {
                                message: {
                                    content: [
                                        {
                                            image: "https://cdn.example.com/i.png",
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                    usage: { input_image_count: 3 },
                });
            }
            return new Response("unexpected", { status: 404 });
        });
        await expectBilled(
            () =>
                callAlibabaImage(
                    "a dog",
                    baseParams("qwen/qwen-image-3"),
                    "qwen-image-3.0-pro",
                ),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.message).toContain("invalid output image count");
                expect(error.billedUsage).toEqual({
                    promptImageTokens: 3,
                    completionImageTokens: 1,
                });
            },
        );
    });

    it("B1: Azure MAI delivered image with unusable receipt settles input legs plus the published output schedule", async () => {
        syncImageEnv(
            { AZURE_MYCELI_PROD_API_KEY: "test-key" } as CloudflareBindings,
            ["AZURE_MYCELI_PROD_API_KEY"],
        );
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockImplementation((input) => {
            const url = new URL(
                input instanceof Request ? input.url : String(input),
            );
            if (url.pathname.startsWith("/mai/v1/images/")) {
                return Promise.resolve(
                    json({
                        data: [
                            { b64_json: Buffer.from("png").toString("base64") },
                        ],
                        usage: {
                            num_input_text_tokens: 12,
                            num_input_image_tokens: 0,
                        },
                    }),
                );
            }
            return Promise.resolve(new Response("unexpected", { status: 404 }));
        });
        await expectBilled(
            () =>
                callAzureMaiImage(
                    "a dog",
                    baseParams("microsoft/mai-image-2.7-flash"),
                    {
                        id: "user-1",
                        type: "api_key",
                        apiKey: { id: "key-1" },
                    } as never,
                ),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.message).toContain("no billing metadata");
                expect(error.billedUsage).toEqual({
                    promptTextTokens: 12,
                    // 2.7-Flash: $10 per 1,000 images at $10/M output →
                    // 1,000 tokens per delivered image (Microsoft, 2026-11).
                    completionImageTokens: 1000,
                });
            },
        );
    });

    it("B1b: Azure MAI delivered image with no receipt at all settles the published output schedule", async () => {
        syncImageEnv(
            { AZURE_MYCELI_PROD_API_KEY: "test-key" } as CloudflareBindings,
            ["AZURE_MYCELI_PROD_API_KEY"],
        );
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockImplementation((input) => {
            const url = new URL(
                input instanceof Request ? input.url : String(input),
            );
            if (url.pathname.startsWith("/mai/v1/images/")) {
                return Promise.resolve(
                    json({
                        data: [
                            {
                                b64_json: Buffer.from("png").toString("base64"),
                            },
                        ],
                    }),
                );
            }
            return Promise.resolve(new Response("unexpected", { status: 404 }));
        });
        await expectBilled(
            () =>
                callAzureMaiImage(
                    "a dog",
                    baseParams("microsoft/mai-image-2.7"),
                    {
                        id: "user-1",
                        type: "api_key",
                        apiKey: { id: "key-1" },
                    } as never,
                ),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.billedUsage).toEqual({
                    // 2.7: $35 per 1,000 images at $34/M output → 1,030.
                    completionImageTokens: 1030,
                });
            },
        );
    });

    it("B1c: Azure MAI 2.6-Flash settles its own measured per-image schedule", async () => {
        syncImageEnv(
            { AZURE_MYCELI_PROD_API_KEY: "test-key" } as CloudflareBindings,
            ["AZURE_MYCELI_PROD_API_KEY"],
        );
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockImplementation((input) => {
            const url = new URL(
                input instanceof Request ? input.url : String(input),
            );
            if (url.pathname.startsWith("/mai/v1/images/")) {
                return Promise.resolve(
                    json({
                        data: [
                            {
                                b64_json: Buffer.from("png").toString("base64"),
                            },
                        ],
                        usage: {
                            num_input_text_tokens: 30,
                            num_input_image_tokens: 8,
                        },
                    }),
                );
            }
            return Promise.resolve(new Response("unexpected", { status: 404 }));
        });
        await expectBilled(
            () =>
                callAzureMaiImage(
                    "a dog",
                    baseParams("microsoft/mai-image-2.6-flash"),
                    {
                        id: "user-1",
                        type: "api_key",
                        apiKey: { id: "key-1" },
                    } as never,
                ),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.billedUsage).toEqual({
                    promptTextTokens: 30,
                    promptImageTokens: 8,
                    // 2.6 Flash: $19.46 per 1,000 images at $19/M → 1,024.
                    completionImageTokens: 1024,
                });
            },
        );
    });

    it("B2: Azure FLUX.2 delivered image without request_meta settles requested megapixels", async () => {
        syncImageEnv(
            { AZURE_MYCELI_PROD_API_KEY: "test-key" } as CloudflareBindings,
            ["AZURE_MYCELI_PROD_API_KEY"],
        );
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockImplementation((input) => {
            const url = new URL(
                input instanceof Request ? input.url : String(input),
            );
            if (url.pathname.includes("/flux-2-pro")) {
                return Promise.resolve(
                    json({
                        data: [
                            {
                                b64_json: Buffer.from("png").toString("base64"),
                            },
                        ],
                        // request_meta absent.
                    }),
                );
            }
            return Promise.resolve(new Response("unexpected", { status: 404 }));
        });
        await expectBilled(
            () =>
                callAzureFlux2(
                    "a dog",
                    baseParams("black-forest-labs/flux.2-pro"),
                    { id: "user-1", type: "api_key" } as never,
                ),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.message).toContain("no billing metadata");
                expect(error.billedUsage).toEqual({
                    completionImageTokens: 2,
                });
            },
        );
    });

    it("C1: Vercel Gemini image delivered with unusable receipt settles the reported legs through the rewrap", async () => {
        syncImageEnv({ AI_GATEWAY_API_KEY: "test-key" } as CloudflareBindings, [
            "AI_GATEWAY_API_KEY",
        ]);
        stubFetch(() =>
            json({
                choices: [
                    {
                        finish_reason: "stop",
                        message: {
                            images: [
                                {
                                    image_url: {
                                        url: "data:image/png;base64,AAA",
                                    },
                                },
                            ],
                            provider_metadata: {
                                google: {
                                    usageMetadata: {
                                        promptTokenCount: 9,
                                        candidatesTokenCount: 120,
                                    },
                                },
                            },
                        },
                    },
                ],
                usage: { prompt_tokens: 9, completion_tokens: 120 },
                // cost missing -> the guard fires.
            }),
        );
        await expectBilled(
            () =>
                callVercelGeminiImageAPI(
                    "a dog",
                    baseParams("google/gemini-nano-banana-2.1:vercel"),
                ),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.message).toContain("invalid image billing usage");
                expect(error.billedUsage).toEqual({
                    promptTextTokens: 9,
                    completionTextTokens: 120,
                });
            },
        );
    });

    it("D1: Vertex Gemini image delivered with malformed usageMetadata settles top-level counts", async () => {
        syncImageEnv(
            { GOOGLE_PROJECT_ID: "test-project" } as CloudflareBindings,
            ["GOOGLE_PROJECT_ID"],
        );
        vi.spyOn(googleCloudAuth, "getAccessToken").mockResolvedValue(
            "test-token",
        );
        stubFetch(() =>
            json({
                candidates: [
                    {
                        content: {
                            parts: [
                                {
                                    inlineData: {
                                        mimeType: "image/png",
                                        data: Buffer.from("png").toString(
                                            "base64",
                                        ),
                                    },
                                },
                            ],
                        },
                    },
                ],
                // usageMetadata present but without modality details -> the
                // mapper rejects it after the image was delivered.
                usageMetadata: {
                    promptTokenCount: 15,
                    candidatesTokenCount: 200,
                    totalTokenCount: 215,
                },
            }),
        );
        await expectBilled(
            () =>
                callVertexAIGeminiImageAPI(
                    "a dog",
                    baseParams("google/gemini-2.5-flash-image"),
                ),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.message).toContain(
                    "invalid image billing usage metadata",
                );
                expect(error.billedUsage).toEqual({
                    promptTextTokens: 15,
                    completionTextTokens: 200,
                });
            },
        );
    });

    it("E1: OpenRouter Seedream Flash delivered image without a cost receipt settles one image", async () => {
        syncImageEnv({ OPENROUTER_API_KEY: "test-key" } as CloudflareBindings, [
            "OPENROUTER_API_KEY",
        ]);
        stubFetch(() =>
            json({
                data: [{ b64_json: Buffer.from("png").toString("base64") }],
                usage: {},
            }),
        );
        await expectBilled(
            () =>
                callOpenRouterSeedreamFlashAPI(
                    "a dog",
                    baseParams("bytedance/seedream-5.0-flash"),
                ),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.billedUsage).toEqual({ completionImageTokens: 1 });
            },
        );
    });

    it("E2: OpenRouter MAI image with unusable completion receipt settles the prompt leg", async () => {
        syncImageEnv(
            {
                OPENROUTER_API_KEY: "test-key",
                AZURE_MYCELI_PROD_API_KEY: "k",
            } as CloudflareBindings,
            ["OPENROUTER_API_KEY", "AZURE_MYCELI_PROD_API_KEY"],
        );
        const providerFetch = mockImageProviderFetch();
        providerFetch.mockImplementation(() =>
            Promise.resolve(
                json({
                    data: [{ b64_json: Buffer.from("png").toString("base64") }],
                    usage: { prompt_tokens: 7 },
                }),
            ),
        );
        await expectBilled(
            () =>
                callOpenRouterMaiImageAPI(
                    "a dog",
                    baseParams("microsoft/mai-image-2.7"),
                    {
                        id: "user-1",
                        type: "api_key",
                    } as never,
                ),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.billedUsage).toEqual({ promptTextTokens: 7 });
            },
        );
    });

    it("I1: InferencePort image delivered without a receipt settles one image", async () => {
        syncImageEnv(
            { INFERENCEPORT_API_KEY: "test-key" } as CloudflareBindings,
            ["INFERENCEPORT_API_KEY"],
        );
        stubFetch(() =>
            json({
                data: [{ b64_json: Buffer.from("png").toString("base64") }],
            }),
        );
        await expectBilled(
            () =>
                callInferencePortImage(
                    "a dog",
                    baseParams("inferenceport-ai/lightning-image-turbo"),
                    { id: "user-1", type: "api_key" } as never,
                ),
            (error) => {
                expect(error.status).toBe(502);
                expect(error.billedUsage).toEqual({ completionImageTokens: 1 });
            },
        );
    });
});

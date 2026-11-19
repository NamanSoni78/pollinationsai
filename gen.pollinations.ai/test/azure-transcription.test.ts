import { UpstreamError } from "@shared/error.ts";
import { getPriceDefinitionForModel, getRegistryModelDefinition } from "@shared/registry/registry.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackResponse } from "../src/middleware/track.ts";
import { transcribeMai } from "../src/audio/mai-transcription.ts";
import { transcribeWithAzure } from "../src/routes/audio.ts";

describe("transcribeWithAzure", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("forwards OpenAI transcription options and bills provider duration", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(
            Response.json({
                text: "hello from Azure",
                usage: { type: "duration", seconds: 60 },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const response = await transcribeWithAzure({
            file: new File(["audio"], "audio.wav", { type: "audio/wav" }),
            language: "en",
            prompt: "Pollinations",
            responseFormat: "json",
            temperature: 0.2,
            apiKey: "test-key",
        });

        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(
            "https://myceli-prod-swedencentral.openai.azure.com/openai/deployments/test-gpt-transcribe/audio/transcriptions?api-version=2025-04-01-preview",
        );
        expect(init.headers).toEqual({ "api-key": "test-key" });
        const form = init.body as FormData;
        expect(form.get("model")).toBe("gpt-transcribe");
        expect(form.get("language")).toBe("en");
        expect(form.get("prompt")).toBe("Pollinations");
        expect(form.get("response_format")).toBe("json");
        expect(form.get("temperature")).toBe("0.2");
        expect(form.get("file")).toBeInstanceOf(File);

        expect(response.headers.get("x-model-used")).toBe(
            "openai/gpt-transcribe",
        );
        expect(response.headers.get("x-usage-prompt-audio-seconds")).toBe("60");
        await expect(response.json()).resolves.toEqual({
            text: "hello from Azure",
            usage: { type: "duration", seconds: 60 },
        });
    });

    it("answers text from Azure's json, which carries the billed duration", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(
            Response.json({
                text: "hello from Azure",
                usage: { type: "duration", seconds: 60 },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const response = await transcribeWithAzure({
            file: new File(["audio"], "audio.wav"),
            responseFormat: "text",
            apiKey: "test-key",
        });

        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect((init.body as FormData).get("response_format")).toBe("json");
        expect(response.headers.get("content-type")).toBe(
            "text/plain; charset=utf-8",
        );
        expect(response.headers.get("x-usage-prompt-audio-seconds")).toBe("60");
        expect(await response.text()).toBe("hello from Azure");
    });

    it("rejects unsupported response formats before calling Azure", async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        await expect(
            transcribeWithAzure({
                file: new File(["audio"], "audio.wav"),
                responseFormat: "verbose_json",
                apiKey: "test-key",
            }),
        ).rejects.toMatchObject({ status: 400 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("fails closed when Azure omits duration metering", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValueOnce(
                Response.json({
                    text: "hello",
                    usage: { type: "duration" },
                }),
            ),
        );

        await expect(
            transcribeWithAzure({
                file: new File(["audio"], "audio.wav"),
                apiKey: "test-key",
            }),
        ).rejects.toMatchObject({ status: 502 });
    });
});

describe("MAI request validation", () => {
    it.each([
        { responseFormat: "srt" },
        { responseFormat: "vtt" },
        { responseFormat: "diarized_json" },
        { language: "en" },
        { prompt: "vocabulary hint" },
        { temperature: 0.2 },
    ])(
        "rejects unsupported controls before any provider call: %j",
        async (options) => {
            // An absent credential proves validation runs before provider access.
            await expect(
                transcribeMai({
                    file: new File(["audio"], "audio.wav", {
                        type: "audio/wav",
                    }),
                    modelId: "microsoft/mai-transcribe-2",
                    apiKey: "",
                    ...options,
                }),
            ).rejects.toMatchObject({ status: 400 });
        },
    );
});

describe("transcription post-charge settlement and upstream deadlines", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it("preserves billedUsage and passes an AbortSignal when Azure GPT omits text after returning duration", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(
            Response.json({
                usage: { type: "duration", seconds: 42 },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const caught = await transcribeWithAzure({
            file: new File(["audio"], "audio.wav"),
            apiKey: "test-key",
        }).catch((err: unknown) => err);

        expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(
            AbortSignal,
        );
        expect(caught).toBeInstanceOf(UpstreamError);
        expect(caught).toMatchObject({
            status: 502,
            billedUsage: { promptAudioSeconds: 42 },
        });
    });

    it("preserves providerBilling and billedUsage on Vercel Gateway MAI schema failure and settles via trackResponse", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(
            Response.json({
                // Silent audio or malformed payload after Vercel Gateway billed the request
                durationInSeconds: 0,
                providerMetadata: { gateway: { cost: "0.0042" } },
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const caught = await transcribeMai({
            file: new File(["audio"], "audio.wav", { type: "audio/wav" }),
            modelId: "microsoft/mai-transcribe-2:vercel",
            apiKey: "gw-key",
        }).catch((err: unknown) => err);

        expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(
            AbortSignal,
        );
        expect(caught).toBeInstanceOf(UpstreamError);
        expect(caught).toMatchObject({
            status: 502,
            providerBilling: { units: 0.0042, unitCost: 1 },
        });

        const servedDef = getRegistryModelDefinition(
            "microsoft/mai-transcribe-2:vercel",
        );
        const tracking = await trackResponse(
            "generate.audio",
            {
                modelRequested: "microsoft/mai-transcribe-2:vercel",
                resolvedModelRequested: "microsoft/mai-transcribe-2:vercel",
                modelProvider: "vercel",
                modelDefinition: servedDef,
                modelCostDefinition: servedDef.cost,
                modelPriceDefinition: getPriceDefinitionForModel(servedDef),
                streamRequested: false,
                referrerData: {},
            },
            new Response(null, { status: 502 }),
            {
                id: "microsoft/mai-transcribe-2:vercel",
                definition: servedDef,
            },
            undefined,
            caught,
        );
        expect(tracking.isBilledUsage).toBe(true);
        expect(tracking.cost?.totalCost).toBeCloseTo(0.0042, 8);
        expect(tracking.price?.totalPrice).toBeGreaterThan(0);
    });

    it("preserves billedUsage and passes an AbortSignal on Azure MAI schema failure after duration metering", async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(
            Response.json({
                durationMilliseconds: 15_000,
                // missing combinedPhrases triggers schema failure after charge
            }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const caught = await transcribeMai({
            file: new File(["audio"], "audio.wav", { type: "audio/wav" }),
            modelId: "microsoft/mai-transcribe-2",
            apiKey: "azure-key",
        }).catch((err: unknown) => err);

        expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(
            AbortSignal,
        );
        expect(caught).toBeInstanceOf(UpstreamError);
        expect(caught).toMatchObject({
            status: 502,
            billedUsage: { promptAudioSeconds: 15 },
        });
    });

    it("maps malformed MAI JSON to a 502 UpstreamError instead of raw SyntaxError", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValueOnce(
                new Response("not-json", { status: 200 }),
            ),
        );

        const caught = await transcribeMai({
            file: new File(["audio"], "audio.wav", { type: "audio/wav" }),
            modelId: "microsoft/mai-transcribe-2:vercel",
            apiKey: "gw-key",
        }).catch((err: unknown) => err);

        expect(caught).toBeInstanceOf(UpstreamError);
        expect(caught).toMatchObject({ status: 502 });
    });
});

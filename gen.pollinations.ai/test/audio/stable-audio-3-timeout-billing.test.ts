import { env } from "cloudflare:test";
import { UpstreamError } from "@shared/error.ts";
import {
    getRegistryModelDefinition,
    getPriceDefinitionForModel,
} from "@shared/registry/registry.ts";
import { parseUsageHeaders } from "@shared/registry/usage-headers.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FallbackCandidate } from "../../src/fallback.ts";
import { trackResponse } from "../../src/middleware/track.ts";
import { generateStableAudio3Large } from "../../src/routes/audio.ts";

const SUBMIT_URL =
    "https://api.stability.ai/v2beta/audio/stable-audio/text-to-audio";
const RESULTS_URL = "https://api.stability.ai/v2beta/results/sa3-r17-id";

const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
} as never;

const opts = {
    prompt: "A slow ambient pad",
    seconds: 30,
    responseFormat: "mp3",
    apiKey: "test-stability-key",
    log,
} as const;

const realSetTimeout = globalThis.setTimeout;
const realNow = Date.now;

afterEach(() => {
    vi.restoreAllMocks();
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout =
        realSetTimeout;
});

// Submit is accepted (202 + id): Stability has charged the flat 26-credit
// generation fee at this point. Polls then never finish within the window.
function stubStability(opts: { result: "rendering" | "audio" }) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
        async (input, init) => {
            const url = String(
                input instanceof Request ? input.url : (input as string),
            );
            if (init?.method === "POST" && url === SUBMIT_URL) {
                return Response.json({ id: "sa3-r17-id" }, { status: 202 });
            }
            if (url === RESULTS_URL) {
                if (opts.result === "rendering") clockJumped = true;
                return opts.result === "audio"
                    ? new Response(new Uint8Array([1, 2, 3]), {
                          status: 200,
                          headers: { "content-type": "audio/mpeg" },
                      })
                    : new Response("still rendering", { status: 202 });
            }
            throw new Error(`unexpected fetch: ${init?.method} ${url}`);
        },
    );
}

// Flips after the first poll so Date.now() jumps past the 180s window.
let clockJumped = false;

function trackingFixture() {
    const model = "stability-ai/stable-audio-3" as never;
    const definition = getRegistryModelDefinition(model);
    const modelCostDefinition = definition.cost;
    const modelPriceDefinition = getPriceDefinitionForModel(definition);
    if (!modelCostDefinition || !modelPriceDefinition) {
        throw new Error("Missing cost/price definition for stable-audio-3");
    }
    return {
        modelRequested: model,
        resolvedModelRequested: model,
        modelProvider: definition.provider,
        modelDefinition: definition,
        modelCostDefinition,
        modelPriceDefinition,
        streamRequested: false,
        referrerData: {},
    };
}

function candidateFixture(): FallbackCandidate {
    return {
        id: "stability-ai/stable-audio-3" as never,
        definition: getRegistryModelDefinition(
            "stability-ai/stable-audio-3" as never,
        ),
    };
}

describe("Round 17 lead C: Stable Audio 3 Large poll abandonment is billed", () => {
    it("settles the flat generation fee when the 180s poll window expires", async () => {
        clockJumped = false;
        stubStability({ result: "rendering" });
        // Poll sleeps resolve immediately; the clock jumps past the 180s
        // window after the first poll (the issue-25 S1 time-travel pattern).
        vi.spyOn(Date, "now").mockImplementation(() =>
            clockJumped ? realNow() + 185_000 : realNow(),
        );
        (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((
            fn: () => void,
        ) => realSetTimeout(fn, 0)) as unknown as typeof setTimeout;

        let error: unknown;
        try {
            await generateStableAudio3Large({ ...opts });
            expect.unreachable("expected the poll timeout to throw");
        } catch (thrown) {
            error = thrown;
        }
        expect(error).toBeInstanceOf(UpstreamError);
        const upstream = error as UpstreamError;
        // The response stays a 504: the job was accepted and paid for, we
        // just abandoned polling it.
        expect(upstream.status).toBe(504);
        // RED on unpatched HEAD: the submit was billed by Stability, and the
        // flat usage the success path settles (one completion audio unit)
        // is fully known at the throw site, but the throw carries no usage,
        // so track charges the caller nothing.
        expect(upstream.billedUsage).toEqual({ completionAudioTokens: 1 });
    });

    it("control: a finished poll bills exactly one flat completion audio unit", async () => {
        const fetchSpy = stubStability({ result: "audio" });
        const response = await generateStableAudio3Large({ ...opts });
        expect(response.status).toBe(200);
        // The same flat unit the timeout path must settle.
        expect(parseUsageHeaders(response.headers)).toMatchObject({
            completionAudioTokens: 1,
        });
        const submit = new Request(
            fetchSpy.mock.calls[0][0],
            fetchSpy.mock.calls[0][1],
        );
        expect(submit.url).toBe(SUBMIT_URL);
        expect(submit.headers.get("authorization")).toBe(
            "Bearer test-stability-key",
        );
    });

    it("control: trackResponse settles a billedUsage-carrying 504 at the flat $0.26 cost", async () => {
        const error = new UpstreamError(504 as never, {
            message: "Stable Audio 3 Large generation timed out",
            billedUsage: { completionAudioTokens: 1 },
        });
        const tracking = await trackResponse(
            "generate.audio",
            trackingFixture(),
            new Response(null, { status: 504 }),
            candidateFixture(),
            undefined,
            error,
        );
        expect(tracking).toMatchObject({
            responseStatus: 504,
            isBilledUsage: true,
        });
        expect(tracking.cost?.totalCost).toBeCloseTo(0.26, 12);
        expect(tracking.usage).toEqual({ completionAudioTokens: 1 });
    });

    it("documents the unpatched settlement loss: the raw 504 bills nothing", async () => {
        // On unpatched HEAD the thrown 504 has no billedUsage, so the
        // settlement middleware records isBilledUsage: false — the platform
        // eats the 26 credits Stability charged at submit.
        const error = new UpstreamError(504 as never, {
            message: "Stable Audio 3 Large generation timed out",
        });
        const tracking = await trackResponse(
            "generate.audio",
            trackingFixture(),
            new Response(null, { status: 504 }),
            candidateFixture(),
            undefined,
            error,
        );
        expect(tracking).toMatchObject({
            responseStatus: 504,
            isBilledUsage: false,
        });
    });

    it("env sanity: the registry prices the model as a flat 0.26 completion unit", () => {
        const definition = getRegistryModelDefinition(
            "stability-ai/stable-audio-3" as never,
        );
        expect(definition.cost?.completionAudioTokens).toBeCloseTo(0.26, 12);
        expect(definition.provider).toBe("stability");
        expect(env.ENVIRONMENT).toBeDefined();
    });
});

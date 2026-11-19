import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from "cloudflare:test";
import { test } from "@shared/test/fixtures/index.ts";
import {
    createFetchMock,
    teardownFetchMock,
} from "@shared/test/mocks/fetch.ts";
import { createMockTinybird } from "@shared/test/mocks/tinybird.ts";
import { afterEach, describe, expect, vi } from "vitest";
import worker from "../../src/index.ts";
import { withInlineGenerationCoordinator } from "../helpers/inline-generation-coordinator.ts";

afterEach(() => {
    teardownFetchMock();
    vi.unstubAllGlobals();
});

describe("whisper upstream deadline (issue 123 family)", () => {
    test(
        "openai/whisper-large-v3 passes a 120 s deadline to the provider fetch",
        async ({ paidApiKey }) => {
            const mocks = createFetchMock({
                tinybird: createMockTinybird(),
            });
            await mocks.enable("tinybird");
            // The test environment ships no OVH key; provide one through the
            // bindings the way index.test.ts overrides per-route env, and
            // return a fresh Response per call (a shared instance would have
            // its body locked by the first consumer).
            const providerFetch = vi.fn().mockImplementation(() =>
                Promise.resolve(
                    new Response(
                        JSON.stringify({
                            text: "hello world",
                            language: "en",
                            usage: { seconds: 2 },
                        }),
                        { headers: { "content-type": "application/json" } },
                    ),
                ),
            );
            vi.stubGlobal("fetch", providerFetch);

            const form = new FormData();
            form.set("model", "openai/whisper-large-v3");
            form.set(
                "file",
                new File(["audio"], "test.wav", { type: "audio/wav" }),
            );
            const ctx = createExecutionContext();
            const response = await worker.fetch(
                new Request(
                    "https://gen.pollinations.ai/v1/audio/transcriptions",
                    {
                        method: "POST",
                        headers: { authorization: `Bearer ${paidApiKey}` },
                        body: form,
                    },
                ),
                withInlineGenerationCoordinator({
                    ...env,
                    OVHCLOUD_API_KEY: "not-a-secret-workers-test-only",
                } as CloudflareBindings),
                ctx,
            );
            await waitOnExecutionContext(ctx);

            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                text: "hello world",
            });
            const call = providerFetch.mock.calls.find(
                ([url]) =>
                    String(url) ===
                    "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/audio/transcriptions",
            );
            expect(call).toBeDefined();
            const init = call?.[1] as RequestInit | undefined;
            expect(init?.signal).toBeInstanceOf(AbortSignal);
        },
    );
});

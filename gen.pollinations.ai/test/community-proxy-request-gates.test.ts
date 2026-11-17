import type { ProxyCommunityEndpointRuntime } from "@shared/community-endpoints.ts";
import {
    communityModelDefinition,
    communityEndpointPrices,
} from "@shared/community-endpoints.ts";
import { describe, expect, it } from "vitest";
import { textCapabilityError } from "@/text/fallbackCompatibility.ts";

function createProxyEndpoint(
    overrides: Partial<ProxyCommunityEndpointRuntime> = {},
): ProxyCommunityEndpointRuntime {
    return {
        id: "community-endpoint-test",
        ownerUserId: "owner-1",
        modelId: "test-owner/test-model",
        api: "chat_completions",
        name: "test-model",
        title: "Test Model",
        description: null,
        type: "proxy",
        modality: "text",
        imagePricing: "request",
        inputModalities: ["text", "image"],
        baseUrl: "https://community.example.test/openai/chat/completions",
        upstreamModel: "upstream-test-model",
        bearerTokenCiphertext: "encrypted",
        visibility: "public",
        paidOnly: false,
        perUserRpm: null,
        fallbacks: [],
        ...communityEndpointPrices({
            promptTextPrice: 0.0001,
            completionTextPrice: 0.0002,
        }),
        ...overrides,
    };
}

const proxy = createProxyEndpoint();
const definition = communityModelDefinition(proxy);
const messages = [{ role: "user", content: "hi" }];

describe("community proxy request gates at the billing ceilings", () => {
    it("rejects a completion budget above the billable ceiling", () => {
        for (const key of [
            "max_tokens",
            "max_completion_tokens",
            "max_output_tokens",
        ]) {
            expect(
                textCapabilityError(definition, {
                    messages,
                    [key]: 200_001,
                }, proxy),
            ).toContain("output tokens");
            expect(
                textCapabilityError(definition, { messages, [key]: 250_001 }, proxy),
            ).toContain("output tokens");
        }
    });

    it("accepts a completion budget at or below the ceiling", () => {
        for (const key of [
            "max_tokens",
            "max_completion_tokens",
            "max_output_tokens",
        ]) {
            expect(
                textCapabilityError(definition, { messages, [key]: 200_000 }, proxy),
            ).toBeUndefined();
            expect(
                textCapabilityError(definition, { messages, [key]: 1000 }, proxy),
            ).toBeUndefined();
        }
    });

    it("leaves non-community models unbounded by the proxy ceiling", () => {
        // No communityEndpoint argument: an official model with no declared
        // maximum keeps its OpenAI-compatible semantics.
        expect(
            textCapabilityError(
                { ...definition, maxCompletionTokens: undefined },
                { messages, max_tokens: 250_001 },
            ),
        ).toBeUndefined();
        expect(
            textCapabilityError(
                { ...definition, maxCompletionTokens: 300_000 },
                { messages, max_tokens: 250_001 },
            ),
        ).toBeUndefined();
    });

    it("rejects a prompt estimated above the billable ceiling", () => {
        const bigPrompt = "x".repeat(9_000_000); // ~2.25M tokens at 4 chars/token
        expect(
            textCapabilityError(
                definition,
                { messages: [{ role: "user", content: bigPrompt }] },
                proxy,
            ),
        ).toContain("prompt tokens");
    });

    it("accepts prompts at or below the ceiling", () => {
        const edgePrompt = "x".repeat(7_900_000); // ~1.98M tokens, comfortably under the ceiling
        expect(
            textCapabilityError(
                definition,
                { messages: [{ role: "user", content: edgePrompt }] },
                proxy,
            ),
        ).toBeUndefined();
        expect(
            textCapabilityError(definition, { messages }, proxy),
        ).toBeUndefined();
    });

    it("does not count image or file payloads as prompt tokens", () => {
        const bigBase64 = "x".repeat(9_000_000);
        expect(
            textCapabilityError(definition, {
                messages: [
                    {
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: { url: `data:image/png;base64,${bigBase64}` },
                            },
                            { type: "text", text: "describe this" },
                        ],
                    },
                ],
            }, proxy),
        ).toBeUndefined();
        expect(
            textCapabilityError(definition, {
                input: [
                    {
                        type: "message",
                        role: "user",
                        content: [
                            { type: "input_image", image_url: bigBase64 },
                            { type: "input_text", text: "describe" },
                        ],
                    },
                ],
            }, proxy),
        ).toBeUndefined();
    });
});

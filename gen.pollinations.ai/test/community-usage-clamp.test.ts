import {
    communityEndpointPrices,
    communityModelDefinition,
} from "@shared/community-endpoints.ts";
import {
    calculateUsageBilling,
    type ModelDefinition,
    type Usage,
} from "@shared/registry/registry.ts";
import { expect, test } from "vitest";

const definition = communityModelDefinition({
    modelId: "community/attacker/proxy",
    title: "Proxy",
    description: null,
    paidOnly: false,
    modality: "text",
    ...communityEndpointPrices({
        promptTextPrice: 50 / 1_000_000, // MAX_COMMUNITY_PRICE_PER_TOKEN
        completionTextPrice: 50 / 1_000_000,
    }),
});

test("publisher-reported token counts are clamped per request", () => {
    // Before the clamp this charged 4.5e17 pollen from one response.
    const usage: Usage = {
        promptTextTokens: 9_007_199_254_740_991, // Number.MAX_SAFE_INTEGER
        completionTextTokens: 0,
    };
    const billing = calculateUsageBilling({
        model: "community/attacker/proxy",
        usage,
        servedBy: definition,
    });
    // 10M tokens x 50 pollen / 1M = 500 pollen, the published-rate cost of
    // the largest request the ceiling admits.
    expect(billing.price.totalPrice).toBe(500);
});

test("legitimate community token usage bills unchanged", () => {
    const usage: Usage = {
        promptTextTokens: 12_345,
        completionTextTokens: 678,
    };
    const billing = calculateUsageBilling({
        model: "community/attacker/proxy",
        usage,
        servedBy: definition,
    });
    expect(billing.price.totalPrice).toBeCloseTo(
        ((12_345 + 678) * 50) / 1_000_000,
        10,
    );
});

test("publisher-reported durations are clamped per request", () => {
    const videoDefinition = communityModelDefinition({
        modelId: "community/attacker/video",
        title: "Video",
        description: null,
        paidOnly: false,
        modality: "video",
        ...communityEndpointPrices({ completionVideoPrice: 0.5 }),
    });
    const billing = calculateUsageBilling({
        model: "community/attacker/video",
        usage: { completionVideoSeconds: 1_000_000_000 },
        servedBy: videoDefinition,
    });
    // 3600s ceiling x 0.5 pollen/s.
    expect(billing.price.totalPrice).toBe(1800);
});

test("trusted-provider usage is never clamped", () => {
    const trusted = {
        ...definition,
        provider: "openai",
    } as ModelDefinition;
    const usage: Usage = {
        promptTextTokens: 9_007_199_254_740_991,
        completionTextTokens: 0,
    };
    const billing = calculateUsageBilling({
        model: "community/attacker/proxy",
        usage,
        servedBy: trusted,
    });
    expect(billing.price.totalPrice).toBeGreaterThan(1e9);
});

test("a community quote against a trusted fallback clamps the invoice", () => {
    const trusted = {
        ...definition,
        provider: "openai",
    } as ModelDefinition;
    const billing = calculateUsageBilling({
        model: "community/attacker/proxy",
        usage: { promptTextTokens: 9_007_199_254_740_991 },
        servedBy: trusted,
        quotedBy: definition,
    });
    expect(billing.price.totalPrice).toBe(500);
});

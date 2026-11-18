import { calculateUsageBilling } from "@shared/registry/registry.ts";
import { TEXT_SERVICES } from "@shared/registry/text.ts";
import { describe, expect, it } from "vitest";

const PRIMARY = "qwen/qwen4-max";
const FALLBACK = "qwen/qwen4-max:vercel";

// The route inherits `inputModalities: ["text", "image"]` from the primary and
// mergeFallbacks replaces the cost sheet wholesale, so the fallback must carry
// the primary's promptImageTokens rate itself. convertUsage bills any reported
// usage type with no rate at $0, and openaiUsageToUsage maps
// prompt_tokens_details.image_tokens to promptImageTokens — image input served
// by the Vercel route would be free.
describe("qwen/qwen4-max:vercel image input billing", () => {
    it("the fallback rate sheet prices promptImageTokens like the primary", () => {
        const primary = TEXT_SERVICES[PRIMARY];
        const fallback = TEXT_SERVICES[FALLBACK];
        expect(primary).toBeDefined();
        expect(fallback).toBeDefined();
        expect(fallback?.inputModalities).toContain("image");
        expect(fallback?.cost.promptImageTokens).toBeDefined();
        expect(fallback?.cost.promptImageTokens).toBe(
            primary?.cost.promptImageTokens,
        );
    });

    it("image input tokens contribute to the billed cost when served by the fallback route", () => {
        const withImages = calculateUsageBilling({
            model: PRIMARY,
            usage: {
                promptTextTokens: 1000,
                promptImageTokens: 2000,
                completionTextTokens: 100,
            },
            servedBy: TEXT_SERVICES[FALLBACK],
            quotedBy: TEXT_SERVICES[PRIMARY],
        });
        const textOnly = calculateUsageBilling({
            model: PRIMARY,
            usage: { promptTextTokens: 1000, completionTextTokens: 100 },
            servedBy: TEXT_SERVICES[FALLBACK],
            quotedBy: TEXT_SERVICES[PRIMARY],
        });
        // 2000 image tokens at the primary's $1.5/M must be charged, not $0.
        expect(withImages.cost.totalCost).toBeCloseTo(
            textOnly.cost.totalCost + 2000 * 0.0000015,
            12,
        );
    });
});

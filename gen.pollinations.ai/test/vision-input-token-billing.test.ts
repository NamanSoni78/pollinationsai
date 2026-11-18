import { calculateUsageBilling } from "@shared/registry/registry.ts";
import { TEXT_SERVICES } from "@shared/registry/text.ts";
import { openaiUsageToUsage } from "@shared/registry/usage-headers.ts";
import { describe, expect, it } from "vitest";

// Azure OpenAI-family routes, the AWS Bedrock OpenAI-compatible surface, and
// the Vercel AI Gateway report image input as its own usage dimension
// (prompt_tokens_details.image_tokens), and openaiUsageToUsage carves it out
// of promptTextTokens. When the cost sheet has no promptImageTokens rate,
// convertUsage bills that line as 0 — the caller gets vision input for free
// while the platform pays the provider.
const SEPARATELY_REPORTING_VISION_MODELS = [
    "openai/gpt-5.3-codex",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
    "openai/gpt-5.4-nano",
    "openai/gpt-5-nano",
    "openai/gpt-5.5",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
    "openai/gpt-6.1-terra",
    "openai/gpt-6-astra",
    "moonshotai/kimi-k3",
    "tencent/hy4-flash",
    "mistralai/mistral-large-3",
    "meta/llama-4-maverick",
    "pollinations/midijourney",
    "pollinations/midijourney-large",
] as const;

describe("vision input token billing", () => {
    it("carves image tokens out of prompt text tokens when the provider reports the split", () => {
        // Observed Azure usage shape (test/text/generateTextPortkey.test.ts
        // pins the same split for the grok Azure route).
        const usage = openaiUsageToUsage({
            prompt_tokens: 91,
            prompt_tokens_details: { image_tokens: 76 },
            completion_tokens: 22,
            completion_tokens_details: {},
            total_tokens: 113,
        });
        expect(usage).toMatchObject({
            promptTextTokens: 15,
            promptImageTokens: 76,
        });
    });

    it.each(SEPARATELY_REPORTING_VISION_MODELS)(
        "bills provider-reported image input tokens on %s",
        (model) => {
            const definition = TEXT_SERVICES[model];
            expect(definition.inputModalities).toContain("image");
            expect(definition.cost.promptImageTokens).toBeDefined();

            const billing = calculateUsageBilling({
                model,
                usage: {
                    promptTextTokens: 15,
                    promptImageTokens: 76,
                    completionTextTokens: 22,
                },
                servedBy: definition,
            });
            // Pre-fix: the missing rate zero-bills the whole image line.
            expect(billing.price.promptImageTokens ?? 0).toBeGreaterThan(0);
        },
    );

    it("bills image tokens at the long-context input rate when the variant applies", () => {
        const definition = TEXT_SERVICES["openai/gpt-5.5"];
        const billing = calculateUsageBilling({
            model: "openai/gpt-5.5",
            usage: {
                promptTextTokens: 300_000,
                promptImageTokens: 76,
                completionTextTokens: 22,
            },
            servedBy: definition,
        });
        // Long context doubles the GPT-5.5 input rate: $10/M, ×0.75 quote.
        expect(billing.costVariant).toBe("long_context");
        expect(billing.price.promptImageTokens ?? 0).toBeCloseTo(
            (76 * 10 * 0.75) / 1_000_000,
            15,
        );
    });

    it("still bills image tokens on the already-priced control model", () => {
        const definition = TEXT_SERVICES["x-ai/grok-4.20"];
        const billing = calculateUsageBilling({
            model: "x-ai/grok-4.20",
            usage: {
                promptTextTokens: 15,
                promptImageTokens: 76,
                completionTextTokens: 22,
            },
            servedBy: definition,
        });
        expect(billing.price.promptImageTokens ?? 0).toBeGreaterThan(0);
    });
});

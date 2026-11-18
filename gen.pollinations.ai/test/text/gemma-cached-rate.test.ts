import {
    calculateUsageBilling,
    getCostDefinition,
    getModels,
    getRegistryModelDefinition,
} from "@shared/registry/registry.ts";
import { openaiUsageToUsage } from "@shared/registry/usage-headers.ts";
import { describe, expect, it } from "vitest";

/**
 * OpenRouter publishes a cache-read price (input_cache_read) for
 * google/gemma-4-26b-a4b-it — $0.05/M tokens as of 2026-11-18
 * (openrouter.ai/api/v1/models) — and its responses meter cached input
 * through usage.prompt_tokens_details.cached_tokens, which the worker
 * normalizes onto the promptCachedTokens line. The sheet carried no rate
 * for that line, and the registry's convertUsage bills a usage type with
 * no rate as zero, so every cached token on this model settled at $0
 * while OpenRouter charged for it. The gemma-4-31b sibling deliberately
 * prices its cached line (at the full input rate its provider charges),
 * so the fleet convention is that a model whose provider meters cache
 * reads carries the line.
 */
const GEMMA_26B = "google/gemma-4-26b-a4b-it";

// OpenRouter published rates (2026-11-18) + the 5.5% credit-purchase fee.
// The registry stores per-token rates; these are per 1M for readability.
const PUBLISHED_PROMPT = 0.09 * 1.055;
const PUBLISHED_CACHED = 0.05 * 1.055;
const PUBLISHED_COMPLETION = 0.3 * 1.055;

describe("gemma-4-26b cached-input rate sheet", () => {
    it("bills cached input tokens at OpenRouter's published cache-read rate", () => {
        const usage = openaiUsageToUsage({
            prompt_tokens: 1_000_000,
            completion_tokens: 0,
            total_tokens: 1_000_000,
            prompt_tokens_details: { cached_tokens: 100_000 },
        });
        // The inclusive convention carves the cached subset out of the
        // prompt total: 900k text + 100k cached.
        expect(usage.promptTextTokens).toBe(900_000);
        expect(usage.promptCachedTokens).toBe(100_000);

        const billing = calculateUsageBilling({
            model: GEMMA_26B,
            usage,
            servedBy: getRegistryModelDefinition(GEMMA_26B),
        });
        // Pre-fix this line was $0 (missing rate), so the whole cached
        // subset settled free while OpenRouter billed its cache-read rate.
        expect(billing.cost.promptCachedTokens).toBeCloseTo(
            (PUBLISHED_CACHED * 100_000) / 1_000_000,
            9,
        );
        expect(billing.price.totalPrice).toBeCloseTo(
            (PUBLISHED_PROMPT * 900_000 +
                PUBLISHED_CACHED * 100_000 +
                PUBLISHED_COMPLETION * 0) /
                1_000_000,
            9,
        );
    });

    it("pins the sheet to the published OpenRouter rates", () => {
        const cost = getCostDefinition(GEMMA_26B);
        // Registry rates are per token; scale the published per-1M rates.
        const perToken = (perMillionRate: number) => perMillionRate / 1_000_000;
        expect(cost?.promptTextTokens).toBeCloseTo(
            perToken(PUBLISHED_PROMPT),
            15,
        );
        expect(cost?.promptCachedTokens).toBeCloseTo(
            perToken(PUBLISHED_CACHED),
            15,
        );
        expect(cost?.promptImageTokens).toBeCloseTo(
            perToken(PUBLISHED_PROMPT),
            15,
        );
        expect(cost?.completionTextTokens).toBeCloseTo(
            perToken(PUBLISHED_COMPLETION),
            15,
        );
    });

    it("keeps every primary gemma sheet's cache-read line priced within the input rate", () => {
        const offenders: string[] = [];
        for (const model of getModels()) {
            if (!model.startsWith("google/gemma-")) continue;
            if (model.includes(":")) continue; // route-specific fallback sheets
            const cost = getCostDefinition(model);
            const input = cost?.promptTextTokens;
            const cached = cost?.promptCachedTokens;
            if (cached === undefined || cached <= 0) {
                offenders.push(`${model}: cache-read line missing or zero`);
                continue;
            }
            if (input === undefined || cached > input) {
                offenders.push(
                    `${model}: cached ${cached} exceeds input ${input}`,
                );
            }
        }
        expect(offenders).toEqual([]);
    });
});

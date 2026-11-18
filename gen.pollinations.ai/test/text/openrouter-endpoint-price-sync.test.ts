import {
    getCostDefinition,
    getRegistryModelDefinition,
} from "@shared/registry/registry.ts";
import { TEXT_FALLBACKS } from "@shared/registry/text-fallbacks.ts";
import { describe, expect, it } from "vitest";

/**
 * OpenRouter publishes endpoint-level pricing at
 * openrouter.ai/api/v1/models/<model>/endpoints, and each pinned route below
 * resolves to exactly one endpoint family. These tests pin the registry
 * sheets to the published per-token rates of the endpoint that actually
 * serves each model (fetched 2026-11-18), plus the account's 5.5%
 * credit-purchase fee — the convention every sheet comment documents.
 *
 * On unpatched main, five sheets had drifted from those published rates:
 *   - xiaomi/mimo-v2.5 carried 0.14/0.0028/0.28 while its only live endpoint
 *     (venice/fp8) bills $0.40/$0.08/$2.00 per 1M, and carried no
 *     prompt-image line at all although the model accepts image inputs.
 *   - xiaomi/mimo-v2.5-pro carried the delisted "Xiaomi FP8" endpoint's
 *     0.435/0.0036/0.87 while its only live endpoint (digitalocean) bills
 *     $0.48/$0.096/$1.80 per 1M — completion at roughly half price.
 *   - moonshotai/kimi-k2.7-code carried the pinned inceptron/int4
 *     endpoint's 2026-11-11 rates (0.6/0.16/3.5); Inceptron re-priced to
 *     $0.8125/$0.17/$3.75 per 1M.
 *   - deepseek/deepseek-v4-pro carried the pinned alibaba/fp8 endpoint's
 *     2026-09-23 "peak" rates (1.122/0.1122/3.366); that endpoint now bills
 *     $1.416/$0.118/$2.832 per 1M and no longer halves off-peak.
 *   - google/gemini-2.5-flash-lite:search and the gemini-4-carbon AI-Studio
 *     fallback billed web_search at $7/1K requests; every Google endpoint
 *     on the routed AI-Studio tag bills web_search $0.014 per request
 *     ($14/1K) — the same half-price gap the sibling sheets already
 *     corrected to 14.
 */
const CREDIT_FEE = 1.055;
const perToken = (perMillionRate: number) =>
    (perMillionRate * CREDIT_FEE) / 1_000_000;

describe("OpenRouter endpoint price sync (2026-11-18)", () => {
    it("xiaomi/mimo-v2.5 bills venice/fp8, the only endpoint serving it", () => {
        const cost = getCostDefinition("xiaomi/mimo-v2.5");
        expect(cost?.promptTextTokens).toBeCloseTo(perToken(0.4), 15);
        expect(cost?.promptCachedTokens).toBeCloseTo(perToken(0.08), 15);
        // Venice bills one prompt rate for every input modality, and this
        // model accepts image inputs (maxReferenceImages: 10), so those
        // tokens must carry the same rate instead of settling at $0.
        expect(cost?.promptImageTokens).toBeCloseTo(perToken(0.4), 15);
        expect(cost?.completionTextTokens).toBeCloseTo(perToken(2), 15);
    });

    it("xiaomi/mimo-v2.5-pro bills digitalocean, the only endpoint serving it", () => {
        const cost = getCostDefinition("xiaomi/mimo-v2.5-pro");
        expect(cost?.promptTextTokens).toBeCloseTo(perToken(0.48), 15);
        expect(cost?.promptCachedTokens).toBeCloseTo(perToken(0.096), 15);
        expect(cost?.completionTextTokens).toBeCloseTo(perToken(1.8), 15);
    });

    it("moonshotai/kimi-k2.7-code bills the pinned inceptron/int4 rates", () => {
        const cost = getCostDefinition("moonshotai/kimi-k2.7-code");
        expect(cost?.promptTextTokens).toBeCloseTo(perToken(0.8125), 15);
        expect(cost?.promptCachedTokens).toBeCloseTo(perToken(0.17), 15);
        // Inceptron publishes no separate cache-write or image rate; the
        // prompt rate applies, matching the sheet's existing convention.
        expect(cost?.promptCacheWriteTokens).toBeCloseTo(perToken(0.8125), 15);
        expect(cost?.promptImageTokens).toBeCloseTo(perToken(0.8125), 15);
        expect(cost?.completionTextTokens).toBeCloseTo(perToken(3.75), 15);
    });

    it("deepseek/deepseek-v4-pro bills the pinned alibaba/fp8 endpoint", () => {
        const cost = getCostDefinition("deepseek/deepseek-v4-pro");
        // The route pins only alibaba (excluding the pricier us-east-1
        // variant), whose current published rates are these.
        expect(cost?.promptTextTokens).toBeCloseTo(perToken(1.416), 15);
        expect(cost?.promptCachedTokens).toBeCloseTo(perToken(0.118), 15);
        expect(cost?.completionTextTokens).toBeCloseTo(perToken(2.832), 15);
    });

    it("gemini search sheets bill the published $14/1K web_search rate", () => {
        type Adjustment = { id: string; unitCost: number };
        const searchUnitCost = (billing: unknown): number | undefined => {
            const adjustments = (
                billing as { adjustments?: Adjustment[] } | undefined
            )?.adjustments;
            return adjustments?.find(
                (adjustment) => adjustment.id === "openrouter.google.web_search.v1",
            )?.unitCost;
        };
        // Every Google AI Studio endpoint bills web_search $0.014 per request;
        // the sheet carried $7/1K — half the charge — on the platform's main
        // search model (aliases gemini-search, gemini-search-fast, ...).
        expect(
            searchUnitCost(
                getRegistryModelDefinition("google/gemini-2.5-flash-lite:search")
                    .billing,
            ),
        ).toBeCloseTo((14 * CREDIT_FEE) / 1_000, 12);

        const carbonFallback = (TEXT_FALLBACKS as Record<
            string,
            Record<string, { billing?: unknown }>
        >)["google/gemini-4-carbon"]?.[
            "google/gemini-4-carbon:openrouter:ai-studio"
        ];
        expect(searchUnitCost(carbonFallback?.billing)).toBeCloseTo(
            (14 * CREDIT_FEE) / 1_000,
            12,
        );
    });
});

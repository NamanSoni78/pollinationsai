import { calculateUsageBilling } from "@shared/registry/registry.ts";
import { TEXT_SERVICES } from "@shared/registry/text.ts";
import { describe, expect, it } from "vitest";

// A fallback route that overrides `cost` with its own provider's list sheet
// must not inherit the parent's Azure/promo priceMultiplier: the fallback
// provider charges list, so servedPrice (and the effective-prices snapshot)
// would under-report by the inherited discount. Sibling routes set
// priceMultiplier: 1 (x-ai/grok-4.3:openrouter:xai-zdr; the gpt :aws family
// pinned in static-provider-fallbacks.test.ts).
const OWN_COST_ROUTES_INHERITING_PARENT_DISCOUNT = [
    "deepseek/deepseek-v4-flash:deepinfra",
    "deepseek/deepseek-v4.1-flash:fireworks",
    "deepseek/deepseek-v4.1-flash-1017:fireworks",
    "meta/llama-3.3-70b-instruct:deepinfra",
    "mistralai/mistral-large-3:aws",
    "moonshotai/kimi-k3.1-pro:vercel",
    "x-ai/grok-4.20:openrouter:xai-zdr",
    "nvidia/nemotron-3.5-lightning:deepinfra",
    "nvidia/nemotron-3-ultra:deepinfra",
] as const;

// Fallback routes whose primaries price promptImageTokens but whose own cost
// override drops the line: when the route serves, the image cost vanishes
// from the cost ledger and servedPrice. (mistralai/mistral-large-3:aws ships
// with the vision-fleet branch that prices its parent.)
const FALLBACK_ROUTES_DROPPING_PRIMARY_IMAGE_RATE = [
    ["qwen/qwen4-max:vercel", 1.5],
    ["xiaomi/mimo-v2.6-flash:deepinfra", 0.14],
    ["xiaomi/mimo-v2.6-pro:deepinfra", 0.387],
    ["deepseek/deepseek-v4.1-flash:fireworks", 0.3],
    ["deepseek/deepseek-v4.1-flash-1017:fireworks", 0.3],
    ["moonshotai/kimi-k3.1-pro:vercel", 2],
] as const;

function parentOf(route: string) {
    return route.split(":")[0] as keyof typeof TEXT_SERVICES;
}

describe("fallback cost-sheet completeness", () => {
    it.each(OWN_COST_ROUTES_INHERITING_PARENT_DISCOUNT)(
        "serves %s at list rates, not the parent's discount",
        (route) => {
            const fallback = TEXT_SERVICES[route];
            const parent = TEXT_SERVICES[parentOf(route)];
            // The premise: the parent carries a non-1 multiplier and the
            // route overrides cost with its own provider's list sheet.
            expect(parent.priceMultiplier).not.toBe(1);
            expect(fallback.cost).toBeDefined();
            expect(fallback.priceMultiplier).toBe(1);
        },
    );

    it("records servedPrice at cost for a rescued grok-4.20 request", () => {
        const fallback = TEXT_SERVICES["x-ai/grok-4.20:openrouter:xai-zdr"];
        const parent = TEXT_SERVICES["x-ai/grok-4.20"];
        const billing = calculateUsageBilling({
            model: "x-ai/grok-4.20",
            usage: {
                promptTextTokens: 100_000,
                promptImageTokens: 1_000,
                completionTextTokens: 50_000,
            },
            servedBy: fallback,
            quotedBy: parent,
        });
        // The route serves at OpenRouter list rates; servedPrice must not
        // inherit the Azure 0.75 discount (pre-fix: 0.75 × cost).
        expect(billing.servedPrice).toBeCloseTo(billing.cost.totalCost, 12);
    });

    it.each(FALLBACK_ROUTES_DROPPING_PRIMARY_IMAGE_RATE)(
        "records %s image input cost when the route serves",
        (route, rate) => {
            const fallback = TEXT_SERVICES[route];
            const parent = TEXT_SERVICES[parentOf(route)];
            const fallbackCost = fallback.cost as Record<
                string,
                number | undefined
            >;
            const parentCost = parent.cost as Record<
                string,
                number | undefined
            >;
            // The premise: the primary prices image input; the route's own
            // sheet must not drop the line.
            expect(parentCost.promptImageTokens).toBeDefined();
            expect(fallbackCost.promptImageTokens).toBeDefined();

            const billing = calculateUsageBilling({
                model: parentOf(route),
                usage: {
                    promptTextTokens: 1_000,
                    promptImageTokens: 10_000,
                    completionTextTokens: 1_000,
                },
                servedBy: fallback,
                quotedBy: parent,
            });
            expect(billing.cost.promptImageTokens ?? 0).toBeCloseTo(
                (10_000 * rate) / 1_000_000,
                15,
            );
        },
    );

    it("prices liquid/d1.2 cached decision state like its d1 sibling", () => {
        const d1 = TEXT_SERVICES["liquid/d1"];
        const d12 = TEXT_SERVICES["liquid/d1.2"];
        const d12Cost = d12.cost as Record<string, number | undefined>;
        expect(d12Cost.promptCachedTokens).toBeDefined();

        const billing = calculateUsageBilling({
            model: "liquid/d1.2",
            usage: {
                promptTextTokens: 500,
                promptCachedTokens: 100_000,
            },
            servedBy: d12,
        });
        // d1 bills the same usage at $0.00201; d1.2 pre-fix bills $0.00001
        // because the cached line has no rate.
        expect(billing.cost.totalCost).toBeCloseTo(0.00201, 12);
    });
});

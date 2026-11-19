import {
    calculateUsageBilling,
    getRegistryModelDefinition,
    type ModelDefinition,
} from "@shared/registry/registry.ts";
import { describe, expect, it } from "vitest";

// mistralai/mistral-large-4 advertises image input (inputModalities:
// ["text","image"], paidOnly: true, default 8 reference images) but its rate
// sheet carried no promptImageTokens line. On split-reporting providers
// (the Vercel AI Gateway fallback route most prominently — the shape live
// proven by the issue-45 report and pinned by the repo's own fixtures),
// openaiUsageToUsage carves image tokens out of promptTextTokens onto their
// own usage line, and convertUsage bills any reported line without a rate at
// $0 ("[registry] Missing conversion rate ... billing 0 for this line").
// Every image-capable request on the model therefore gave its whole image
// input away for free on both routes — the sheet's own text-rate
// re-verification (2026-11-11) never added the image line.
//
// The expected rate is the model's own promptTextTokens rate — the
// convention every priced sibling follows (mistral-small-4 on the same
// Mistral provider and client path: image = text rate, verified 2026-09-20).

const ROUTES = [
    "mistralai/mistral-large-4",
    "mistralai/mistral-large-4:vercel",
] as const;

// Split-reporting usage shape: image tokens arrive on their own line,
// excluded from promptTextTokens.
const SPLIT_USAGE = {
    promptTextTokens: 100,
    promptImageTokens: 2000,
    completionTextTokens: 50,
};

function definitionOf(id: (typeof ROUTES)[number]): ModelDefinition {
    return getRegistryModelDefinition(id);
}

describe("mistral-large-4 prices its advertised image input", () => {
    it.each(ROUTES)("%s declares image input and prices it", (id) => {
        const definition = definitionOf(id);
        expect(definition.inputModalities).toContain("image");
        expect(definition.cost.promptImageTokens).toBeDefined();
    });

    it.each(ROUTES)(
        "%s bills split-reported image tokens at its text rate",
        (id) => {
            const definition = definitionOf(id);
            const billed = calculateUsageBilling({
                model: id,
                usage: { ...SPLIT_USAGE },
                servedBy: definition,
            });
            const textRate = definition.cost
                .promptTextTokens as unknown as number;
            // 2000 image tokens at the sibling-convention rate (text rate).
            expect(billed.cost.promptImageTokens).toBeCloseTo(
                2000 * textRate,
                15,
            );
            // The image line is no longer zero-filled away: total cost must
            // exceed the text+completion-only math.
            const textOnly =
                100 * textRate +
                50 * (definition.cost.completionTextTokens as number);
            expect(billed.cost.totalCost).toBeGreaterThan(textOnly);
        },
    );

    it("keeps the sibling convention (mistral-small-4: image = text rate)", () => {
        const sibling = getRegistryModelDefinition("mistralai/mistral-small-4");
        expect(sibling.cost.promptImageTokens).toBe(
            sibling.cost.promptTextTokens,
        );
    });
});

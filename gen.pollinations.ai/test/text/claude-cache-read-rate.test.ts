import {
    getCostDefinition,
    getModels,
} from "@shared/registry/registry.ts";
import { describe, expect, it } from "vitest";

/**
 * The documented Claude prompt-caching contract (APIDOCS prompt-caching
 * table): "Cache creates bill at 1.25x the input rate; hits bill at 10% of
 * input, or 2.5% on anthropic/claude-fable-5.1." Every Claude sheet in the
 * registry priced it that way except the 5.5-generation pair, which priced
 * cache reads at 5% of input — undercharging every cache hit by half while
 * Anthropic's own meter (cache_read_input_tokens) reports the hits at the
 * provider's 10%. Same-generation haiku-5.5 prices 10%, which rules out a
 * generation-wide provider change.
 */
describe("Claude prompt-cache read pricing", () => {
    it("prices every Claude route's cache reads at 10% of input (fable-5.1: 2.5%)", () => {
        const offenders: string[] = [];
        for (const model of getModels()) {
            if (!model.startsWith("anthropic/claude-")) continue;
            const cost = getCostDefinition(model);
            const input = cost?.promptTextTokens;
            const cached = cost?.promptCachedTokens;
            if (input === undefined || cached === undefined || !input) continue;

            const expectedRatio =
                /fable-5\.[12]$|fable-5\.[12]:/.test(model) ? 0.025 : 0.1;
            const actualRatio = cached / input;
            if (Math.abs(actualRatio - expectedRatio) > 1e-9) {
                offenders.push(
                    `${model}: cached ${cached} vs input ${input} (ratio ${actualRatio.toFixed(3)}, expected ${expectedRatio})`,
                );
            }
        }
        expect(offenders).toEqual([]);
    });

    it("keeps the 5.5-generation sheets on the family convention", () => {
        for (const model of getModels()) {
            if (!/^anthropic\/claude-(sonnet-5\.5|opus-5\.5)/.test(model))
                continue;
            const cost = getCostDefinition(model);
            const input = cost?.promptTextTokens;
            const cached = cost?.promptCachedTokens;
            expect(cached, model).toBeDefined();
            expect(
                (cached as number) / (input as number),
                model,
            ).toBeCloseTo(0.1, 6);
        }
    });
});

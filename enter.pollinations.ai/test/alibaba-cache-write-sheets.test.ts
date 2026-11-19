import { expect, test } from "vitest";
import {
    getCostDefinition,
    getModels,
    getRegistryModelDefinition,
} from "../../shared/registry/registry.ts";

/**
 * Alibaba Model Studio bills explicit context-cache WRITES at 125% of the
 * standard input unit price (published billing rule), while cache HITS bill
 * at the per-model discounted rate. Every alibaba sheet that prices the
 * cached-read line also has to price the write line, otherwise an explicit
 * cache write on that model settles at $0 while Alibaba charges 125% of the
 * input rate.
 *
 * Sibling convention (all at 1.25x input): qwen4-max 1.5 -> 1.875,
 * qwen3.8-max 2 -> 2.5, qwen3.8-max-0902 2 -> 2.5, qwen3.8-flash
 * 0.15 -> 0.2, qwen3.7-flash 0.1 -> 0.125.
 */
const CACHE_WRITE_TO_INPUT_RATIO = 1.25;
// Sheet values are rounded to 2 decimals in $/M (0.1875 -> 0.2), so allow
// 10% around the exact ratio.
const RATIO_TOLERANCE = 0.1;

function perMillionValue(value: number | undefined): number {
    // Cost definitions are stored per unit; print the per-million view.
    return Math.round((value ?? 0) * 1_000_000 * 10_000) / 10_000;
}

test("every alibaba sheet pricing cache reads also prices cache writes at 1.25x input", () => {
    const missing: string[] = [];
    const mispriced: string[] = [];

    for (const model of getModels()) {
        const definition = getRegistryModelDefinition(model);
        if (definition?.provider !== "alibaba") continue;

        const cost = getCostDefinition(model);
        if (!cost?.promptTextTokens || !cost.promptCachedTokens) {
            // No cached-read line: the provider publishes no context-cache
            // price for this model (e.g. qwen3-vl-235b-a22b-thinking), so
            // both lines are correctly absent.
            continue;
        }

        if (!cost.promptCacheWriteTokens) {
            missing.push(
                `${model}: prices cache reads at ${perMillionValue(cost.promptCachedTokens)}/M but has no promptCacheWriteTokens line — explicit cache writes settle at $0`,
            );
            continue;
        }

        const inputPerMillion = perMillionValue(cost.promptTextTokens);
        const writePerMillion = perMillionValue(cost.promptCacheWriteTokens);
        const expected = inputPerMillion * CACHE_WRITE_TO_INPUT_RATIO;
        if (
            writePerMillion < expected * (1 - RATIO_TOLERANCE) ||
            writePerMillion > expected * (1 + RATIO_TOLERANCE)
        ) {
            mispriced.push(
                `${model}: cache write ${writePerMillion}/M vs 1.25x input ${expected}/M`,
            );
        }
    }

    expect(missing, "sheets missing the cache-write line").toEqual([]);
    expect(mispriced, "sheets with a mispriced cache-write line").toEqual([]);
});

import {
    getPriceDefinitionForModel,
    getRegistryModelDefinition,
} from "@shared/registry/registry.ts";
import type { TinybirdModelStats } from "@shared/utils/model-stats.ts";
import { describe, expect, it } from "vitest";
import {
    getEstimatedPrice,
    getPerSecondUpperBound,
} from "../src/utils/model-stats.ts";

const SEEDANCE = "bytedance/seedance-2.0";

const seedance = getRegistryModelDefinition(SEEDANCE);

function seedanceStats(avg: number | null): TinybirdModelStats {
    return {
        data: avg === null ? [] : [{ model: SEEDANCE, avg_cost_usd: avg }],
    } as TinybirdModelStats;
}

describe("per-second request estimates reserve the worst case", () => {
    it("the seedance fixture is per-second priced with a maximum duration", () => {
        expect(seedance).toBeTruthy();
        const rate = getPriceDefinitionForModel(seedance)
            .completionVideoSeconds;
        expect(typeof rate).toBe("number");
        expect(seedance.maxDuration).toBeGreaterThan(0);
    });

    it("getPerSecondUpperBound is rate × maxDuration", () => {
        const bound = getPerSecondUpperBound(seedance);
        const rate = getPriceDefinitionForModel(seedance)
            .completionVideoSeconds as number;
        expect(bound).toBeCloseTo(rate * (seedance.maxDuration as number), 9);
    });

    it("a Tinybird average no longer under-reserves (pre-fix: the average)", () => {
        // A 15s render bills 2.7 while the historical average says 0.9.
        const bound = getPerSecondUpperBound(seedance) as number;
        expect(
            getEstimatedPrice(seedanceStats(0.9), SEEDANCE, seedance),
        ).toBeCloseTo(bound, 9);
        expect(getEstimatedPrice(seedanceStats(0.9), SEEDANCE, seedance)).not.toBe(
            0.9,
        );
    });

    it("a cold Tinybird (zero rows) reserves the worst case, not zero", () => {
        const bound = getPerSecondUpperBound(seedance) as number;
        expect(getEstimatedPrice(seedanceStats(null), SEEDANCE, seedance)).toBeCloseTo(
            bound,
            9,
        );
        // Pre-fix this was exactly 0: admitted holding nothing.
        expect(getEstimatedPrice(seedanceStats(null), SEEDANCE, seedance)).toBeGreaterThan(
            0,
        );
    });

    it("token-priced models keep the Tinybird average", () => {
        expect(
            getEstimatedPrice(
                { data: [{ model: "openai/gpt-4o", avg_cost_usd: 0.5 }] } as TinybirdModelStats,
                "openai/gpt-4o",
                undefined,
            ),
        ).toBe(0.5);
    });

    it("models without a per-second price are unchanged by the bound path", () => {
        // No definition -> no bound -> the existing behavior applies.
        expect(
            getEstimatedPrice(seedanceStats(0.9), SEEDANCE, undefined),
        ).toBe(0.9);
    });
});

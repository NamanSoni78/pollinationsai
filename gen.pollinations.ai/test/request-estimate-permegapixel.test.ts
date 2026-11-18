import {
    getEstimatedPrice,
    getPerMegapixelImageWorstCase,
} from "../src/utils/model-stats.ts";
import {
    getRegistryModelDefinition,
    type ModelDefinition,
    type ModelName,
} from "@shared/registry/registry.ts";
import { describe, expect, it } from "vitest";

const PRO = "black-forest-labs/flux.2-pro" as const;
const FLEX = "black-forest-labs/flux.2-flex" as const;
const MAX = "black-forest-labs/flux.2-max" as const;

function definition(model: ModelName): ModelDefinition {
    const def = getRegistryModelDefinition(model);
    if (!def) throw new Error(`missing definition for ${model}`);
    return def;
}

describe("per-megapixel image preflight worst case", () => {
    it("prices one megapixel when no request facts are present", () => {
        // Without request facts the historical mean (or the defined
        // one-megapixel price) still gates — unchanged behavior.
        expect(getPerMegapixelImageWorstCase(definition(PRO))).toBeNull();
        // flux.2-pro's 0.75 priceMultiplier applies (effective $0.01125/MP).
        expect(getEstimatedPrice({ data: [] }, PRO, definition(PRO))).toBe(
            0.01125,
        );
        expect(
            getEstimatedPrice(
                { data: [{ model: PRO, avg_cost_usd: 0.05 }] },
                PRO,
                definition(PRO),
            ),
        ).toBe(0.05);
    });

    it("gates a 2048x2048 FLUX.2 Pro render on its whole billable units", () => {
        // 2048x2048 = 4.19 MP -> Azure rounds up to 5 whole units at the
        // effective $0.01125/MP (0.75 multiplier) plus the premium at the
        // same multiplier.
        const request = { requestedMegapixels: (2048 * 2048) / 1_000_000 };
        expect(
            getEstimatedPrice({ data: [] }, PRO, definition(PRO), request),
        ).toBeCloseTo(5 * 0.01125 + 0.01125, 10);
    });

    it("bounds the reference-image input leg by the declared 4 MP ceiling", () => {
        // 8 references x 4 MP each at the effective $0.01125/MP input
        // rate, on top of the 1 MP output default and the premium.
        const request = {
            requestedMegapixels: 1,
            referenceImageCount: 8,
        };
        expect(
            getEstimatedPrice({ data: [] }, PRO, definition(PRO), request),
        ).toBeCloseTo(1 * 0.01125 + 8 * 4 * 0.01125 + 0.01125, 10);
    });

    it("includes the Replicate run fee for FLUX.2 Max", () => {
        const request = { requestedMegapixels: 2 };
        expect(
            getEstimatedPrice({ data: [] }, MAX, definition(MAX), request),
        ).toBeCloseTo(2 * 0.03 + 0.04, 10);
    });

    it("covers the non-paid-only FLUX.2 Flex worst case", () => {
        // Flex is quest-tier reachable (paidOnly: false): 10 references x
        // 4 MP at the effective $0.0375/MP input rate (0.75 multiplier) + a
        // 4K (14.75 -> 15 whole units) output request.
        const request = {
            requestedMegapixels: (3840 * 3840) / 1_000_000,
            referenceImageCount: 10,
        };
        expect(
            getEstimatedPrice({ data: [] }, FLEX, definition(FLEX), request),
        ).toBeCloseTo(
            Math.ceil((3840 * 3840) / 1_000_000) * 0.0375 + 10 * 4 * 0.0375,
            10,
        );
    });

    it("the mean never lowers the bound below the worst case", () => {
        const request = {
            requestedMegapixels: 4.19,
            referenceImageCount: 8,
        };
        expect(
            getEstimatedPrice(
                { data: [{ model: PRO, avg_cost_usd: 0.0412 }] },
                PRO,
                definition(PRO),
                request,
            ),
        ).toBeCloseTo(
            5 * 0.01125 + 8 * 4 * 0.01125 + 0.01125,
            10,
        );
    });

    it("clamps the reference count to the model's maxReferenceImages", () => {
        // A query with more references than the route accepts never
        // generates; the bound must not price the excess.
        const request = {
            requestedMegapixels: 1,
            referenceImageCount: 40,
        };
        expect(
            getEstimatedPrice({ data: [] }, MAX, definition(MAX), request),
        ).toBeCloseTo(1 * 0.03 + 8 * 4 * 0.03 + 0.04, 10);
    });

    it("excludes the fal-tier models whose units are not request-computable", () => {
        // flux-3-image-klein and qwen-image-2.1 price completionImageTokens
        // with a quantity-scaled fal-tier unit; their bill depends on fal's
        // reported units, so no request bound applies (documented residual).
        for (const model of [
            "black-forest-labs/flux-3-image-klein",
            "qwen/qwen-image-2.1",
        ] as const) {
            expect(
                getPerMegapixelImageWorstCase(definition(model), {
                    requestedMegapixels: 4,
                    referenceImageCount: 4,
                }),
            ).toBeNull();
        }
    });

    it("leaves token-priced and per-second models untouched", () => {
        expect(
            getPerMegapixelImageWorstCase(
                definition("openai/gpt-image-1.5" as ModelName),
                { requestedMegapixels: 4, referenceImageCount: 4 },
            ),
        ).toBeNull();
        expect(
            getPerMegapixelImageWorstCase(definition("bytedance/seedance-2.5" as ModelName), {
                requestedMegapixels: 4,
            }),
        ).toBeNull();
    });
});

import {
    getPriceDefinitionForModel,
    isFlatRateModel,
    type ModelDefinition,
} from "@shared/registry/registry.ts";
import type { TinybirdModelStats } from "@shared/utils/model-stats.ts";

const REQUEST_PRICE_FIELDS = [
    "completionImageTokens",
    "completionAudioSeconds",
    "completionVideoSeconds",
    "completionAudioTokens",
] as const;

/**
 * Per-request estimate from the model definition, or null when the definition
 * is token-priced (Tinybird's historical average is the better preflight).
 * A rate with a declared unit gives the price of one unit, e.g. one megapixel.
 */
export function getDefinedRequestEstimate(
    definition: ModelDefinition,
): number | null {
    if (!isFlatRateModel(definition)) return null;

    const price = getPriceDefinitionForModel(definition);
    const field = REQUEST_PRICE_FIELDS.find((f) => price[f] != null);
    if (!field) return null;
    const requestPrice =
        (price[field] ?? 0) * (definition.priceUnits?.[field]?.quantity ?? 1);
    return Number.isFinite(requestPrice) && requestPrice >= 0
        ? requestPrice
        : null;
}

/**
 * Tinybird is the preflight source of truth when it looks like a real charge.
 * If it is missing or wildly above the defined per-request price, it is almost
 * certainly poisoned (mean of rows that billed output_tokens × a per-image
 * rate — e.g. 0.01 × ~3334 ≈ 33.34). Token-priced models have no per-request
 * definition, so they keep Tinybird as-is. A price per declared unit (one
 * megapixel) is only the fallback: a request can bill many units, so it never
 * discards Tinybird.
 */
const TINYBIRD_OUTLIER_RATIO = 10;

/** Request facts that bound a per-megapixel image bill before dispatch. */
export type PerMegapixelRequestBound = {
    /** Output megapixels the caller requested (width × height / 1e6). */
    requestedMegapixels?: number;
    /** Reference images the request carries (already schema-validated). */
    referenceImageCount?: number;
};

/**
 * True when the model bills megapixels through the completionImageTokens
 * rate with a plain per-megapixel unit (no `quantity` scaling — the
 * fal-tier models that count millionths are excluded; their units are
 * provider-reported tiers, not request-computable).
 */
function plainPerMegapixelPrice(definition: ModelDefinition) {
    const units = definition.priceUnits?.completionImageTokens;
    const price = getPriceDefinitionForModel(definition);
    return (
        units?.unit === "megapixel" &&
        units.quantity == null &&
        typeof price.completionImageTokens === "number" &&
        price.completionImageTokens > 0
    );
}

/**
 * The request's worst-case bill on a per-megapixel image model, or null for
 * every other pricing shape. Per-megapixel models bill every input AND
 * output megapixel (Azure rounds up to whole units; Replicate bills whole
 * megapixels per image), so the preflight must gate on
 *
 *   ceil(requested output MP) × output rate
 *   + reference count × maxInputMegapixels × input rate
 *   + the per-generation flat adjustments (initial-MP premium, run fee)
 *
 * — the historical mean is not a bound: a 2048×2048 FLUX.2 Pro render with
 * eight references bills ~$0.28 on a $0.015 one-megapixel estimate. The
 * input leg uses the registry-declared per-reference ceiling the provider
 * enforces by resizing (4 MP for the FLUX.2 family); the output leg uses
 * the caller's own requested dimensions, which is what the platform's
 * Replicate fallback bills when metrics are absent.
 */
export function getPerMegapixelImageWorstCase(
    definition: ModelDefinition,
    request?: PerMegapixelRequestBound,
): number | null {
    if (!plainPerMegapixelPrice(definition) || !request) return null;
    const price = getPriceDefinitionForModel(definition);
    const outputRate = price.completionImageTokens as number;
    const inputRate = price.promptImageTokens;
    const outputLeg =
        request.requestedMegapixels != null &&
        Number.isFinite(request.requestedMegapixels) &&
        request.requestedMegapixels > 0
            ? Math.ceil(request.requestedMegapixels) * outputRate
            : outputRate;
    let inputLeg = 0;
    if (
        typeof inputRate === "number" &&
        inputRate > 0 &&
        definition.maxInputMegapixels != null &&
        request.referenceImageCount != null &&
        request.referenceImageCount > 0
    ) {
        const boundedReferences = definition.maxReferenceImages
            ? Math.min(
                  request.referenceImageCount,
                  definition.maxReferenceImages,
              )
            : request.referenceImageCount;
        inputLeg =
            boundedReferences *
            definition.maxInputMegapixels *
            inputRate;
    }
    // Adjustments price as cost x effective multiplier, exactly like the
    // settlement (registry.ts: "price = cost x effective multiplier").
    const flatAdjustments =
        (definition.billing?.adjustments ?? [])
            .filter((adjustment) => adjustment.unit === "generation")
            .reduce(
                (total, adjustment) => total + (adjustment.unitCost ?? 0),
                0,
            ) * (definition.priceMultiplier ?? 1);
    const worstCase = outputLeg + inputLeg + flatAdjustments;
    return Number.isFinite(worstCase) && worstCase > 0 ? worstCase : null;
}

export function getEstimatedPrice(
    stats: TinybirdModelStats,
    model: string | undefined,
    definition?: ModelDefinition,
    request?: PerMegapixelRequestBound,
): number {
    if (!model) return 0;
    // Retain pre-rename history until Tinybird has data under the canonical ID.
    const tinybird =
        (
            stats.data?.find((r) => r.model === model) ??
            stats.data?.find((r) => definition?.aliases.includes(r.model))
        )?.avg_cost_usd || 0;
    // A per-megapixel request with declared dimensions and references bills
    // at most the worst case; the preflight gates on that bound, never on a
    // mean that a larger render can exceed.
    const megapixelWorstCase = definition
        ? getPerMegapixelImageWorstCase(definition, request)
        : null;
    if (megapixelWorstCase != null && megapixelWorstCase > 0) {
        return Math.max(tinybird, megapixelWorstCase);
    }
    const defined = definition ? getDefinedRequestEstimate(definition) : null;
    if (
        defined != null &&
        defined > 0 &&
        (tinybird <= 0 ||
            (!definition?.priceUnits &&
                tinybird > defined * TINYBIRD_OUTLIER_RATIO))
    ) {
        return defined;
    }
    return tinybird;
}

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
 *
 * A per-second field is one second of a render whose duration is only known at
 * completion, so its per-request estimate is the worst case (rate × maxDuration)
 * rather than one second: a 30s render billed 29 pollen must not be admitted
 * on a 0.97 estimate.
 */
export function getDefinedRequestEstimate(
    definition: ModelDefinition,
): number | null {
    if (!isFlatRateModel(definition)) return null;

    const price = getPriceDefinitionForModel(definition);
    const field = REQUEST_PRICE_FIELDS.find((f) => price[f] != null);
    if (!field) return null;
    const unitQuantity = definition.priceUnits?.[field]?.quantity ?? 1;
    const perSecond =
        field === "completionVideoSeconds" ||
        field === "completionAudioSeconds";
    const requestMultiplier = perSecond
        ? Math.max(1, definition.maxDuration ?? unitQuantity)
        : unitQuantity;
    const requestPrice = (price[field] ?? 0) * requestMultiplier;
    return Number.isFinite(requestPrice) && requestPrice >= 0
        ? requestPrice
        : null;
}

/** True when the model bills by the second in its registry price. */
function perSecondPriceField(
    definition: ModelDefinition,
): "completionVideoSeconds" | "completionAudioSeconds" | null {
    const price = getPriceDefinitionForModel(definition);
    if (price.completionVideoSeconds != null) return "completionVideoSeconds";
    if (price.completionAudioSeconds != null) return "completionAudioSeconds";
    return null;
}

/**
 * Worst-case per-request bound for a per-second model: rate × maxDuration.
 * Null when the model is not per-second priced or has no usable maximum.
 */
export function getPerSecondUpperBound(
    definition: ModelDefinition,
): number | null {
    const field = perSecondPriceField(definition);
    if (!field) return null;
    const price = getPriceDefinitionForModel(definition);
    const rate = price[field] ?? 0;
    const maxDuration = definition.maxDuration;
    if (!(rate > 0) || !(maxDuration > 0)) return null;
    const bound = rate * maxDuration;
    return Number.isFinite(bound) && bound > 0 ? bound : null;
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

export function getEstimatedPrice(
    stats: TinybirdModelStats,
    model: string | undefined,
    definition?: ModelDefinition,
): number {
    if (!model) return 0;
    // Retain pre-rename history until Tinybird has data under the canonical ID.
    const tinybird =
        (
            stats.data?.find((r) => r.model === model) ??
            stats.data?.find((r) => definition?.aliases.includes(r.model))
        )?.avg_cost_usd || 0;
    // A per-second model only reveals its duration at completion, so a
    // Tinybird average (or a cold zero) systematically under-reserves
    // above-average renders: a 15s render billed 2.7 was admitted on a 0.9
    // average, a 30s render on one second's rate. For a finite budget the
    // worst case (rate × maxDuration) is the only safe preflight.
    const perSecondBound = definition
        ? getPerSecondUpperBound(definition)
        : null;
    if (perSecondBound != null) {
        return perSecondBound;
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

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

// Rates charged per second of generated media: the request's duration, not
// the declared unit quantity, sizes the estimate.
const PER_SECOND_PRICE_FIELDS = new Set<string>([
    "completionAudioSeconds",
    "completionVideoSeconds",
]);

/**
 * Per-request estimate from the model definition, or null when the definition
 * is token-priced (Tinybird's historical average is the better preflight).
 * A rate with a declared unit gives the price of one unit, e.g. one megapixel.
 * A per-second rate gives the price of the whole request: the requested
 * duration when the caller states it, else the model's default duration, else
 * its maximum — never a single second of the rate, which a 15s or 120s
 * request would overspend by that factor.
 */
export function getDefinedRequestEstimate(
    definition: ModelDefinition,
    durationSeconds?: number,
): number | null {
    const price = getPriceDefinitionForModel(definition);
    const field = REQUEST_PRICE_FIELDS.find((f) => price[f] != null);
    // A per-second media rate is flat-rate-shaped even though the model's
    // category is "video" or "audio": without this, a model with no price
    // history preflights at $0 and settles into overdraft. Token-priced and
    // unit-priced definitions keep the existing flat-rate gate.
    const perSecondRate = field != null && PER_SECOND_PRICE_FIELDS.has(field);
    if (!isFlatRateModel(definition) && !perSecondRate) return null;
    if (!field) return null;
    const units = perSecondRate
        ? (durationSeconds ??
              definition.defaultDuration ??
              definition.maxDuration ??
              1)
        : (definition.priceUnits?.[field]?.quantity ?? 1);
    const requestPrice = (price[field] ?? 0) * units;
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

export function getEstimatedPrice(
    stats: TinybirdModelStats,
    model: string | undefined,
    definition?: ModelDefinition,
    durationSeconds?: number,
): number {
    if (!model) return 0;
    // Retain pre-rename history until Tinybird has data under the canonical ID.
    const tinybird =
        (
            stats.data?.find((r) => r.model === model) ??
            stats.data?.find((r) => definition?.aliases.includes(r.model))
        )?.avg_cost_usd || 0;
    const defined = definition
        ? getDefinedRequestEstimate(definition, durationSeconds)
        : null;
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

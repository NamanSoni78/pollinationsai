import {
    getPriceDefinitionForModel,
    isFlatRateModel,
    type ModelDefinition,
} from "@shared/registry/registry.ts";
import type { PricingInput } from "@shared/registry/cost-variants.ts";
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

/** Request facts that bound a per-second video bill before dispatch. */
export type PerSecondRequestBound = {
    /** Explicit `duration` param, already validated by the route schema. */
    requestedSeconds?: number;
    /** Requested output resolution, e.g. "720p". */
    resolution?: string;
    /** The request carries a reference video. */
    hasReferenceVideo?: boolean;
    /** The model picks the output length (reference video, adaptive ratio). */
    adaptiveDuration?: boolean;
};

/**
 * Worst-case seconds a request can bill on a per-second video model: the
 * requested (or default) duration, or the registry-declared ceiling when the
 * model picks the output length itself. Null when the bill is not bounded
 * before dispatch.
 */
function perSecondBound(
    definition: ModelDefinition,
    request: PerSecondRequestBound,
): number | null {
    if (request.adaptiveDuration) {
        return definition.adaptiveMaxDuration ?? null;
    }
    const maxDuration = definition.maxDuration;
    const seconds =
        request.requestedSeconds ?? definition.defaultDuration ?? maxDuration;
    if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
        return null;
    }
    return maxDuration != null ? Math.min(seconds, maxDuration) : seconds;
}

/**
 * Per-second rate the request bills at: the cost variant the request selects
 * — the same selector and base-rate fallback the settlement runs.
 */
function perSecondRate(
    definition: ModelDefinition,
    request: PerSecondRequestBound,
    boundSeconds: number,
): number | null {
    const variantInput: PricingInput = {
        resolution: request.resolution,
        hasReferenceVideo: request.hasReferenceVideo,
    };
    let selected: string | undefined;
    try {
        selected = definition.selectCostVariant?.({
            usage: { completionVideoSeconds: boundSeconds },
            input: variantInput,
        });
    } catch {
        selected = undefined;
    }
    if (selected != null && !definition.costVariants?.[selected]) {
        selected = undefined;
    }
    // The selector returning undefined (or throwing) bills base rates — the
    // same fallback the settlement's selectCostVariant applies.
    const baseRate =
        getPriceDefinitionForModel(definition).completionVideoSeconds;
    const usableBase =
        typeof baseRate === "number" && Number.isFinite(baseRate) && baseRate > 0;
    if (selected == null) {
        return usableBase ? baseRate : null;
    }
    const rate =
        getPriceDefinitionForModel(definition, selected).completionVideoSeconds;
    if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
        return rate;
    }
    return usableBase ? baseRate : null;
}

/**
 * The request's worst-case bill on a per-second video model, or null for
 * every other pricing shape (and when the duration is unbounded). Per-second
 * video is billed on the actual output seconds, which for adaptive edits is
 * chosen by the model up to the registry ceiling, so the preflight must gate
 * on seconds x rate — the historical mean is not a bound.
 */
export function getPerSecondVideoWorstCase(
    definition: ModelDefinition,
    request?: PerSecondRequestBound,
): number | null {
    if (definition.cost?.completionVideoSeconds == null) return null;
    if (!request) return null;
    const bound = perSecondBound(definition, request);
    if (bound == null || bound <= 0) return null;
    const rate = perSecondRate(definition, request, bound);
    if (rate == null || rate <= 0) return null;
    const worstCase = bound * rate;
    return Number.isFinite(worstCase) && worstCase >= 0 ? worstCase : null;
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
    request?: PerSecondRequestBound,
): number {
    if (!model) return 0;
    // Retain pre-rename history until Tinybird has data under the canonical ID.
    const tinybird =
        (
            stats.data?.find((r) => r.model === model) ??
            stats.data?.find((r) => definition?.aliases.includes(r.model))
        )?.avg_cost_usd || 0;
    // A per-second video request with a bounded duration bills at most
    // seconds x rate; the preflight gates on that bound, never on a mean
    // that a longer render can exceed.
    const worstCase = definition
        ? getPerSecondVideoWorstCase(definition, request)
        : null;
    if (worstCase != null && worstCase > 0) {
        return Math.max(tinybird, worstCase);
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

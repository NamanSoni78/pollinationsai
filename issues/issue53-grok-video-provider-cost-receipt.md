# Issue 53 — grok video routes discard the provider's billing receipt and settle the *requested* duration (`x-ai/grok-imagine-video-1.5-lite:openrouter`, `x-ai/grok-imagine-video-1.5:fal`)

- **Severity:** Medium-High (success-path under-billing on both fallback routes of a paid model; worst case ≈ $1.74/request under-billed, scales with xAI-direct outages since the routes serve failover traffic)
- **Affected:** `gen.pollinations.ai/src/image/models/openRouterVideoModel.ts` (`callOpenRouterGrokVideoAPI`), `gen.pollinations.ai/src/image/models/falFallbackMediaModel.ts` (VIDEO_CONFIGS `x-ai/grok-imagine-video-1.5:fal`) — upstream `pollinations/pollinations` main @ `52fd0a6`
- **Fix branch:** `solution49-grok-video-provider-cost-receipt` — **PR:** [#62](https://github.com/NamanSoni78/pollinationsai/pull/62)
- **Relationships:** distinct from issue 2 (xAI-direct moderation-billed video, fixed by attaching `billedUsage` on error) and issue 25 (fal-queue *failure* billing) — this is the **success path** discarding the receipt on two different providers. No overlap with any filed issue.

## Root cause

**Instance 1 — OpenRouter.** The shared helper `generateOpenRouterVideo` returns the completed poll's `usage.cost` (`openRouterVideoModel.ts:315`), and the repo itself documents why that receipt matters: "OpenRouter applies a 5-second billing minimum and returns 1080p for a requested 720p" (`shared/registry/image.ts` — the stated reason kling rejected OpenRouter as a fallback). The two sibling handlers in the same file thread it into settlement:

```ts
// callHappyHorseAPI / callHeyGenVideoAPI (correct)
...(providerCost != null && {
    providerBilling: { units: providerCost, unitCost: 1.055 },
}),
```

`callOpenRouterGrokVideoAPI` destructures `providerCost` but only **logs** it, returning `usage: { completionVideoSeconds: duration }` — the *requested* seconds at the registry's fixed per-second sheet (`0.03×1.055`/s at 720p, `0.14×1.055`/s at 1080p). Under-billing per request: `duration=1..4` at the 5-second minimum → up to `(5−1) × $0.1477 ≈ $0.59`; a 15 s 720p request upgraded to 1080p → `(0.1477−0.0317) × 15 ≈ $1.74`.

**Instance 2 — fal.** `x-ai/grok-imagine-video-1.5:fal` lacks `providerPriced` in `VIDEO_CONFIGS`, so settlement re-prices the requested duration through the registry sheet instead of fal's **weighted billable units at the endpoint's live price** — while its sibling `x-ai/grok-imagine-video:fal` (same config table, 40 lines above) is `providerPriced: true` and additionally reads the output's reported duration. The comment on the sibling's duration read — "Weighted fal billing units are not video seconds" — is the direct evidence that requested-seconds ≠ fal's bill.

Both routes are fallbacks (served on xAI-direct retryable failures), so exposure grows exactly when xAI has incidents.

## Safe repro (isolated, non-destructive)

Extended the existing suites (no live calls): `test/image/openRouterVideoModel.test.ts` — the established `mockGrokFetch` poll response already reports `usage: { cost: 0.35 }`; new case asserts `trackingData.providerBilling` equals `{ units: 0.35, unitCost: 1.055 }` for a `duration=1` request (pre-fix: **undefined** — reproduced red; the requested-duration sheet would bill $0.0317 while the receipt is $0.35). Second case: `usage.cost: -1` → must reject with "invalid Grok Video billing cost" (pre-fix: accepted and settled). `test/image/falFallbackMediaModel.test.ts` — new case asserts the 1.5:fal route emits `providerBilling: { units: 1, unitCost: 0.17 }` from fal's billable-units header at the live price (pre-fix: undefined — reproduced red). One pre-existing fal test needed its request selector updated (it indexed `requests[0]`, which is now the `/pricing` probe that `providerPriced` adds — the same filter its sibling tests already use).

## Fix

- `callOpenRouterGrokVideoAPI`: mirror the happyhorse/heygen handlers verbatim — validate `providerCost` (finite, ≥ 0, else 502) and emit `providerBilling: { units: providerCost, unitCost: 1.055 }`.
- `VIDEO_CONFIGS["x-ai/grok-imagine-video-1.5:fal"]`: add `providerPriced: true`.

The registry sheets stay as the caller quote; the receipt settles. Regression cover: `test/image/` **960/960** (48 files), `tsc --noEmit` clean.

## Impact

Every grok-1.5-lite request served by the OpenRouter route settles the requested duration instead of OpenRouter's own bill (5-second minimum, resolution upgrades), and every grok-1.5 request on the fal route settles requested seconds instead of fal's weighted units at live price. Worst case ≈ **$1.74/request** under-billed (15 s 720p→1080p), systematically on failover traffic.

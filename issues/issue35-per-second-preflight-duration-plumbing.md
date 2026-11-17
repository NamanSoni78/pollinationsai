# Issue 35 — Per-second preflight under-reservation: companion verification and duration-precise alternative fix (cross-reference to issue 32)

- **Severity:** High (billing integrity — same vulnerability as issue 32)
- **Affected:** `gen.pollinations.ai/src/utils/model-stats.ts`, `gen.pollinations.ai/src/utils/generation-access.ts` — upstream `pollinations/pollinations` main @ `6538ea2721`
- **Fix branch:** `solution31-per-second-preflight-reservation` — **PR:** [#40](https://github.com/NamanSoni78/pollinationsai/pull/40)
- **Relationship:** The same vulnerability was registered concurrently by session 6 as **issue 32** (fix PR [#37](https://github.com/NamanSoni78/pollinationsai/pull/37), branch `solution18-request-estimate-upper-bound`). This report is retained because the independent verification surfaced **an additional root cause issue  32 does not cover** (the `isFlatRateModel` eligibility gate) and delivers a **requested-duration-precise alternative fix** that avoids the worst-case over-reservation of the upper-bound approach. Maintainers can take either PR; the two are mutually exclusive replacements for the same three functions.

## Root cause (both layers)

**Layer 1 — eligibility gate (not covered by issue 32):** `getDefinedRequestEstimate` opens with `if (!isFlatRateModel(definition)) return null;`, and `isFlatRateModel` is `definition.flatRate ?? (definition.category === "image" && cost.promptTextTokens === undefined)` (`shared/registry/registry.ts:645-648`). Every per-second video model is `category: "video"` and every per-second music/SFX model is `category: "audio"` — **none pass the gate**, so the defined estimate is `null` for all of them and `getEstimatedPrice` returns the Tinybird average or, for a model with no price history (every newly launched model), **exactly $0**. The wallet gate and the API-key budget reservation then admit the request at zero reserve.

**Layer 2 — one-unit sizing:** where a defined estimate does exist, it prices `rate × (priceUnits?.quantity ?? 1)` — exactly one second of the rate, ignoring the caller's `duration` (1-120s, user-controlled via the validated query / passthrough POST body).

## Impact

Same as issue 32 (wallet overdraft via the guard-less `atomicDeductUserBalance`; API-key budget cap overshoot via the floorless `atomicAdjustApiKeyBalance` — the latter now separately fixed by issue 31 / PR #36). Representative numbers at `6538ea2721`:

| Model (request) | Preflight reserve (pre-fix) | Settlement charge | Under-factor |
|---|---|---|---|
| `bytedance/seedance-2.0` 15s ($0.18/s) | $0 (no Tinybird rows) | $2.70 | unbounded |
| `black-forest-labs/flux-3-max` 20s ($0.0425/s) | $0 | $0.85 | unbounded |
| `mirelo/sfx-2.0` default ($0.01/s, defaultDuration 120) | $0 | $1.20 | unbounded |
| `elevenlabs/music-v2` 300s | $0 | up to $1.50+ | unbounded |

## Fix (alternative to PR #37)

`solution31-per-second-preflight-reservation`:

1. `getDefinedRequestEstimate` treats a per-second rate (`completionVideoSeconds` / `completionAudioSeconds`) as flat-rate-shaped regardless of category — closing the Layer-1 eligibility gate — and prices the **whole request**: `duration ?? defaultDuration ?? maxDuration ?? 1` seconds of the rate (Layer 2). Megapixel and token pricing keep the existing `priceUnits` behavior exactly.
2. `generationAccess` and `requireModelAttemptAccess` pass the **validated requested duration** (GET query, or the `.passthrough()` body of the OpenAI-compatible POST image routes) into `checkBalance`, so the wallet gate and the key-budget reservation size to the true request rather than a worst case.

**Difference vs PR #37:** the upper-bound approach reserves `rate × maxDuration` for every request. That is safe but over-reserves sub-maximum requests: a caller with a $1.00 wallet asking for a 5s seedance render ($0.90 true cost) is refused because the worst case (15s, $2.70) exceeds the wallet — a false rejection the preflight did not produce before #19972 tightened this family. The duration-precise approach reserves exactly what the caller asked for (falling back conservatively to default, then max, when the caller is silent), and keeps the #19972 Tinybird-median precedence (a believable median still wins; a median >10× the duration-aware defined estimate is discarded as poisoned).

## Safe repro (isolated, non-destructive)

Two new tests in `gen.pollinations.ai/test/byop-markup.test.ts`, both red on unpatched main:

1. `sizes per-second estimates by the requested duration, not one second` — `getDefinedRequestEstimate("bytedance/seedance-2.0")` returns $0.18 (1s) / $0.90 (default 5s) / $2.70 (requested 15s); `mirelo/sfx-2.0` defaults to $1.20; the megapixel model `black-forest-labs/flux.2-max` is unit-shaped (duration does not leak in); a believable Tinybird median still wins.
2. `preflights a 15s video at 15 seconds of the rate` — end-to-end `checkBalance` with Tinybird unreachable: wallet/key budget $0.50 → 402 for both the 15s request and the 5s default (the old $0/$0.18 estimate admitted both); a $1.50 wallet still serves the affordable 5s request while refusing 15s.

Suites: `byop-markup` 43/43, `realtime` + `tracking-observability` 163/163, `billing-deduction` + full `test/image/` 976/976, `tsc --noEmit` clean.

**PR:** https://github.com/NamanSoni78/pollinationsai/pull/40 (upstream PR rejected `403`, as all prior rounds — fork PR is the review surface)

## Residual gaps (documented for maintainers, identical under either PR)

- Reference-media **input** seconds (`promptVideoSeconds` for wan-3.0 reference videos, `promptAudioSeconds` for music ingestion) bill from provider-reported input durations unknowable before the fetch; the estimate covers output seconds only.
- `seedance-2.5` reference-video mode lets the model pick up to 30s when `duration` is omitted; the registry default (4s) sizes that preflight.
- Resolution cost variants (e.g. seedance-2.5 480p → 1080p, 9.4×) use the base sheet for the estimate.

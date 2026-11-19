# Issue 128 — flux-3-max still bills the expired 75%-off fal promo: 2x under-billing today, 4x from Nov 21

- **Severity:** High (direct per-request revenue loss on a flagship paid video model; the proven registry-parity class of issues 34/37/45/46/47/49/52/53/62/70/80)
- **Affected:** `shared/registry/image.ts:2103-2118` (`black-forest-labs/flux-3-max` cost + the `1080p` variant) — upstream `pollinations/pollinations` main @ `8fc4c212a4`
- **Fix branch:** `solution128-flux3max-fal-promo-rates` — fork PR [#143](https://github.com/NamanSoni78/pollinationsai/pull/143)
- **Dedup:** no registry issue covers flux-3-max's per-second rates (issue 80 = OpenRouter endpoint parity; issue 122 = the qwen3.8 cache-write line; the flux-3-**image** sibling already has its own `Date.now()` cutover getter — this sheet predated that convention and its own comment recorded the pending follow-up: "List after the promotion: $0.17/s at 720p and $0.29/s at 1080p (follow-up PR)" — never landed).

## Root cause

The sheet still bills the promotional per-second rates pinned 2026-10-20 (`completionVideoSeconds: 0.0425` at 720p, `0.0725` at 1080p — 75% off) **although that promotion ended 2026-11-07**. fal's page today (fetched 2026-11-19, non-destructive):

> "FLUX 3 Max is 50% off until November 21 … $0.085 / second [720p]. List $0.17, this rate ends November 21"

Settlement bills the registry's per-second rate against fal's reported billable seconds (the sonilo/fal family convention — `falBillableUnits` → registry rate), so:

- today: a 10s 720p render charges the user $0.425 while fal bills the platform $0.85 → **$0.425 lost per render** (2x under-billing); 1080p 10s loses $0.725;
- after 2026-11-21 (list $0.17/s 720p, $0.29/s 1080p): 4x under-billing — $1.275 lost per 720p 10s render.

## Safe reproduction (non-destructive, public evidence only)

1. Fetch `https://fal.ai/flux-3-max` (the pricing section quoted above);
2. `gen.pollinations.ai/test/flux3-max-promo-rates.test.ts` — 2 tests **red on unpatched `8fc4c21`**: `getCostDefinition("black-forest-labs/flux-3-max").completionVideoSeconds` is `0.0425`, not the live `0.085` (fake-timer coverage of both sides of the 2026-11-21 cutover, base + the 1080p `costVariants["1080p"]`).

## Fix (`solution128-flux3max-fal-promo-rates`)

Mirrors the flux-3-image convention: `FLUX3_MAX_PROMO_END = Date.parse("2026-11-21T23:59:59Z")` and `Date.now()`-aware getters on the base cost and the 1080p variant — promo rates ($0.085/$0.145) now, list rates ($0.17/$0.29) after the cutover, so warm workers also quote the change (fal direct-billed, no OpenRouter credit fee — no 1.055 multiplier, matching the sheet's existing convention). The enter effective-prices snapshot is regenerated (exactly the flux-3-max rows; the flux-3-image precedent pins generation-time values the same way).

## Verification

2/2 green (both cutover sides); flux suites (`fluxMaxVideoModel`, `costVariants-e2e`, `videoFrameValidation`, `model-registry`) 25 green; effective-prices snapshot test green; `tsc --noEmit` clean.

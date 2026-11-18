# Issue 73 — Per-megapixel image preflight prices exactly one megapixel while the settlement bills every input and output megapixel

- **Severity:** High (billing integrity: ~30x under-reservation per request on the FLUX.2 family; the non-paid-only `flux.2-flex` exposes the quest tier to the platform-absorbed overdraft)
- **Affected:** `gen.pollinations.ai/src/utils/model-stats.ts` (`getDefinedRequestEstimate` prices `REQUEST_PRICE_FIELDS[0] × (quantity ?? 1)` = one megapixel), `gen.pollinations.ai/src/utils/generation-access.ts` (`checkBalance` has no request facts), `shared/registry/image.ts` (no input-MP ceiling declared) — upstream `pollinations/pollinations` main @ `6989f4bb64`
- **Fix branch:** `solution73-permegapixel-preflight-worstcase` — fork PR [#85](https://github.com/NamanSoni78/pollinationsai/pull/85)
- **Relationship:** the per-megapixel sibling of the accepted per-second estimate family (issues 32/35/39, branches `solution18`/`solution31`, unmerged). Round 17's continuation re-verified the arithmetic and left the lead with a fix shape ("cap input image megapixels at download/prepare time on the per-MP routes + thread (reference count, requested output MP) into the estimate"); the estimate-side plumbing is what this branch delivers, and the BFL-documented 4 MP input ceiling removes the policy-value blocker that kept it below gate.

## Root cause

The three per-megapixel models price **both** legs per MP with no `quantity` scaling:

| Model | input $/MP | output $/MP | flat | maxRef | paidOnly |
|---|---|---|---|---|---|
| `black-forest-labs/flux.2-pro` (azure) | 0.015 (×0.75 multiplier) | 0.015 | +0.015 initial-MP premium | 8 | true |
| `black-forest-labs/flux.2-flex` (azure) | 0.05 | 0.05 | — | 10 | **false** |
| `black-forest-labs/flux.2-max` (replicate) | 0.03 | 0.03 | +0.04 run fee | 8 | true |

The settlement bills `ceil(request_meta.input_mp)` + `max(1, ceil(output_mp))` on Azure (the registry's own comment: "Azure rounds input and output megapixels up to whole billable units") and whole megapixels per image on Replicate — with up to 8–10 reference images whose dimensions are caller-controlled pre-download (the download path caps bytes at 20 MB but not dimensions; PNG dimensions decouple from bytes). The preflight, however, has no request facts at all: `getDefinedRequestEstimate` returns **one** megapixel's rate (flux.2-pro: $0.01125 effective) and Tinybird's mean only applies above the outlier ratio, so `canCoverEstimatedCharge` admits:

- a $0.02 pack balance for a 2048×2048 flux.2-pro render with eight references that bills 5 output MP + up to 32 input MP ≈ **$0.42 effective** — a ~30x under-reservation, repeatable per request (key budget the same: `atomicAdjustApiKeyBalance` has no floor — issue 31's open fix);
- quest-tier callers on `flux.2-flex` (paidOnly: false) at $0 tier balance for up to 15 output MP + 40 input MP ≈ **$2.06** per request, settling into Quest Pollen debt the platform absorbs (the documented mean-admission loss channel, R17's "wallet overdraft on the mean admission").

## Safe reproduction (deterministic arithmetic, no live spend)

Registry-level (the convention of issues 32/35/62): `getEstimatedPrice({data: []}, "black-forest-labs/flux.2-pro", definition, {requestedMegapixels: 4.19, referenceImageCount: 8})` returns the one-megapixel price on main; the same call must return `5 × 0.01125 + 8 × 4 × 0.01125 + 0.01125` under the fix. `test/request-estimate-permegapixel.test.ts` (9 tests) pins the bound math, the multiplier consistency, the mean-never-lowers rule, the reference clamp, and the exclusions.

## Fix (mirrors `solution31-video-persecond-preflight-worstcase`)

1. **Thread the validated request facts** into `generationAccess`/`checkBalance`: output dimensions from the query's `width`/`height` (GET `/image`, `/video`) or the JSON body's `size` (`POST /v1/images/*`), reference count from `image` — read only after the route's zod validator ran; routes without such fields keep the mean unchanged. The multipart edits route has no validated JSON body, so it keeps the mean (documented).
2. **`getEstimatedPrice` gates per-MP models on the worst case:**
   `ceil(requested output MP) × output rate + referenceCount × maxInputMegapixels × input rate + per-generation flat adjustments`, all through `getPriceDefinitionForModel` (so `priceMultiplier` and the adjustment pricing `cost × multiplier` match the settlement exactly); the Tinybird mean never lowers the bound.
3. **Declare `maxInputMegapixels: 4`** on the FLUX.2 family — BFL's published FAQ documents the per-image ceiling ("FLUX.2 generates images up to 4MP; input images over 4MP are automatically resized"), and Replicate's flux-2 logs show the same resize (a 6.29 MP input is resized to 4.00 MP). The provider enforces the bound, so the preflight's input leg is provider-grounded, not a policy guess — this was the blocker that kept the round-17 lead below gate.
4. **Clamp the reference count** to `maxReferenceImages` (requests above the cap are rejected later and never generate).

Over-reservation is the accepted worst-case-gate tradeoff (the same one the per-second fix made): a caller requesting 8064×8064 gates on ~65 output MP even if the provider clamps to 4 MP generation.

## Exclusions (documented residuals)

- The fal-tier models (`flux-3-image-klein`, `qwen-image-2.1`) price `completionImageTokens` with a `quantity: 1_000_000` tier unit whose bill depends on fal's **reported** units (BFL tiers 1K=1…4K=4), not request-computable facts; a declared per-request unit ceiling would be a product decision.
- The output-MP **settlement-side** cap (should the platform refuse >4 MP output requests?) is a separate product decision; this fix only makes the preflight honest about what the settlement bills.

## Verification

- New suite 9/9 green (whole-unit rounding, 4 MP ceiling, run fee, 0.75 multiplier consistency, mean-never-lowers, clamp, tier/token-model exclusion).
- `byop-markup` + `model-registry`: 55/55; `image/`: 957/957; `tsc --noEmit` clean.

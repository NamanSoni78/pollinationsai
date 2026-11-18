# Issue 104 — MAI usage-guard settle drops the output leg exactly when it is unreadable (companion to issue 91)

- **Severity:** Medium-High (billing integrity: the dominant cost leg of every MAI render settles $0 on the guard's own trigger path — the residual gap inside issue 91's fix)
- **Affected:** `gen.pollinations.ai/src/image/models/azureMaiImageModel.ts` (`settleMaiUsage` + the `returned no billing metadata` guard) — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution96-mai-output-leg-schedule-settle` — **stacked on `solution77-usage-guard-settlement-sweep`** (issue 91 / fork PR #107) — fork PR [#118](https://github.com/NamanSoni78/pollinationsai/pull/118)
- **Relationship:** issue 91 (PR #107) settled the usage-guard family, including Azure MAI's two guards. Its MAI settle is built from *readable receipt legs*: on the `returned no billing metadata` guard — whose trigger is precisely that `num_output_tokens` is missing or 0 — `settleMaiUsage(false)` **excludes the output leg**, and with no receipt at all the settle is `undefined`. The dominant cost therefore still settles $0: output tokens are priced at $34/M (MAI-Image-2.7), $19/M (2.6-Flash), $10/M (2.7-Flash) — ≈$0.035 per 2.7 image vs ≈$0.005 for a typical prompt's input legs. This companion fills that one leg with Microsoft's published per-image output token schedule; every other site of issue 91's sweep is untouched.

## Root cause

Issue 91's conservative design ("settle every readable leg") has a blind spot at MAI: the guard fires **because** the output leg is unreadable, so a readable-legs-only settle can never cover it. The delivered `b64_json` proves the render was paid; the amount is knowable from Microsoft's own published pricing.

## The published schedule (the settle source)

Microsoft's announcement and the Azure model catalog (2026-11-17) publish per-image prices at 1024×1024; dividing by the registry's per-token output rates gives tokens per image:

| Deployment | Published price | Registry output rate | Tokens/image |
|---|---|---|---|
| MAI-Image-2.7 | ~$35 per 1,000 images (microsoft.ai) | $34/M | **1,030** |
| MAI-Image-2.7-Flash | ~$10 per 1,000 images (microsoft.ai) | $10/M | **1,000** |
| MAI-Image-2.6-Flash | $19.46 per 1,000 (Artificial Analysis, 2026-10-27) | $19/M | **1,024** |
| MAI-Image-2.6 | no published per-image figure — borrows 2.7's count (same family, same 4,096-token output cap) | $38/M | 1,030 |

The Azure catalog caps output at 4,096 tokens per request, bounding the schedule's error.

## Fix

The `no billing metadata` guard (image delivered) attaches `billedUsage: { ...readableInputLegs, completionImageTokens: deliveredImages × schedule(deployment) }`. The `no image` guard keeps issue 91's reported-legs-only settle (no artifact = a schedule settlement is not justified). Constants live next to `MAI_ROUTES` with the citations above.

## Safe reproduction (red on the stacked base, green with the companion)

`test/image/usage-guard-settlement.test.ts` (issue 91's own suite, extended):
- **B1 re-pinned:** unusable receipt + delivered image → `{ promptTextTokens: 12, completionImageTokens: 1000 }` (RED on solution77's head: the output leg is missing)
- **B1b (new):** no receipt at all + delivered image → `{ completionImageTokens: 1030 }` (RED on the base: `billedUsage: undefined`)
- **B1c (new):** 2.6-Flash partial receipt → `{ promptTextTokens: 30, promptImageTokens: 8, completionImageTokens: 1024 }` (RED on the base)

**3 tests fail on solution77's head; 23/23 pass on the companion** (issue 91's other 8 tests untouched).

## Verification

- Stacked suite 23/23 (incl. issue 91's originals); `test/image/azureMaiImageModel.test.ts` untouched and green
- `npx tsc --noEmit` clean; biome clean; no live probes ($0 spend)

## Composition

One guard body + the constants on top of PR #107 — rebases cleanly in either merge order.

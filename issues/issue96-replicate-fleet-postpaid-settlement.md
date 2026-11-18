# Issue 96 — The Replicate fleet's post-paid settlement sweep: every download/decode failure after a SUCCEEDED prediction settles $0

- **Severity:** High (billing integrity: 100% revenue loss per affected request — the class of issues 25/72/81/82/91, at the exact fleet issue 82 named as its residual)
- **Affected:** `image/utils/replicateClient.ts` (paid-event boundary), `image/models/seedanceV2VideoModel.ts` (`:122-124`), `seedanceReplicateVideoModel.ts` (`:135-137`), `wanVideoModel.ts` (`:281-283`), `seedance25VideoModel.ts` (`:96-103` guard + `:114-116` download), `prunaModel.ts` (`:351` p-video download + the DeepInfra `:137-141` no-image leg), `qwenImageModel.ts` (`:128-131`), `wanImageModel.ts` (`:136-150`), `seedreamReplicateModel.ts` (`:262-265`), `ideogramReplicateModel.ts` (`:176-179`), `replicateFallbackImageModel.ts` (`runReplicateImage` download), `veoVideoModel.ts` (`:271-273`, the Replicate leg solution72's fix did not reach — it patched the Vertex poll path only, diff-verified) — upstream `pollinations/pollinations` main @ `282ac54aeb` (2026-11-18)
- **Fix branch:** `solution89-replicate-fleet-postpaid-settlement` — fork PR [#109](https://github.com/NamanSoni78/pollinationsai/pull/109)
- **Dedup:** issue 82's own text names this scope as its residual (*"The Replicate fleet's no-output/download legs … seedanceV2/seedanceReplicate/wanVideo/seedance25/qwenImage/wanImage/seedreamReplicate/ideogramReplicate/replicateFallback/pruna p-video + DeepInfra"*); issue 91/PR #107 re-confirmed the handoff and owns only the **usage-guard** family. No prior branch touches any of these files (verified via `git log --all` per path and full diffs of solution72/75/76/77/86).

## Root cause

`middleware/track.ts:793-826` settles a failed request only from `error.billedUsage`. `runReplicatePrediction` returns the output URL once the prediction reaches `succeeded` — the provider has billed the completed run (every model in this fleet is priced per output unit: per video-second, per image, per megapixel; Replicate's billing docs: *"if a run fails, we don't charge you"* — the inverse is the paid event). Every client then downloads the artifact with `fetchUpstream`, and a failed download (or a mid-download body-read failure, or a post-success guard) throws with no `billedUsage` — the platform pays Replicate, the caller pays $0. The DeepInfra leg is the same shape with the receipt in-band: a 200 whose `inference_status.cost` proves the charged inference, followed by a no-image throw.

## Sites (all verified red on unpatched main)

| # | Family | Paid throw site | Settled usage |
|---|---|---|---|
| R1-R5 | video download legs | seedance-2.0, seedance-1-pro-fast, wan-2.6, seedance-2.5, pruna p-video | `videoOutputDurationSeconds` metric first, requested duration second |
| R6 | seedance-2.5 adaptive guard | succeeded + output URL + missing duration metric | the model's `DURATION` floor (4 s) |
| R7 | veo:replicate download | `google/veo-3.1-fast` output fetch fails | requested seconds + the audio seconds when `generate_audio` |
| R8-R11 | image download legs | qwen-image, wan-2.7-image, seedream, ideogram | flat `{ completionImageTokens: 1 }` |
| R12 | replicateFallbackImageModel | per-megapixel routes (flux.2-pro/max) + flat routes | provider megapixel metrics first, the identical local fallback math second |
| R13 | DeepInfra no-image | 200 + `inference_status.cost` receipt present | `{ completionImageTokens: 1 }` — receipt-gated (AI3-style discriminator) |

## Fix

Attach `error.billedUsage` at each paid throw site with the exact units the success path reports: provider metrics first (`video_output_duration_seconds`, `image_input/output_megapixel_count`), the same local fallback math second (requested duration / width×height — the values the success paths already compute). `runReplicateImage` gains the estimate as a parameter so its flux.2 call sites pass their local megapixel math. Prediction-phase failures stay **unbilled** (Replicate documents failed/canceled runs are not charged; all models here are per-output-unit so a canceled run has $0 units) and null/empty outputs stay **unbilled** (no billable units) — both pinned as control tests, the same convention issues 72/76/82/91 applied.

## Safe reproduction (isolated, red on unpatched main)

`test/image/post-paid-failure-settlement-replicate.test.ts` — 14 settlement assertions (RV1-7, RI1-7) + 4 correctly-unbilled controls (RC1 failed prediction, RC2 null output, RC3 empty output array, RC4 DeepInfra no-receipt). Every settlement assertion fails on unpatched main with `billedUsage: undefined`; all pass on the fix branch.

## Verification

- New suite 18/18 (14 red→green + 4 controls); full `test/image/` suite **975/975 green** (49 files); `tsc --noEmit` clean
- No live probes; $0 spend (all findings reproduce deterministically offline)
- Composes with the unmerged `solution86-fallback-paid-leg-settlement` (its track.ts machinery settles rescued fallback attempts once `billedUsage` exists) and `solution76`/`solution77` (no file overlap)

## Residuals for the next round

- The generic `"Prediction succeeded but output is missing"` throw (`replicateClient.ts:173-175`): below gate — every model here is per-output-unit priced, so a null-output prediction bills the provider $0 (settling it would overcharge callers); revisit only if a per-compute-time model joins this client.
- azureMai/azureFluxKontext metadata guards and `requireAlibabaUsage`: **owned by concurrent issue 91 / PR #107** — not duplicated here.

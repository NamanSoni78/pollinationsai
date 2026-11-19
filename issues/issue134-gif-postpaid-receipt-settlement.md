# Issue 134 — The GIF-era generation clients: every post-paid failure settles $0 (Hotshot-XL Replicate GPU seconds + fal GPT-image billable units — issue 96's pre-registered per-compute-time trigger, on a mechanism `billedUsage` cannot express)

- **Severity:** High (billing integrity: 100% revenue loss per affected request — the F-04 class of issues 25/72/81/82/91/96/113/120/124/130/131, on the two generation clients the 2026-11-19 GIF commits added or newly exercised; per-request loss bounded by the 6-minute Replicate deadline at 360 GPU-s × $0.000975 = $0.351, p50 $0.033 per Replicate's own model page; the fal legs lose the full fal charge, a multiple of a still for a 16-frame GIF. The wrapped 502s are retryable (`fallback.ts`), so a flaky Replicate CDN re-runs the paid generation — the same hidden double-spend issue 131 documented)
- **Affected:** `gen.pollinations.ai/src/image/models/hotshotXLModel.ts:27-55` (new file, commit `817de09ecc`/#20352), `gen.pollinations.ai/src/image/createAndReturnImages.ts:560-583` (`callFalGPTImage`, legs predating this range but first GIF-exercised by `4c628e01cc`/#20351 `params.ts:183-185`), settle gate `gen.pollinations.ai/src/middleware/track.ts:793-827`, receipt plumbing `shared/registry/registry.ts:526-546` + `shared/registry/image.ts:15-64` — upstream `pollinations/pollinations` main @ `5bb395d566` (2026-11-19)
- **Fix branch:** `solution134-gif-postpaid-receipt-settlement` (`8fe4a2fa3d`, off `5bb395d566`) — fork PR [#150](https://github.com/NamanSoni78/pollinationsai/pull/150)
- **Dedup:** issue 96 (`solution89`, the Replicate fleet sweep @ `282ac54aeb`) enumerates 13 model files — `hotshotXLModel.ts` did not exist yet, and its own "Residuals for the next round" says the per-compute-time null-output throw is *"below gate — revisit only if a per-compute-time model joins this client"*: `lucataco/hotshot-xl` is exactly that model, with three additional post-paid legs. The fal legs: `git grep` over every `fork/solution*` branch verified none touches `createAndReturnImages.ts` (solutions 75/76/89 file lists exclude it; the sweeps only covered `models/*.ts` clients); the throw sites predate this range (`b8c97f4a76`, 2026-11-05) but were never filed, and #20351's GIF enablement is what routes new traffic through them. Issues 131/130/113 are per-route-instance family neighbors, none covering these files. `git grep -i hotshot` over `issues/*.md`, `filtered_issues/*.md`, `WORKLOG.md`, `FINDINGS.md` on `issues_mds`: no matches.

## Root cause

`middleware/track.ts:793-827` settles a failed request **only** from `error.billedUsage` (a token-typed `Usage`). Both clients' money lives where token usage cannot express it:

- **Hotshot-XL** — Replicate bills per GPU-second for `lucataco/hotshot-xl` (shared L40S; parity verified: registry `HOTSHOT_XL_GPU_SECOND_COST = 0.000975` matches replicate.com/pricing exactly, version pin `78b3a625…` is the latest). The paid event is the prediction reaching `succeeded` — `runReplicatePrediction` returns only then. All four downstream legs throw with no settlement: the `predict_time` guard (`:27-31`), the artifact download (`:32-34`), the raw `Buffer.from(await response.arrayBuffer())` torn read (`:35`, a raw `TypeError` that is not even an `UpstreamError`), and the GIF magic validation (`:36-41`). The structural wrinkle: the registry entry is `cost: {}` — the GPU-second price exists only as the `replicate.hotshot_xl.gpu_seconds.v1` billing adjustment whose `countUnits` reads `pricingInput.providerBilling.units` — so even the issue-96 fix pattern (attach token `billedUsage`, e.g. the `{completionImageTokens: 1}` floor) prices **$0**. The error path structurally could not express the charge before this fix.
- **fal GPT-image legs** (`openai/gpt-image-2.6-{flare,sunburst}:fal`) — `falBillableUnits(response)` reads the `x-fal-billable-units` receipt at `:560`, then every failure throws it away: the unguarded `await response.json()` (`:561-563`, raw `SyntaxError`), the no-image leg (`:564-569`), and the artifact download/data-URL decode (`:570-572`, the download also deadline-less). The success path settles `providerBilling: {units, unitCost: 1}` (fal's pricing API reports $1/unit); the error path settles $0 with the receipt in hand.

## Safe reproduction (deterministic offline; $0 live)

`gen.pollinations.ai/test/image/postpaid-receipt-settlement.test.ts` (new file, 12 cases) — the 7 settlement cases are **RED on unpatched `5bb395d566`** via stubbed `globalThis.fetch` (no provider spend; observed 7 failed / 5 passed):

| Case | Unpatched main | Fixed |
|---|---|---|
| H1 hotshot: artifact download network-reject | 502, receipt `undefined` | 502 + `{units: 9.95, unitCost: 0.000975}` |
| H2 hotshot: artifact 200 HTML (not a GIF) | 502, receipt `undefined` | 502 + `{units: 12.5, …}` |
| H3 hotshot: artifact body tears mid-read | **raw `TypeError`** escapes | 502 `UpstreamError` + receipt |
| H4 hotshot: SUCCEEDED run, `predict_time` missing | 502, receipt `undefined` | 502 + 1-GPU-second floor receipt |
| F1 fal: 200 + receipt + unparseable body | **raw `SyntaxError`** escapes | 502 `UpstreamError` + `{units: 0.05, unitCost: 1}` |
| F2 fal: 200 + receipt + `{"images":[]}` | 502, receipt `undefined` | 502 + receipt |
| F3 fal: 200 + receipt + artifact download reject | 502, receipt `undefined` | 502 + `{units: 0.0248, unitCost: 1}` |

The 5 controls pin the intended negatives and unchanged behavior: prediction `status:"failed"` stays **unbilled** (Replicate does not charge failed runs — the issue-96 convention), a fal response without the billable-units header stays **unbilled** (receipt-gated, the DeepInfra discriminator convention from issue 96 R13), both success paths' `trackingData.providerBilling` unchanged, and the registry math is pinned end-to-end (`calculateUsageBilling` with `usage: {}` + a 10 GPU-s receipt → cost/price `0.00975`, multiplier 1).

## Fix (`solution134-gif-postpaid-receipt-settlement`)

A trusted-receipt settlement path, mirroring the success path's own plumbing (`extractUsageHeaders` → `pricingInput.providerBilling` → the `calculateUsageBilling` override at `registry.ts:537-546`):

- `shared/error.ts`: `UpstreamError.billedProviderBilling?: {units, unitCost}` (option + readonly field) and `withProviderBilling(error, receipt)` — attaches the receipt to a post-paid `UpstreamError` (preserving status/message/requestUrl/responseBody/upstreamHeaders), wraps raw non-`UpstreamError` throws (torn reads, parse failures) as receipt-carrying 502s, and passes everything through untouched while `receipt` is `undefined`.
- `middleware/track.ts` error branch: reads `error.billedProviderBilling`; the not-billed gate becomes `!usage && !billedProviderBilling` (implausible-usage check unchanged, still token-gated); the billing call passes `input: {...pricingInput, providerBilling: receipt}` so the adjustment/override settles units × unitCost exactly as the success path does; `usage` falls back to `{}` for receipt-only failures.
- `hotshotXLModel.ts`: `gpuReceipt` is set the moment `runReplicatePrediction` returns (a succeeded run has been charged; a missing `predict_time` metric settles the 1-GPU-second floor — the issue-96 family convention for unknown paid counts) and every throw after that point flows through `withProviderBilling`; prediction-phase failures keep the receipt `undefined`.
- `callFalGPTImage`: `falReceipt = {units, unitCost: 1}` is bound right after `falBillableUnits` succeeds and the guarded tail (parse → no-image → download/decode) rethrows through `withProviderBilling`.

## Verification

- RED on unpatched main: **7 failed / 5 passed** → GREEN on the fix branch: **12/12** (`test/image/postpaid-receipt-settlement.test.ts`).
- Full gen image suite: **983/983** (49 files, incl. the sibling `gptImageRouting`/`replicateClient`/`seedance25` harnesses); error-observability **169/169** (the round-44 baseline — platform-provider `upstreamHost`/body retention behavior unaffected); billing-deduction + collectErrorData **26/26**; media **82/82**.
- `gen` `tsc --noEmit` clean; `media` standalone tsc shows only the pre-existing `request-inputs.ts(139)` `instanceof File` error; `enter` tsc shows only the 2 pre-existing `accountPermissions` errors (both documented in rounds 44-45, side-by-side unchanged).
- Live probes: **$0** (offline stubbed-fetch red/green only, per the round-38+ discipline).

## Notes for reviewers

- The change is opt-in per throw site: no existing `billedUsage`-carrying error changes behavior (`withProviderBilling` returns errors that already carry a settlement untouched; the `!usage` gate is only widened when a receipt exists).
- The 1-GPU-second floor (H4) mirrors issue 96's R6 precedent (seedance-2.5's DURATION floor) for a succeeded run with a missing metric; if maintainers prefer unbilled there, dropping the floor is a one-line change and the control flips.

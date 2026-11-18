# Issue 81 — Post-paid failure settlement residuals: the fal-fallback media legs + the entire model3d fleet (issues 25/72's named leftovers)

- **Severity:** High (billing integrity: 100% revenue loss per affected request — same class as issues 25/72)
- **Affected:** `image/models/falFallbackMediaModel.ts` (non-grok image/video legs + Mirelo SFX), `model3d/models/inferenceportClient.ts`, `model3d/models/trellis2Model.ts`, `model3d/models/assetHarvesterModel.ts`, `model3d/models/rodinModel.ts`, `model3d/models/trellis2FalModel.ts`, `model3d/models/tripoP2Model.ts`, `model3d/models/falClient.ts`, `model3d/modelUtils.ts`, `model3d/handler.ts` — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution75-postpaid-settlement-model3d-fal-residuals` (name verified unique at push; index kept from this session's numbering) — fork PR [#89](https://github.com/NamanSoni78/pollinationsai/pull/89)
- **Relationship:** issue 72 closed with two explicitly-named residuals it did not reach ("`falFallbackMediaModel` non-grok `download()` and `model3d/inferenceportClient` (issue 25's list) — not reached by this round's verification; still open residuals"). This branch settles both, plus the model3d fal fleet that neither 25 nor 72 ever listed (their sweeps only covered image/audio clients). Found by a parallel read-only settlement subagent, then main-agent-verified line-by-line against `282ac54aeb`.

## Root cause

Identical to issues 25/72: `middleware/track.ts:793-798` bills a failed request only from `error.billedUsage`, and that field exists only when the thrower sets it. Every failure **after the provider's paid event** threw without it, so the caller was settled at $0 while the provider billed the platform.

The paid events per client: the shared fal queue client returns only after `status === "COMPLETED"` (fal bills completed jobs — documented in `falClient.ts:79-80`, including jobs whose result fetch then fails); InferencePort reports `job.status === "completed"` and charges payg credits (`usage.payg_credits_charged`) on completion.

## Sites (all verified red on unpatched main; every test asserted `billedUsage: undefined` before the fix)

| # | Client | Trigger after the paid event | Settled usage |
|---|---|---|---|
| F1 | Seedream 5 Lite image | COMPLETED, `images[0]` missing | `{ completionImageTokens: 1 }` |
| F2 | Seedream 5 Lite edit | output download fails | `{ promptImageTokens: N, completionImageTokens: 1 }` |
| F3 | wan-2.6 / wan-2.2-fast / seedance-1-pro-fast / heygen / kandinsky / grok-1.5 video legs | missing video / download fails / missing `x-fal-billable-units` receipt / malformed result JSON | requested seconds (+ start-frame tokens) |
| F5 | Mirelo SFX 2.0 | result parse / download fails after the receipt | fal's reported seconds |
| F7 | grok control | missing duration — **stays unbilled on this branch** (solution14 owns the site; pinned by a test) | — |
| I1–I2 | InferencePort | completed with invalid charge / no output | `{ completionImageTokens: 1 }` (the registry's flat 3D unit) |
| I3/I4 | trellis2 / assetHarvester wrappers | PLY-only delivery / GLB-only delivery (runInferenceport returned = charged) | same |
| R1–R3 | rodin (fal) | no mesh / result-fetch failure / mesh download failure | flat 3D unit |
| T1–T2 | trellis-2:fal | no mesh / mesh download failure | flat 3D unit |
| P1 | tripo3d/p2 | mesh download failure after the 220-unit receipt | `billableUnits / 110` normalized tokens |
| H1 | model3d handler | provider returned an empty buffer | the model's own `trackingData.usage`, defaulting to the flat unit |

## Fix

- `runFalJob`/`runFalJobResponse` take an optional `paidUsage` and settle the post-`COMPLETED` result fetch and JSON parse failures — with `FalError` 422s passed through **unconverted** so `falFallbackMediaModel`'s `billsRejectedVideos` pre/post-generation classification (the merged #15483 behavior) keeps working; the two existing grok rejection tests pin this
- Inner catches attach the success path's usage at every download/extract/parse site; `modelUtils.toUpstreamError` propagates settlement attached to `InferenceportError`/`FalError` through conversion; `assertNonEmptyMedia` settles the model's own usage
- Composition discipline: the grok missing-duration, minimax/kling no-video and sonilo no-audio sites are left untouched (solution14's unmerged branch owns them)

## Safe reproduction (isolated, red on unpatched main)

`test/image/post-paid-failure-settlement-residuals.test.ts` (7 tests) and `test/model3d/post-paid-failure-settlement.test.ts` (11 tests), both mirroring solution72's harness. **17 tests fail on unpatched main** with `billedUsage: undefined`; all 17 pass on the fix branch.

## Verification

- New suites 18/18 (incl. the grok composition control)
- All pre-existing `test/model3d/` suites + the fal image client suites (`falFallbackMediaModel`, `falQwenImage21`, `zImageFalModel`, `zImageFalFallback`, `recraftFalModel`, `wan3FalVideoModel`, `falFallback`): **167/167 green**
- `tsc --noEmit` clean
- No live probes; $0 spend

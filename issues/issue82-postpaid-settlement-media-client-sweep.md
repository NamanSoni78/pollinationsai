# Issue 82 — Post-paid failure settlement, part 2: the xAI-image / DashScope / kling / minimax / sonilo / lyria media client sweep

- **Severity:** High (billing integrity: 100% revenue loss per affected request — same class as issues 25/72/81)
- **Affected:** `image/models/xaiModel.ts`, `image/models/alibabaVideoModel.ts`, `image/models/alibabaImageModel.ts`, `image/models/klingVideoModel.ts`, `image/models/minimaxH3Model.ts`, `audio/sonilo.ts`, `audio/lyria.ts` — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution76-postpaid-settlement-media-client-sweep` (name verified unique at push) — fork PR [#91](https://github.com/NamanSoni78/pollinationsai/pull/91)
- **Relationship:** companion of issue 81 / PR #89 — the second half of the settlement residual list. The audit subagent's fleet sweep found these sites unlisted by issues 25/72; each was main-agent-verified against `282ac54aeb` before fixing.

## Root cause

Same class as issues 25/72/81. The paid events: xAI returns 200 with `data[0].url` in hand (the render was billed); DashScope reports `task_status: "SUCCEEDED"` (completed tasks are billed — and `callAlibabaMedia` only returns on SUCCEEDED); fal reports queue `COMPLETED` and its `x-fal-billable-units` receipt has been read (kling/minimax); fal's completed job delivered its audio URL (sonilo) or receipt (lyria); Google's Lyria interaction is `completed`.

## Sites (all verified red on unpatched main)

| # | Client | Trigger after the paid event | Settled usage |
|---|---|---|---|
| X1–X2 | xaiModel (image) | result download fails (generate / edit mode) | `completionImageTokens: 1` (+ `promptImageTokens: N` in edit mode) |
| AV1 | alibabaVideoModel | download fails after SUCCEEDED + usage read | reported output seconds (+ input seconds when > 0) |
| AV2 | alibabaVideoModel | SUCCEEDED without a `video_url` | requested duration (receipt lost with the payload) |
| AI1 | alibabaImageModel (async route) | download fails after SUCCEEDED + counts read | `completionImageTokens: outputCount` (+ input count where billed) |
| AI2 | alibabaImageModel (async route) | SUCCEEDED without an image | flat single-image unit |
| AI3 | alibabaImageModel (sync routes) | 200 without an image — **stays unbilled** (not provably paid; pinned by a control test) | — |
| K1 | klingVideoModel | download fails after the receipt-derived seconds | `completionVideoSeconds: billedSeconds` (+ audio leg) |
| M1 | minimaxH3Model | download fails after the receipt | reported `durationSeconds` |
| S1–S2 | sonilo | download fails / oversized output | fal's reported seconds |
| L1–L3 | lyria (fal leg) | no audio / download fails / empty delivery | reported `completionAudioTokens` |
| L4 | lyria (google leg) | not-completed guard — **stays unbilled** (payment not provable; pinned by a control test) | — |

## Fix

`.catch`/inner-try wrappers attach the already-computed success-path usage at every post-paid throw, mirroring issue 72's `falQwenImageModel` style. The async/sync discriminator on the alibaba image route (`route.asynchronous`) gates the no-image settlement so sync 200-without-image is never billed. Sonilo's no-audio site is left to solution14's unmerged branch (composition discipline).

## Safe reproduction (isolated, red on unpatched main)

`test/image/post-paid-failure-settlement-media-sweep.test.ts` (9 tests) and `test/audio/post-paid-failure-settlement-audio.test.ts` (6 tests). **14 tests fail on unpatched main** with `billedUsage: undefined`; all 14 pass on the fix branch (the 2 controls pass both sides by design).

## Verification

- New suites 15/15 (incl. the AI3/L4 composition controls)
- Pre-existing suites for every touched client (`xaiModel`, `alibabaMediaModel`, `alibabaImageModel`, `klingVideoModel`, `minimaxH3Model`, `sonilo`, `lyria`, `lyria-billing`): **122/122 green**
- `tsc --noEmit` clean
- No live probes; $0 spend

## Named residual for the next round

The Replicate fleet's no-output/download legs (`replicateClient.runReplicatePrediction`'s generic "Prediction succeeded but output is missing" plus the per-model legs in seedanceV2/seedanceReplicate/wanVideo/seedance25/qwenImage/wanImage/seedreamReplicate/ideogramReplicate/replicateFallback/pruna p-video + DeepInfra), `inferencePortImageModel`'s download leg, and the usage-guard family (azureMai/azureFluxKontext/`requireAlibabaUsage`) — same class, settlement needs per-model estimate machinery; recorded here the same way issues 25/72 named their residuals.

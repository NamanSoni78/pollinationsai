# Issue 72 — Post-paid failure settlement: the class-wide sweep issue 25 left open (11 media clients throw unbilled after the provider's paid event)

- **Severity:** High (billing integrity: 100% revenue loss per affected request; provider anomalies and poll deadlines are caller-amplifiable via long renders)
- **Affected:** `veoVideoModel.ts`, `xaiVideoModel.ts`, `openRouterVideoModel.ts`, `geminiOmniVideoModel.ts`, `wan3FalVideoModel.ts`, `kreaModel.ts`, `fluxMaxVideoModel.ts`, `grokReplicateVideoModel.ts`, `falQwenImageModel.ts`, `zImageFalModel.ts`, `recraftFalModel.ts` — upstream `pollinations/pollinations` main @ `6989f4bb64`
- **Fix branch:** `solution72-postpaid-failure-settlement-sweep` — fork PR [#84](https://github.com/NamanSoni78/pollinationsai/pull/84)
- **Relationship:** issue 25 (`solution14-fal-queue-billed-usage-on-failures`, unmerged) fixed minimax/kling/grok-fal-duration/sonilo and closed with: *"Same-pattern sites verified by code reading but not PoC'd (left for a class-wide sweep): `wan3FalVideoModel` (3), `falFallbackMediaModel` non-grok `download()`, `lyria`, `veo`, `geminiOmni`, `openRouterVideoModel`, `model3d/inferenceportClient`."* This is that sweep, plus four clients issue 25 did not list (krea, fluxMax, xai-direct, grok-replicate — same root cause, no filed fix). Found this round by a parallel subagent settlement audit, then main-agent-verified line-by-line.

## Root cause

One root cause across the fleet, identical to issue 25's: `track.ts` bills a failed request only when the thrown `UpstreamError` carries `billedUsage`, and that field is set only by the thrower. Every failure that happens *after the provider's paid event* threw without it, so the settlement middleware saw `isBilledUsage: false` and deducted nothing while the provider billed the platform.

The paid event per client: Vertex accepts the `predictLongRunning` operation (veo, omni is synchronous but the completed video is in hand); xAI accepts the request id; OpenRouter/fal accept the queue job (and bill completed jobs even when we stop polling — the repo documents the hazard); Replicate bills succeeded predictions (grok). The settlement usage at each failure site is either the provider's reported value (in hand one line above the throw) or the requested duration/count the success path itself falls back to.

## Sites (verified on unpatched main; every test asserts `billedUsage: undefined` today)

| # | Client | Path | Trigger | Est. provider cost leaked |
|---|---|---|---|---|
| V1 | veo (Vertex) | 3-min poll 504 | long render / slow poll (90-attempt budget) | $0.32–0.96 |
| V2 | veo | `done` with no videos 500 / GCS-URI 500 | completed op, anomalous payload | same |
| X1 | xai direct | completed-without-URL 502 | `status: "done"`, no `video.url` | $0.15–2.25 |
| X2 | xai direct | poll 504 | request completes server-side after we stop polling | same |
| O1–O2 | OpenRouter (HappyHorse/HeyGen/grok-1.5) | poll 504, completed-without-URL 502, invalid-receipt 502, download failure | deadline / `completed` with no `unsigned_urls` | happyhorse ≈ $1.56 |
| G1 | gemini-omni | completed video in hand, usage rows lack the `video` entry → 502 | Google generated and billed the output video tokens | $0.35–1.05 |
| K1–K2 | krea (fal) | 120 s deadline 504 (post-submission), no-image 502, download | queue completed / deadline | flat per-image |
| W1–W3 | wan-3.0 (fal) | missing `x-fal-billable-units` receipt 502, no-video 502, no-duration 502, download | result anomaly after COMPLETED | 1080p ≈ $2.80 |
| F1 | flux-3-max (fal) | missing receipt, no-video 502, download | same | fal's live charge |
| R1 | grok (Replicate) | succeeded prediction without the duration metric 502, download | metrics anomaly | ≈ $0.42 |
| Q1 | qwen-image-2.1 / flux-3-klein / z-image / recraft (fal sync) | output download failure **after** the fal receipt was read and the usage computed | transient fetch failure | $0.007–0.37 |

## Deliberately NOT settled (recorded)

- Provider-side `FAILED`/`failed`/`cancelled`/`expired` terminal ops — a concurrent session disproved (vs fal's published docs) that fal bills FAILED jobs; no evidence the others bill failures.
- Pre-submission failures (submission timeout, no request id) — the provider never accepted the job.
- The xAI post-render **moderation** throw — issue 2's unmerged branch (`solution2-xai-video-post-render-billing`) owns it; this branch leaves that throw untouched so the two compose.
- Gemini-omni **1.1** has no in-repo per-second video token evidence, so its G1 settlement covers the reported legs only (the 1.2 estimate uses the registry's documented 1931/5792/8688/17376 tok/s — the same rates the settlement trusts when the row is present).
- The fal-sync **missing-units-header** variant on qwen/z-image/recraft (units unknowable → estimate-only; weak gate).
- The image usage-guard family (`azureMaiImageModel` "returned no billing metadata", vercel/vertex cross-check failures, OpenRouter image usage guards, `requireAlibabaUsage`) — same class but the settlement needs per-model estimate machinery; recorded here as the named residual for the next round, the same way issue 25 named this sweep.
- `falFallbackMediaModel` non-grok `download()` and `model3d/inferenceportClient` (issue 25's list) — not reached by this round's verification; still open residuals.

## Safe reproduction (isolated, red on unpatched main)

`gen.pollinations.ai/test/image/post-paid-failure-settlement.test.ts` (15 tests, mirrors issue 25's harness): stubbed `fetch` per client, clock jumps for deadline paths. Each test drives the client to the post-paid failure and asserts the thrown `UpstreamError.billedUsage` equals the exact expected usage. **All 15 fail on unpatched main with `billedUsage: undefined`** (verified by running the identical file against `6989f4bb64`); all 15 pass on the fix branch.

## Fix

Attach `billedUsage` at every post-paid throw, mirroring each success path's usage with the provider's reported value when it is in hand (e.g. xAI's `video.duration ?? requested`, wan-3.0's `result.duration ?? requested`, gemini-omni's documented tok/s × requested duration, krea's flat per-image unit). Poll-deadline helpers (`krea`'s `remainingTime`) take the paid usage as an optional parameter after the submission, exactly like issue 25's minimax fix. Download failures wrap the fetch and re-throw with the already-computed usage attached.

## Verification

- New suite 15/15 green on the branch (red on main, above).
- The ten touched per-model regression suites: 91/91.
- `tsc --noEmit`: clean.

# Issue: post-paid failures in fal-queue media wrappers throw without `billedUsage`

**Severity:** High (billing integrity)
**Status:** Confirmed by real-module PoC against unpatched `549feee95b` (2026-11-18)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/34 (branch `solution14-fal-queue-billed-usage-on-failures`)

## Summary

`track.ts` bills a failed request only when the thrown error is an `UpstreamError` carrying `billedUsage`, and that field is set only by the thrower. On the fal-queue media legs, every failure that happens *after the provider's paid event* throws without it, so the caller is charged nothing while fal bills the platform. The repo documents the hazard in three places ("Fal still runs and bills a job we stop polling"; "fal can keep running and billing the job after a polling connection drops"; "fal bills a video that xAI's moderation rejects after generating it"), and the platform already accepted the same class for the xAI video (issue 2) and AssemblyAI (issue 3) legs.

## Root cause

One root cause across five wrappers: the billing usage value exists at the failure site (requested duration or fal's reported units) but is not attached to the throw, so the settlement middleware sees `isBilledUsage: false` and deducts nothing.

## PoC (real modules, mocked upstream only; exit 1 on unpatched code)

Five instances, all exiting the paid phase — S1 MiniMax H3 poll timeout (504, `billedUsage: undefined`), S2 MiniMax H3 `COMPLETED` (`x-fal-billable-units: 6.2`) with no `video.url` (502), S3 Kling same on its queue (502), S4 grok:fal `COMPLETED` with `video.url` but no `duration` (502 — the sibling moderation path in the same function already attaches it), S5 Sonilo SFX `COMPLETED` without `audio.url` (502). Control: an identical flow *with* output succeeds and bills via `trackingData.usage` — the units exist; only the failure paths drop them.

## Impact

Every fal-queue video/audio leg that fails after the provider's paid event (result anomaly, missing output field, missing duration, download failure, poll timeout where the job later completes) is a 100% revenue loss for that request, repeatable at will on provider anomalies; the timeout variant is attacker-amplifiable via long queue times. `providerBilling` is only recorded on success, so the losses are invisible in telemetry.

## Fix

Every failure after the paid event now carries `billedUsage`: `remainingTime` takes an optional `paidUsage` (poll/result timeouts 504 + invalid-billing-units + no-video 502 in `minimaxH3Model`); the billed-seconds computation is hoisted into a `usage` value attached to the no-video throw and reused by the success return in `klingVideoModel`; the grok missing-duration throw attaches the in-scope `usage` (mirroring the moderation path) in `falFallbackMediaModel`; the no-audio throw attaches `createCompletionAudioSecondsUsage(units)` in `sonilo.ts`. `test/image/fal-queue-billed-usage.test.ts` (new, 7 tests) pins each with exact usage values plus both controls; 128 tests green across the touched suites. Same-pattern sites verified by code reading but not PoC'd (left for a class-wide sweep): `wan3FalVideoModel` (3), `falFallbackMediaModel` non-grok `download()`, `lyria`, `veo`, `geminiOmni`, `openRouterVideoModel`, `model3d/inferenceportClient`.

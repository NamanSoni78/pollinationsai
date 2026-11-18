# Issue 64 — ElevenLabs Music ingestion pays the provider before any exact-charge gate; composition_plan bypasses the duration contract (companion to the ingestion caps)

- **Severity:** High (monetary integrity — issue-36 class on the music path)
- **Affected:** `gen.pollinations.ai/src/routes/audio.ts` (`dispatchAudioGeneration` music branch, `generateMusic`, `fetchReferenceAudio`) — upstream `pollinations/pollinations` main @ `52fd0a6c8`
- **Status:** Verified at `52fd0a6` by 13 isolated tests over the real registry, the real route code and the real `music-metadata` probe (9 red on unpatched main, including both route-level vulnerability cases); full audio suite 41/41 and `tsc --noEmit` clean on the fix branch
- **Fix branch:** `solution64-music-ingestion-funds-gate` — **PR:** [#76](https://github.com/NamanSoni78/pollinationsai/pull/76)
- **Relationship:** A concurrent session delivered the **caps** half of this finding as fork PR [#71](https://github.com/NamanSoni78/pollinationsai/pull/71) (branch `solution60-elevenlabs-music-ingestion-caps`): a 300 s post-upload reference cap (413 carrying `billedUsage` for the ingestion seconds) plus `composition_plan` total validation. Per the round-12/16 coordination convention this report is filed as the **companion that closes what a post-upload cap cannot**: refusing unfunded requests *before the provider is paid*, closing the within-cap admission gap, topping up the API-key reservation, and validating plans strictly against the registry's own contract. The two PRs compose (gate at dispatch, cap inside `generateMusic`) and each merges alone.

## Summary

`elevenlabs/music-v2` and `elevenlabs/music-v2.5` bill reference-audio ingestion at `$0.0025/s` for the uploaded clip's **full decoded duration** (ElevenLabs meters `$0.15/min`; the platform mirrors it via `createAudioSecondsUsage(uploadedReferenceDuration)`), and bill output seconds estimated from the returned MP3's byte size. Admission, however, is the model-level `generationAccess` estimate — Tinybird's historical **mean**, or the one-second defined estimate (`$0.0025`) for a cold model. The only input bound is the 20 MB **byte** cap in `fetchReferenceAudio`; nothing bounds the **duration**, and nothing between the mean-based admission and the settlement re-checks funds on the exact charge — the same structure issue 36 fixed for stem separation, on the one audio path where the exact charge is computable before the provider call (the reference fetch already buffers the whole file).

## Root cause

1. **Unbounded billed duration behind a byte cap.** 20 MB at 32 kbps decodes to **5,242 billed seconds → $13.11** of ingestion on a mean-admitted wallet (at 8 kbps, ~$52). PR #71's 413 path fires only **after** `uploadMusicReference` returns — ElevenLabs has already been paid for the full ingestion, and the `billedUsage` charge lands on a wallet that was admitted on the mean: with the settle floor still open (issue 31 / PR #36), the platform eats an uncollectable overdraft instead of never paying the provider.
2. **Within-cap admission gap.** Even inside #71's 300 s cap, a 300 s reference + 300 s plan output settles **$1.50** on a ~$0.51 mean (or $0.0025 cold) admission; no gate re-checks the exact charge pre-dispatch, and the API-key budget reservation stays sized to the mean.
3. **`composition_plan` bypasses the duration contract.** The parameter is `z.unknown()` and forwarded verbatim; `music_length_ms` is only sent when **no** plan is present, so a plan's chunk `duration_ms` values never meet `resolveAudioDuration`'s model-range check (3–300 s) — the documented contract applies only to the parameter the plan replaces. (#71 validates totals but silently forwards non-object/chunkless plans and hardcodes 300 s; this report reads `minDuration`/`maxDuration` from the model's own registry entry and 400s on malformed plans.)

## Impact

A `$0.51`-balance caller (or any positive balance on a cold model) is admitted for a request that settles up to `$13.11` (byte-capped worst case) of provider ingestion spend; repeatable per request until the balance gates later ones. With #71 merged alone, the same caller still triggers the full provider spend and a `billedUsage` overdraft on every over-cap upload, and up to `$1.50` of within-cap overdraft per request.

## Safe repro (isolated, non-destructive; red on unpatched `52fd0a6`)

`test/audio/music-ingestion-gate.test.ts` (new, 13 cases; 9 red pre-fix):

1. **Route: the byte-capped long reference is dispatched on main.** A 600× repeat of a 1 s 32 kbps fixture (~646 s, ~2.6 MB, inside the 20 MB fetch cap) served from a mocked reference host; `createTestApiKey` wallet `$1.00`; mocked Tinybird (cold model → `$0.0025` estimate). Pre-fix: upload + generation dispatched (200). Post-fix: **402 before any `api.elevenlabs.io` request** (`calls` length 0).
2. **Route: an out-of-range `composition_plan` is forwarded on main.** A single 3,600,000 ms chunk pre-fix reaches the generate call (200); post-fix **400** (`Unsupported duration for composition_plan: 3600. It accepts 3-300 seconds.`) with zero upstream calls.
3. **Gate arithmetic** (real registry): `calculateUsageBilling("elevenlabs/music-v2", { promptAudioSeconds: 5_242 })` = `$13.105`; `+300 s output` = `$13.855`.
4. **Metering:** `stemInputSeconds` on the concatenated reference parses ~646 s (the probe the fix reuses from stem separation).
5. **Gate unit cases:** 402 below the exact charge (700 s ingestion vs $1.50), admission at $3.00 covering 700 s + 300 s output, key-budget-first refusal (`pollenBalance: 0.5`, wallet $100), unauthenticated skip.
6. **Controls (green pre- and post-fix):** an affordable 1.07 s reference uploads and bills `1.071 + 1` output seconds at $0.0025 each; an in-range 20 s plan forwards verbatim and settles $0.0025 of output — the fix changes no billed value on the happy path.

## Fix (`solution64-music-ingestion-funds-gate`, PR #76)

1. `dispatchAudioGeneration`'s music branch decodes the buffered reference with the existing `stemInputSeconds` probe (music-metadata; rejects unparseable audio with 400 before upload) and calls the new `requireMusicFunds` — mirroring issue 36's `requireStemFunds`: `requireFunds` on `calculateUsageBilling(promptAudioSeconds = decoded duration, completionAudioSeconds = plan total ?? validated requested duration)`, key budget first, then tops the API-key reservation up to the exact charge via `reserveApiKeyBudget`.
2. `validatedMusicPlanSeconds` enforces the model's own `minDuration`/`maxDuration` on the plan's chunk `duration_ms` total through the existing `durationError`, and 400s on malformed plans (missing/empty chunks, non-numeric or non-positive durations) before anything is paid.
3. No cap is imposed (that product decision is #71's); a wallet that covers the exact charge may still spend it, and the settlement's provider-reported seconds are unchanged.

**PR:** https://github.com/NamanSoni78/pollinationsai/pull/76 (upstream PR creation rejected `403` with this token, as every prior round — the fork PR is the review surface)

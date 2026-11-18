# Issue 115 — audio artifact downloads are unbounded and undeadlined (SFX-fal, Qwen TTS, Stable Audio 3 Medium/Large, sonilo deadline)

- **Severity:** Medium-High (unbounded isolate memory + indefinite request pinning on the shared gen worker, after the provider already billed the job — the audio-fleet instance of the accepted issue 87/98/99 download family)
- **Affected:** `gen.pollinations.ai/src/routes/audio.ts` — SFX fal leg `fetch(data.audio.url)` → `arrayBuffer()` (unpatched `:1967-1971`), Qwen TTS leg `fetch(audioUrl)` → `arrayBuffer()` (`:2442-2446`), Stable Audio 3 Medium `fetch(audioUrl)` → `arrayBuffer()` (`:3358-3362`), Stable Audio 3 Large final poll response `arrayBuffer()` + undeadlined poll fetch (`:3500-3526`); `gen.pollinations.ai/src/audio/sonilo.ts:76` (byte cap present, no deadline) — upstream `pollinations/pollinations` main @ `459b7c41c5` (2026-11-18; fix branch rebased to `30a8939fd`, file-disjoint).
- **Fix branch:** `solution115-audio-artifact-download-caps` — fork PR [#130](https://github.com/NamanSoni78/pollinationsai/pull/130)
- **Dedup:** not a duplicate — issues 87/98/99 fixed the 3D-mesh / lyria / InferencePort download sites (branch-diff verified: `solution88-3d-mesh-download-caps` and `solution93-lyria-output-download-caps` touch neither `routes/audio.ts` artifact legs nor these models); issue 21 is the apps/mcp worker; issues 3/25/57/72-family own the *settlement* legs, not these caps. Round 32's audit handed these exact sites off ("audio.ts SFX/Qwen/ElevenLabs artifact fetches lack deadlines/caps — companion sites for the issue 87/98 owners"); no pending branch picked them up (verified against every audio-touching branch).

## Root cause

Five artifact-download legs fetch a **provider-returned URL** (fal CDN `fal.media`, DashScope OSS, `api.stability.ai/v2beta/results/{id}`) with a bare `fetch()` and buffer the entire body via `arrayBuffer()` — no `AbortSignal`, no byte cap, redirects followed silently. The platform has already paid the provider by the time the artifact URL exists (the fal job / Stability render / DashScope synthesis completed and billed), so an oversized or misissued artifact — or one hiding behind a redirect — both **OOMs the 128 MB isolate** (killing concurrent requests on the shared worker) and **pins the invocation indefinitely** with the spend unrecovered. Reachable by any authenticated account via `POST /v1/audio/speech` and `GET /audio/:text` for `elevenlabs/eleven-text-to-sound-v3:fal`, `qwen/qwen3-tts-flash`, `stability-ai/stable-audio-3-medium`, `stability-ai/stable-audio-3` (audioRoutes gate auth+balance — the exposure is resource exhaustion, not pre-auth).

## Safe repro (isolated, red on unpatched main)

`test/audio/artifact-download-caps.test.ts` (new, 6 cases): the four artifact legs are driven with mocked provider chains whose artifact response declares `content-length: 64 MiB + 1` — on unpatched main all four buffer the body and return 200 (RED: expected the 502 cap rejection); the abort-deadline case asserts the artifact `fetch` receives an `AbortSignal`; a small-result control pins the success path. Deterministic offline (vitest + cloudflare:test, fake timers for the fal/Stability poll loops) — live probes **$0**.

## Fix

Mirror the repo's established hardened-download pattern (sonilo / solution93's lyria fix): `fetchUpstream(url, { errorLabel, signal: AbortSignal.timeout(60s) })` + `readResponseBytes(64 MiB)` with a 502 `UpstreamError.fromProvider` on breach, on all four artifact legs; add the 60 s deadline to the SA3-Large poll fetch and to sonilo's existing capped fetch. `64 MiB` keeps every legal output — the 380 s WAV worst case is 67,032,000 bytes < 67,108,864. The settlement-on-artifact-failure legs stay owned by the filed issue 25/57/72 family (unchanged error shapes).

## Tests

6 new cases — **RED on unpatched main: 5/6 fail** (four cap rejections + deadline wiring); **GREEN on the fix branch 6/6**; regression `elevenlabs-sfx` + full `test/audio/` suite **41/41**; `tsc --noEmit` clean.

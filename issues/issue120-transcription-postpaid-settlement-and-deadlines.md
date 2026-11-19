# Issue 120 — transcription backends drop postpaid billing on schema/JSON failures and omit upstream fetch timeouts

- **Severity:** Medium–High (class-sweep across 4 transcription backends: paid upstream calls on Azure GPT, xAI, ElevenLabs Scribe, and MAI Azure/Vercel Gateway drop `billedUsage` / `providerBilling` when a 200 OK response fails JSON/schema validation after upstream billing; additionally, `UpstreamError` / `trackResponse()` cannot settle `providerBilling`, and none of the 4 backends pass an `AbortSignal.timeout` deadline to `fetch()`)
- **Affected:**
  - `shared/error.ts` (`UpstreamError` lacks `providerBilling`)
  - `gen.pollinations.ai/src/middleware/track.ts:793-827` (`trackResponse()` error path settles `billedUsage` only, ignoring `providerBilling`)
  - `gen.pollinations.ai/src/audio/mai-transcription.ts` (unguarded `response.json()`, dropped `providerMetadata.gateway.cost` / `durationInSeconds` / `durationMilliseconds`, no `AbortSignal.timeout`)
  - `gen.pollinations.ai/src/routes/audio.ts` (`transcribeWithAzure`, `transcribeWithXai`, `transcribeWithElevenLabs`: unguarded JSON parse on xAI/ElevenLabs, dropped `usage.seconds` / `duration` / `audio_duration_secs` / `character-cost` header on schema failure, no `AbortSignal.timeout`)
- **Fix branch:** `solution120-transcription-postpaid-settlement-and-deadlines` (off `upstream/main` `8fc4c21`) — fork PR [#135](https://github.com/NamanSoni78/pollinationsai/pull/135)
- **Dedup:** closes the transcription postpaid-settlement & deadline class noted in round 37/38 below-gate notes (not covered by issues 1–117; `solution115` covered outbound artifact downloads on SFX/Qwen/SA3 only).

## Root cause
1. **Unsettled postpaid upstream charges on 200 OK validation failures:**
   - `transcribeWithAzure`, `transcribeWithXai`, `transcribeWithElevenLabs`, and `transcribeMai` all parse the upstream `200 OK` body after the upstream provider has already billed the request. When the upstream returns malformed JSON or a schema-mismatched object (e.g., silent audio returning `durationInSeconds: 0` without `text`/`combinedPhrases`, or missing `text` alongside valid `usage.seconds` / `duration` / `audio_duration_secs` / `character-cost` HTTP header), the handlers either threw raw `SyntaxError`/`TypeError` or threw `UpstreamError` without attaching `billedUsage` or `providerBilling`.
   - For Vercel Gateway MAI (`microsoft/mai-transcribe-2:vercel`), billing is keyed off `providerMetadata.gateway.cost` (`providerBilling`), which `UpstreamError` and `trackResponse()` did not support at all on error paths.
2. **Missing upstream deadlines:**
   - All four transcription `fetch()` calls omitted an `AbortSignal.timeout` signal, allowing hung upstream endpoints to pin Cloudflare Worker invocations indefinitely.

## Safe repro (isolated, red on `upstream/main` `8fc4c21`)
Added 8 offline Vitest regression tests across:
- `gen.pollinations.ai/test/azure-transcription.test.ts` (4 new tests: Azure GPT missing `text` with `usage.seconds`, Azure GPT malformed JSON + `AbortSignal`, Vercel Gateway MAI schema failure preserving `providerBilling` and settling via `trackResponse()`, Azure MAI schema failure preserving `billedUsage` + `AbortSignal`).
- `gen.pollinations.ai/test/xai-transcription.test.ts` (2 new tests: xAI missing `text` with `duration`, xAI malformed JSON + `AbortSignal`).
- `gen.pollinations.ai/test/scribe-transcription.test.ts` (2 new tests: ElevenLabs Scribe missing `text` with `audio_duration_secs`, ElevenLabs Scribe malformed JSON preserving `character-cost * 2.5` header billing + `AbortSignal`).
- **RED on `8fc4c21`:** 8/8 new tests failed (raw `SyntaxError`/`TypeError`, missing `AbortSignal`, dropped `billedUsage`/`providerBilling`).
- Deterministic offline — live probes **$0**.

## Fix
- `shared/error.ts`: added optional `providerBilling?: PricingInput["providerBilling"]` to `UpstreamErrorOptions` and `UpstreamError`.
- `gen.pollinations.ai/src/middleware/track.ts`: updated `trackResponse()` error path to settle `error.providerBilling` alongside `error.billedUsage` via `calculateUsageBilling`.
- `gen.pollinations.ai/src/audio/mai-transcription.ts`: added `MAI_TRANSCRIPTION_TIMEOUT_MS = 120_000` (`AbortSignal.timeout`), guarded `response.json().catch(() => null)`, and attached extracted `providerBilling` / `billedUsage` to `UpstreamError` before throwing on schema/JSON failure.
- `gen.pollinations.ai/src/routes/audio.ts`: added `TRANSCRIPTION_UPSTREAM_TIMEOUT_MS = 120_000` (`AbortSignal.timeout`) across `transcribeWithAzure`, `transcribeWithXai`, and `transcribeWithElevenLabs`; guarded JSON parsing on xAI/ElevenLabs; preserved `billedUsage` (`usage.seconds`, `duration`, `audio_duration_secs`, or `character-cost * 2.5` header) on malformed JSON or missing `text`.

## Tests
- 8 new red/green cases (**RED 8/8 fail on `8fc4c21`**; **GREEN 146/146** across `azure-transcription.test.ts` (14), `scribe-transcription.test.ts` (8), `xai-transcription.test.ts` (4), and `tracking-observability.test.ts` (120)).
- `npx tsc --noEmit` clean (0 errors).

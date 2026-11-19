# Issue 124 — the remaining transcription backends (Vertex, OpenRouter STT, whisper) drop postpaid billing and omit upstream deadlines

- **Severity:** Medium–High (companion to issue 120: the same postpaid-settlement and deadline mechanisms on the three backends its sweep did not reach; every guard fires after the provider already billed the input)
- **Affected:**
  - `gen.pollinations.ai/src/routes/audio.ts` `transcribeWithVertexGemini` (~:1217-1307 on `8fc4c21`): fetch has no `AbortSignal`; the token-usage guard (`!parts || audioTokens/outputTokens/textTokens/promptTokenCount` mismatches) throws 502 with no `billedUsage`, although `audioTokens`/`textTokens`/`outputTokens` are extracted *before* the guard
  - `gen.pollinations.ai/src/routes/audio.ts` `transcribeWithOpenRouterGemini` (~:1410-1462): fetch has no `AbortSignal`; the guard (`!transcript || text/inputTokens/outputTokens` mismatches) throws 502 with no `billedUsage`, although `inputTokens`/`outputTokens` are available before the throw
  - `gen.pollinations.ai/src/routes/audio.ts` whisper leg (~:4494-4520): the OVH/DeepInfra fetch has no `AbortSignal`; `JSON.parse(await response.text())` is guarded but the read is unbounded (the `billedSeconds` guard failure has no salvageable receipt on this leg — residual)
- **Fix branch:** `solution124-transcription-settlement-completion` (off `upstream/main` `8fc4c21`) — fork PR [#139](https://github.com/NamanSoni78/pollinationsai/pull/139)
- **Dedup:** issue 120 (round 39) covers Azure GPT, xAI, ElevenLabs Scribe, and MAI Azure/Vercel Gateway — this completes the fleet for the three backends its scope statement did not include (verified against its issue MD and branch diff: `git diff upstream/main...fork/solution120-*` touches none of these three legs). Issues 91/95/96/104 are the earlier image/text/Replicate/MAI instances of the class.

## Root cause

Same mechanism as issue 120, on the legs it did not reach: the guards validate the *transcript body* and throw after the 200 OK — the provider has already transcribed and billed the input — but unlike the four backends issue 120 fixed, these guards never attach the token receipt they are holding (`audioTokens`/`textTokens`/`outputTokens` for Vertex; `inputTokens`/`outputTokens` for OpenRouter), and none of the three fetches carries a deadline, so a silent model server pins the request indefinitely.

## Safe repro (deterministic offline; live probes $0)

6 new tests (`test/openrouter-gemini-transcribe.test.ts` + `test/audio/whisper-upstream-deadline.test.ts`), **6 red on unpatched `8fc4c21`**:

- OpenRouter STT: `{usage: {input_tokens: 570, output_tokens: 90}}` with no `text` — 502 with `billedUsage` `{promptAudioTokens: 570, completionTextTokens: 90}` expected; on main `billedUsage` is undefined. Output-only partial receipt (`{output_tokens: 90}`, input missing) — same. `init.signal` expected; on main absent.
- Vertex: valid `usageMetadata` (75 AUDIO + 16 TEXT, 4 output) with no `candidates` — 502 with `billedUsage` `{promptAudioTokens: 75, promptTextTokens: 16, completionTextTokens: 4}` expected; on main undefined. `init.signal` expected; on main absent.
- Whisper: the deadline is exercised through the real route harness (`POST /v1/audio/transcriptions`, model `openai/whisper-large-v3`, fresh-Response provider mock) — `init.signal` expected on the OVH fetch; on main absent.

## Fix

- Attach `billedUsage` to the guard's `UpstreamError` whenever the token numbers are usable (invalid numbers coalesce to 0; if every dimension is 0 the error stays unsttled — no receipt exists to settle):
  - Vertex: `{promptAudioTokens, promptTextTokens, completionTextTokens}` from the pre-guard extraction.
  - OpenRouter: `{promptAudioTokens, completionTextTokens}`, including the output-only partial receipt when the input receipt is missing.
- Pass `AbortSignal.timeout(120_000)` (the fleet convention issue 120 established) to all three fetches.

## Tests

**GREEN with the fix:** 19/19 across both files (the 13 pre-existing OR/Vertex cases untouched); sibling transcription suites green (52/52 across 7 files: assemblyai, azure, xai, scribe, param-parsing, both new files); `tsc --noEmit` clean.

## Residuals (documented, not fixed)

- Whisper's `billedSeconds` guard failure has no salvageable receipt (both metering legs missing = nothing to settle) — the deadline and the already-guarded JSON parse are the fixable parts; the unbounded `response.text()` read on that leg is bounded in practice by the small transcription-JSON shape.
- `providerBilling` (the gateway cost receipt) support on error paths exists only on issue 120's branch; these three legs settle through `billedUsage` only, which is complete for them (all three bill through token/second dimensions, not gateway cost receipts).

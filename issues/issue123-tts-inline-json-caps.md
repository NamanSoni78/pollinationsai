# Issue 123 — the inline-audio JSON TTS legs read provider responses unbounded, uncaught, and unsettled (MAI speech, Gemini TTS, Lyria direct)

- **Severity:** High (provider-output memory exhaustion class — issue 65's mechanism on the audio TTS fleet; plus postpaid settlement: a malformed body after a paid synthesis settles the caller $0)
- **Affected:**
  - `gen.pollinations.ai/src/routes/audio.ts` `generateMaiSpeech` gateway leg (~:2665 on `8fc4c21`): `safeParse(await response.json())` — uncaught (raw SyntaxError → 500), unbounded read, 3 simultaneous copies (base64 string + `atob` binary string + `Uint8Array.from`); the gateway schema required `cost: z.coerce.number().finite().positive()` so a legitimate zero-cost read discarded a successful synthesis; the parse-failure 502 carried no `billedUsage` although the input character count (the billing dimension) is known at the call site
  - `gen.pollinations.ai/src/routes/audio.ts` `generateGeminiSpeech` direct leg (~:2890): `parseGeminiSpeechResponse(await response.json(), …)` — uncaught, unbounded
  - `gen.pollinations.ai/src/audio/lyria.ts` direct leg (:71-115 on `8fc4c21`): `(await response.json())` uncaught; `atob(audio.data)` (3 copies); the "no completed MP3" 502 carried no `billedUsage` although Google charges one song per completed interaction
- **Fix branch:** `solution123-tts-inline-json-caps` (off `upstream/main` `8fc4c21`) — fork PR [#138](https://github.com/NamanSoni78/pollinationsai/pull/138)
- **Dedup:** issue 65 = Images JSON routes (`b64_json`, video models) — the image-fleet instance; issue 106 = the media worker's generation-write buffering; issue 115 = URL artifact downloads; issue 120 (round 39) = the *transcription* fleet. None cover the TTS inline-JSON legs. The ElevenLabs WAV-repair byte cap (round 37/38 below-gate) is a different mechanism (output format buffering) untouched here.

## Root cause

1. **Unbounded uncaught reads:** three first-party TTS legs parse the provider response — which carries the full synthesized audio inline as base64 inside JSON — with a bare `response.json()` and no catch. A malformed body surfaces as a raw `SyntaxError` (500) after the provider has already billed the input, and nothing bounds the read, so a runaway provider response buffers unbounded (the MAI leg additionally holds the base64 string, the `atob` binary string, and the `Uint8Array` simultaneously — the ~54 MB-of-base64 legal envelope for a 10k-character input multiplied by 3 in the worst case).
2. **`.positive()` cost schema:** the MAI gateway leg required `cost: positive`; a legitimate zero (a free read) failed `safeParse`, discarding a *successful* synthesis the provider had already billed.
3. **Postpaid settlement:** the failure-path `UpstreamError`s carried no `billedUsage` even where a receipt is computable at the call site (MAI speech: the input character count; Lyria: one song per completed interaction).

## Safe repro (deterministic offline; live probes $0)

`gen.pollinations.ai/test/audio/tts-inline-json-caps.test.ts`, 12 cases, **11 red on unpatched `8fc4c21`** (1 control: "does not settle when the provider did not report completion" passes on both by design):

- MAI speech: content-length 64 MiB+1 rejection expected — on main the tiny body parses and the schema fails instead; malformed JSON expected as a clean 502 — on main it is a raw SyntaxError; schema failure expected to settle `{completionAudioTokens: 5}` — on main `billedUsage` is undefined; `cost: 0` expected to succeed — on main it is discarded; no `AbortSignal` on main.
- Gemini TTS: malformed JSON → raw SyntaxError on main; oversized → parses on main; no `AbortSignal`.
- Lyria: malformed JSON → raw SyntaxError on main; completed-without-audio expected to settle `{completionAudioTokens: 1}` — on main `billedUsage` is undefined; no `AbortSignal`.

## Fix

- Route all three reads through `readResponseText` with the shared 64 MiB cap (`shared/response-bytes.ts`; the 10k-character input cap bounds a legal body to ~54 MB of base64, so the sonolo 64 MiB output convention covers every legal synthesis with headroom).
- Guard the JSON parse with a clean 502; relax the MAI cost schema to `nonnegative()`.
- Settle `billedUsage` on every failure path where a receipt is computable: MAI speech settles the input characters (`createAudioTokenUsage(characters)`) on all four failure shapes; Lyria settles one song (`{completionAudioTokens: 1}`) exactly when the provider reported `status: "completed"`.
- Give all three fetches the 120 s `AbortSignal.timeout` deadline.

## Tests

**GREEN with the fix:** 12/12; the existing `test/audio/` + `mai-tts` + `gemini-tts` suites stay green (79/79 across 10 files); `tsc --noEmit` clean.

## Residuals (documented, not fixed)

- The multi-copy peak at the cap (64 MiB base64 + 48 MiB binary string + 48 MiB `Uint8Array` ≈ 160 MB if a provider returns a maximum-size body) — the cap bounds the unbounded case; eliminating the copies needs a streaming decode. Trusted-provider threat model, same residual class issue 65 accepted.
- Gemini TTS json-parse failures carry no `billedUsage` (no receipt exists on that leg until the provider reports usage); the cap + clean 502 are the fixable parts.

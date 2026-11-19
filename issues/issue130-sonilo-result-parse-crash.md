# Issue 130 — Sonilo SFX: a malformed fal result body escapes as a raw 500 with the paid receipt discarded (issue 123's class on the SFX leg)

- **Severity:** Medium-High (billing integrity: fal billed the video's seconds; the caller settles $0 — plus a raw `SyntaxError` 500 instead of a clean 502)
- **Affected:** `gen.pollinations.ai/src/audio/sonilo.ts:69-75` — upstream `pollinations/pollinations` main @ `8fc4c212a4`
- **Fix branch:** `solution130-sonilo-result-parse-guard` — fork PR [#145](https://github.com/NamanSoni78/pollinationsai/pull/145)
- **Dedup:** issue 25's S5 covers the `COMPLETED`-without-`audio.url` 502's settlement (fork PR #34, unmerged upstream); issue 123 covers the MAI/Gemini/Lyria TTS inline-JSON parse legs; issue 120/124 the transcription fleet; issue 82 the sonilo download/oversized-output rows. None covers the **result-body parse crash** on this leg — the fork's issue-25 fix left `response.json()` bare (verified on `fork/solution14`).

## Root cause

`generateSoniloSfx` submits the fal job inside a try/catch (`:53-68`), but reads the **completed-job result** with a bare `const data = (await response.json())` at `:70` — outside any guard. A 200 result whose body is not JSON (truncated JSON, an HTML error page from an intermediary on the queue's response URL) escapes as a raw `SyntaxError` (route-generic 500) **after fal has already billed the video's seconds**, and the receipt extracted one line above — `const units = falBillableUnits(response)` at `:69` — is discarded: `middleware/track.ts` settles a failed request only from `error.billedUsage`, so the caller settles $0 (bounded by the fal SFX envelope: the vendor caps the billable seconds ≈ $0.10 at the live $0.009/s unit price for a typical clip).

The repo's own convention for exactly this situation is issue 123's fix: guarded parse → clean 502 + `billedUsage` for the computable receipt — and the fork's issue-25 fix already attaches `billedUsage` to the sibling no-audio 502 in this same function.

## Safe reproduction (deterministic offline; $0 live)

`gen.pollinations.ai/test/audio/sonilo.test.ts` — 1 new case **red on unpatched `8fc4c21`**: the mocked fal chain returns a `COMPLETED` job whose result body is `<html>proxy error</html>` with `x-fal-billable-units: 12`; the call rejects with the escaping `SyntaxError` and no `billedUsage`. After the fix it rejects with a 502 `UpstreamError` carrying `billedUsage: { completionAudioSeconds: 12 }`.

## Fix (`solution130-sonilo-result-parse-guard`)

Guard the parse: on a malformed body, throw `Object.assign(new UpstreamError(502, { message: "Sonilo returned a malformed result body" }), { billedUsage: createCompletionAudioSecondsUsage(units) })` — the `Object.assign` convention the fork's issue-25 fix established for the sibling no-audio path.

## Verification

Sonilo suite 7/7 green (1 red-on-main); the full `test/audio/` directory 29 green; `tsc --noEmit` clean.

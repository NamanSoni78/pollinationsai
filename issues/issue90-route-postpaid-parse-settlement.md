# Issue 90 — Route-level post-paid settlement gaps: stem-separation's invalid archive, the image handler's empty buffer, and the direct-Responses schema failure

- **Severity:** Medium-High (billing integrity: per-request 100% revenue loss on the affected legs — the same class as issues 25/72/81/82, which fixed the *client* layer; these three sites live on the route/handler layer none of those sweeps reached)
- **Affected:** `gen.pollinations.ai/src/audio/stem-separation.ts:153-169`, `gen.pollinations.ai/src/image/handler.ts:282-295` (+ its three call sites), `gen.pollinations.ai/src/text/responses/handler.ts:259-282` — upstream `pollinations/pollinations` main @ `282ac54aeb` (2026-11-18)
- **Fix branch:** `solution80-route-postpaid-parse-settlement` — fork PR [#102](https://github.com/NamanSoni78/pollinationsai/pull/102)
- **Dedup:** issues 25/72/81/82 settled post-paid failures inside *model clients* (their affected-file lists contain none of these three files). Issue 36 owns stem separation's **preflight funds gate**; the audio-sweep "stem separation settlement" notes (rounds 13-15) verified the *success-path* settlement and the streamed output — the invalid-archive failure leg was pinned **unbilled** by its own test's name ("rejects a non-ZIP upstream response **without billing** or caching it"). Issue 81's H1 fixed the **model3d** handler's `assertNonEmptyMedia` — this issue's site 2 is the **image-route** twin (`image/handler.ts`, a different file covering image/video/community routes). The Responses schema-fail site has no filed instance; the chat path's `responseBody` attachment (`generation-handlers.ts:211-216`) is the in-repo precedent this fix ports.

## Root cause

`middleware/track.ts:793-798` settles a failed request only from `error.billedUsage`. Three post-paid throws on the route layer carried none:

1. **Stem separation** (`audio/stem-separation.ts`): ElevenLabs answers **200 after decoding the uploaded audio** (its stem separation bills per input second on the processed job), but a body whose content-type is not `application/zip` throws a bare 502 (`:160-163`). The success path bills `max(inputSeconds, outputSeconds)`; on the failure leg `inputSeconds` — the decoded upload duration, computed before dispatch at `:127` — was in hand and discarded. The pre-existing integration test pinned the loss: `events.filter(isBilledUsage)` length **0**, balance unchanged.
2. **Image/video/community empty buffer** (`image/handler.ts:assertNonEmptyMedia`): after `generateImageResult`/`generateVideoResult`/the community endpoint call returned successfully (provider completed and billed — the success path's `trackingData.usage` is exactly what would have settled), an empty buffer threw a bare 502. Issue 81 fixed the model3d twin of this exact guard with `billedUsage: result.trackingData?.usage ?? { completionImageTokens: 1 }`; the image-route twin (three call sites: community image, community video, provider image/video) was left unfixed.
3. **Direct Responses schema failure** (`text/responses/handler.ts:259-266`): a 200 answer that fails `CreateResponseResponseSchema` (e.g. missing `output`) threw 502 with **no `responseBody` and no `billedUsage`** — even when the provider's JSON contained a perfectly valid `usage` object it had already metered. The chat path attaches the raw body on its own schema failure, but `trackJsonErrorUsage` recovery is **analytics-only** (`isBilledUsage` stays false; only `billedUsage` triggers `handleBalanceDeduction`) — and the direct path attached neither.

## Safe repro (isolated, red on unpatched main — all three legs)

- `test/stem-separation.test.ts`: ElevenLabs mocked to 200 `audio/mpeg` → route 502, `isBilledUsage` events **0**, balance unchanged (red expectations: 2 billed events of 0.25 s × $0.005 and the deducted balance).
- `test/image/nonEmptyMediaSettlement.test.ts` (new): `assertNonEmptyMedia` throws 502 with `billedUsage: undefined` on unpatched main (the function was not even exported — the capability did not exist).
- `test/text/responses.test.ts`: Hono-mounted `generateCreateResponse`, fetch mocked to a 200 whose payload misses `output` but carries `usage { input_tokens: 5, output_tokens: 7, total_tokens: 12 }` → 502 with `billedUsage: undefined` on unpatched main.

## Fix

1. Stem separation: the invalid-archive throw carries `billedUsage: createAudioSecondsUsage(inputSeconds)` — the decoded input duration, the same floor the success path treats as the minimum billable seconds (output length is unknowable on the failed leg).
2. `assertNonEmptyMedia`: exported, takes the attempt's `trackingData.usage` (defaulting to one completion token — the same convention as issue 81's model3d fix); all three call sites pass it.
3. Direct Responses: any usage the provider reported on the schema-invalid 200 is parsed (`ResponseUsageSchema.safeParse`) and settled via `responsesUsageToUsage`, and the raw body is attached (`responseBody`) for diagnostics, mirroring the chat path.

Composition: composes with `solution86-fallback-paid-leg-settlement` (the track-level change that settles rescued intermediate attempts — this branch's `billedUsage` attachments become settle-able by it); deliberately leaves `solution14`'s sonilo no-audio and grok missing-duration sites untouched; the whisper non-JSON / missing-duration and Gemini-speech parse guards stay unsetted as recorded residuals (units not provably billed or documented-deliberate respectively).

## Tests

All three legs red on unpatched main, green with the fix:

- the stem-separation case now asserts **two billed events** (0.25 s × $0.005 each) and `packBalance = 1 − 2 × 0.00125`, keeping the no-caching assertions;
- 3 new `assertNonEmptyMedia` cases (usage passthrough, one-token floor, non-empty pass-through);
- the Responses case asserts the converted `billedUsage` (`responsesUsageToUsage({input_tokens: 5, output_tokens: 7, total_tokens: 12})`) and `responseBody` containing the raw provider JSON.

image + responses-adapter + tracking-observability suites **1138/1138 green**; `tsc --noEmit` clean. No live-probe spend (all three reproductions fully isolated).

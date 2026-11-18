# Issue 93 — Community speech leg's error path buffers the publisher's whole error body with no byte cap (the one leg issue 77's fix does not reach)

- **Severity:** High (availability — publisher-triggerable isolate OOM inside the gen worker, paid for by the caller's request; the accepted class of issues 22/56/65/67/75/76/77)
- **Affected:** `gen.pollinations.ai/src/audio/communityEndpoint.ts:82` — `callCommunitySpeechEndpoint`'s `ensureUpstreamOk(response, upstreamUrl)` reads the publisher's non-2xx body via unbounded `response.text()` (`shared/error.ts:108-133`); route entry `routes/audio.ts` (`POST /v1/audio/speech`, community candidate) — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution84-community-speech-error-body-cap` — fork PR [#103](https://github.com/NamanSoni78/pollinationsai/pull/103)
- **Dedup:** issue 77 (PR #90) capped the transcription and embeddings serve paths — its report scopes exactly those two legs and its fix reads both success **and** error bodies through `readResponseText`; the speech leg was explicitly dispositioned as "keeps its streaming passthrough (no buffering)". That is true of the speech **success** path (it streams `response.body` through) — but the speech **error** path goes through the shared `ensureUpstreamOk`, which buffers the whole publisher error body unbounded. The fix-coverage-gap companion convention of issues 76/88 applies: the sites are issue 77's class; this leg is uncovered.

## Root cause

`ensureUpstreamOk` is the shared error-side gate: on any non-OK publisher answer it does `responseBody = await response.text()` — for a community publisher, an arbitrarily large body is buffered whole in the isolate before the leg can react. Every sibling community leg now bounds its reads:

- transcription + embeddings success **and** error bodies: issue 77 / PR #90 (`readResponseText` at `MAX_COMMUNITY_MEDIA_RESPONSE_BYTES`, error bodies included);
- image/video JSON legs: `fetchCommunityMediaJson` (`image/communityEndpoint.ts:236-243`) — the original capped twin;
- sonilo, reference audio, user-image fetches: the same primitive.

The speech leg's success body streams (`new Response(response.body)` — egress only), so its only buffered read is the error-side `ensureUpstreamOk` — and that read is unbounded. A publisher — or anyone who compromises a self-hosted TTS server — answers a speech request with a non-2xx status and a multi-hundred-MB body; the gen worker buffers all of it (isolate OOM, every concurrent request on the isolate dies), repeatable at the caller's key rate for free on owner traffic.

## Safe reproduction (non-destructive, isolated)

```ts
// test/community-endpoints.test.ts (speech block) — counting 30x1 MiB stream
// as the publisher's 500-error body:
const call = callCommunitySpeechEndpoint(await speechEndpoint(), {...}, secret);
// unpatched main: the whole 30 MB drains (produced === 30) and the error is
// the default 500 mapping — no cap fired. RED.
await expect(call).rejects.toThrow(/[Tt]oo large/);
expect(produced).toBeLessThan(30); // the read stops at the ~28 MB cap
```

## Fix (`solution84-community-speech-error-body-cap`)

`ensureUpstreamOk` gains an optional `maxBytes` parameter: callers that pass a cap read the error body through the platform's existing bounded `readResponseText` primitive (content-length precheck + running byte count) instead of `response.text()`. The speech leg passes `MAX_COMMUNITY_MEDIA_RESPONSE_BYTES` — the same ~28 MB ceiling every sibling community leg enforces. Official-provider call sites are byte-identical (optional parameter, unset).

## Verification

New route-level case in `test/community-endpoints.test.ts` (the counting-stream shape above) — red on unpatched main, green with the fix. Community-endpoints suite 164/164, error-observability + sonilo 55/55, `tsc --noEmit` clean. Live probes: $0 (deterministic offline).

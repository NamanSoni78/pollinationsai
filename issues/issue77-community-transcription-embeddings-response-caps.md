# Issue 77 — Community transcription and embeddings serve paths buffer the publisher's response with no byte cap (publisher-triggerable isolate OOM)

- **Severity:** High (availability — deterministic isolate OOM / memory exhaustion inside the gen worker, paid for by the caller's request; same accepted class as issue 22)
- **Affected:** `gen.pollinations.ai/src/audio/communityEndpoint.ts:192` (`parseCommunityTranscription(await response.text())`, plus the unbounded `ensureUpstreamOk` error-body read at `:190`) — route entry `routes/audio.ts:4297` (`POST /v1/audio/transcriptions`, community candidate in `withAudioFallback`); `gen.pollinations.ai/src/embeddings/communityEndpoint.ts:82` (`await response.json().catch(() => null)`, with `ensureUpstreamOk` at `:81`) — route entry `routes/proxy.ts:879` → `routes/generation-handlers.ts:165` (`POST /v1/embeddings`) — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution71-community-transcription-embeddings-response-caps` — **PR:** [#90](https://github.com/NamanSoni78/pollinationsai/pull/90)

## Root cause

Every community modality proxies a **publisher-controlled server** the platform treats as untrusted infrastructure — the image and video legs already read the upstream response through `readResponseText` capped at `MAX_COMMUNITY_MEDIA_RESPONSE_BYTES` (`image/communityEndpoint.ts` `fetchCommunityMediaJson:236-243`; the video leg the same; enter's own probes cap at 28 MB). The transcription and embeddings serve paths are the two legs that never got the cap:

- **Transcription** buffers the whole publisher reply with `await response.text()` before parsing the verbose_json transcript.
- **Embeddings** buffers the whole publisher reply with `await response.json()` before zod validation.

A publisher — or anyone who compromises a self-hosted whisper/embeddings server — can declare (Content-Length) or stream a body of any size up to the platform's transport limits, and the gen worker materializes all of it in the isolate. There is no Content-Length precheck and no running byte count on either path. Both routes are reachable by any authenticated caller of a community transcription/embedding model, so the OOM is paid for by the caller's request; repeat requests make it deterministic. (Issue 22 filed the text leg; issue 3 covers first-party AssemblyAI; issues 12/13/55/56 are input-side; issue 26 is usage meters — none cap these two response bodies.)

## Safe reproduction (non-destructive)

1. **Red on unpatched main** (isolated unit tests, no live traffic):
   - `npx vitest run test/audio/community-transcription-response-cap.test.ts` — `rejects an oversized transcription response before buffering it` FAILS: a stubbed upstream returning a small valid verbose_json with `content-length: 209715200` (200 MB) resolves **200** on main (the declared size is never checked; the worker would buffer whatever is streamed). The streaming variant (30 MB body, no content-length) likewise resolves 200 on main.
   - `npx vitest run test/embeddings/communityEndpoint.test.ts` — `rejects an oversized upstream response before buffering it` FAILS the same way for the embeddings leg.
2. **Live probe (optional, non-destructive):** with an own key, call a community transcription model and observe the serve path shape — no production publisher was pointed at oversized bodies by this audit (the publisher side of the reproduction is demonstrated by the stubbed upstream only).

## Fix (`solution71-community-transcription-embeddings-response-caps`)

Both paths read through `readResponseText(response, MAX_COMMUNITY_MEDIA_RESPONSE_BYTES, …)` — the platform's own media-path helper: Content-Length prechecked before reading, running byte count enforced while streaming, upstream body cancelled on violation — and surface the same 502 `UpstreamError` ("Community endpoint response is too large") the image/video paths use. Upstream error bodies are read under the same cap and mapped onto the existing message shape (`communityEndpointErrorDetail`) instead of the unbounded `ensureUpstreamOk` read; the speech path keeps its streaming passthrough (no buffering, 300 s deadline).

## Verification

New transcription cap suite (3 tests) + embeddings cap test — all red on unpatched main, green with the fix. Embeddings suite 10/10, audio + error-observability suites 77/77, `tsc --noEmit` clean.

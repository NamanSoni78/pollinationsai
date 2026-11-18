# Issue: Community text-proxy responses are relayed and buffered with no byte cap (publisher-triggerable isolate OOM)

**Severity:** High (availability — cross-tenant request-kill on shared isolates)
**Status:** Confirmed by code-path tracing at upstream `549feee` and pinned by isolated unit tests (2026-11-18); not live-tested, because registering a community text endpoint on production is outside the non-destructive probe envelope
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/26 (branch `solution16-community-text-response-cap`)

## Summary

Community media (image/video) responses are hard-capped at `MAX_COMMUNITY_MEDIA_RESPONSE_BYTES` (~28 MB) through `readResponseBytes`/`readResponseText` — enforced at `image/communityEndpoint.ts:236`, `routes/audio.ts:295`, `audio/sonilo.ts:79`, `userImage.ts:244`. The community **text** legs have no cap and no deadline:

- `text/genericOpenAIClient.ts:516,595` — raw fetch, then `await response.text()` buffers the whole JSON answer
- `text/responses/client.ts:161` — `parser.feed(await response.text())` buffers an entire SSE stream as one string (the `streamUpstream` path); `:249` reads whole error bodies
- `text/responses/chatClient.ts:66` — `await response.json()`
- `middleware/track.ts:1570` — `response.clone().json()` re-buffers for billing; `:1644-1657` accumulates every SSE chunk in `streamEvents`
- `text/validatedSSEStream.ts:29` — `pending` grows per event without limit
- no `COMMUNITY_ENDPOINT_TIMEOUT_MS` anywhere on the text fetch path either (repo grep: only the audio/embeddings/image community endpoints carry it)

A publisher registers a community text proxy (public listing), then calls **their own model** — owner traffic is free and unbilled (`track-helpers.ts:226-242`: `communityModelRewardInput?.userId === userId` → `billedPrice: 0`) — and the endpoint returns one 60–100 MB JSON or SSE body. gen buffers it two to four times (response string + JSON parse + tracking clone) before the isolate's 128 MB limit is exceeded → Cloudflare error 1102, killing **every concurrent request on that isolate**, repeatable at will. Same accepted class as issue 12 (upload-side ≈4.6× allocation), but attacker-controlled and response-side.

## Verification (non-destructive, isolated)

1. Code-path evidence above, read in full at `549feee`.
2. Isolated unit tests (`gen.pollinations.ai/test/community-text-response-cap.test.ts`, workerd pool): an oversized declared `Content-Length` is rejected before the body is read and the upstream body is **cancelled**; a lying-header chunked stream of 30 MB is cut off mid-read at the media cap and the upstream body is cancelled — on unpatched HEAD, `response.text()` reads payloads of this size to completion (that is the gap the fix closes).
3. Regression on the fix branch: `community-endpoints` 170/170 (including the managed-agent MCP billing suites that pin the fetcher precedence), `generateTextPortkey` + `genericOpenAIClient` 107/107, `byop-markup`/`text-cache`/`generation-vcr` 162/162, `agent-run-token` green, `tsc --noEmit` clean.

## Impact

- Any community text publisher can OOM shared isolates at zero cost to themselves, killing unrelated concurrent callers (cross-tenant availability).
- Oversized relays also burn platform egress to the caller.

## Fix

`communityEndpointFetch` in `text/communityEndpoint.ts`: every proxy fetch this module originates now carries `COMMUNITY_ENDPOINT_TIMEOUT_MS` **and** a per-chunk byte cap of `MAX_COMMUNITY_MEDIA_RESPONSE_BYTES` — `Content-Length` prechecked when present, running total enforced while streaming, upstream body cancelled on violation, surfaced as the same 502 `UpstreamError` the media paths use. Wired through `modelConfig.fetcher` (chat) / `modelConfig.responsesFetcher` (responses) and threaded in `generateTextPortkey`; managed prompt/code agents keep their own billing-bearing in-repo transport (only `endpoint.type === "proxy"` gets the bounded fetcher).

## Notes

- Community speech (`audio/communityEndpoint.ts:88-102`) streams the upstream body to the client egress-only (`new Response(response.body)` — no worker buffering), so it is not a memory issue; recorded here for completeness.
- This branch subsumes the still-unmerged `solution4-community-text-proxy-timeouts` wiring for the text path (timeout + fetcher threading), so the two reconcile trivially whichever merges first.

## Update (2026-11-18, round 15 — upstream's own deadline fix landed headers-only)

Upstream `2ed51176a` ("fix(text): bind community-endpoint fetches to the 300s deadline", #19956) binds the deadline to **response headers only**: `communityEndpoint.ts:31-36` clears the timer in the `finally` as soon as `fetch` resolves (the commit's own second subject says "limit community text deadline to response headers", and its test codifies "clears the deadline after headers and keeps caller cancellation"). Neither production caller threads a caller signal (`genericOpenAIClient.ts:516-521` and `responses/client.ts:232-237` pass no `signal`, so `AbortSignal.any`'s caller half is dead code in production), body reads stay time-unbounded (`response.text()`, whole-SSE buffering, `clone().json()`), and response **size** caps remain absent upstream. The root cause stays this issue (and issue 4's); the fork fix (PR #26) covers both halves and remains the pending review surface.

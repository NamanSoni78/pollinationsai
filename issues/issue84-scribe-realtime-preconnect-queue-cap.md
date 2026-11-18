# Issue: unbounded pre-connect audio queue in Scribe realtime sessions (isolate-memory exhaustion)

**Severity:** High (availability / shared-isolate memory amplification)
**Status:** Confirmed by red→green isolated tests against unpatched `282ac54aeb` (2026-11-18)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/96 (branch `solution74-scribe-realtime-queue-cap`; upstream PR creation 403-blocked by the fork token's `pull_requests:read` scope — the standing limitation every round re-verifies)

## Summary

`proxyScribeOpenAIRealtime` (`gen.pollinations.ai/src/routes/realtime.ts`) queues client audio in isolate memory while the ElevenLabs upstream WebSocket connect is pending. Every `input_audio_buffer.append` arriving before the socket attaches is retained as a `JSON.stringify` copy of the client's base64 chunk (`QueuedScribeInput.payload`, realtime.ts:1198-1201, 1405-1427) — up to ~1 MiB per Cloudflare WebSocket message — and the queue has **no cap on item count or total queued audio seconds** (realtime.ts:1245, 1425). Manual `input_audio_buffer.commit` events enqueue zero-second items, so they are bounded by nothing in item count.

The amplification window is the upstream connect (`ensureUpstream` → `connectScribeRealtime`'s fetch, realtime.ts:1376-1403), which has no deadline; the queue drains only inside `attachUpstream` (1373). A stalled or slow connect — or simply a fast client during a normal 100-500 ms connect — retains everything the attacker sends.

## Root cause

`enqueueInput` validates the base64 shape (`inspectAudioBase64`, parity/seconds only — no length cap) and pushes `JSON.stringify(providerEvent)` into `queue` whenever the upstream is not open. Nothing bounds `queue.length`, the summed `audioSeconds`, or the retained payload bytes.

## PoC (isolated, red on unpatched main)

`gen.pollinations.ai/test/realtime.test.ts` — new tests hold the upstream connect fetch (never-resolving promise) and then:

1. **13 × 10 s appends (130 s pcm_24000)** while the upstream never connects → unpatched main emits **no error event and never closes the socket**; all payloads are retained indefinitely. On a shared 128 MiB Workers isolate, ~128 max-size (~1 MiB) messages exhaust the isolate and kill unrelated co-hosted requests; the edge limiter (1000 req/10 s/IP) permits dozens of concurrent sessions, and realtime models declare no `perUserRpm`, so `enforceModelRateLimit` is inert for them.
2. **513 × `input_audio_buffer.commit`** (each `audioSeconds` 0) → same: no error, no close, unbounded item growth.
3. Control: audio queued under the cap while the connect is held is forwarded verbatim and billed once the socket attaches (pins the queue's intended bridging behavior).

Access: the scribe models are `paidOnly`, but a $0.01 x402 prepaid key satisfies `hasPaidBalance` and reaches `/v1/realtime?model=elevenlabs/scribe-v2-realtime`.

## Impact

Deterministic isolate-memory exhaustion from any authenticated realtime caller: no rate limit, no per-message cap, no aggregate budget, and no connect deadline. Co-hosted requests on the same Workers isolate are killed (cross-tenant availability impact).

## Fix

Bound the queue: `SCRIBE_QUEUE_MAX_ITEMS = 512`, `SCRIBE_QUEUE_MAX_AUDIO_SECONDS = 120` (pcm_24000 worst case ≈ 7.7 MB of retained base64 per session; ulaw_8000 ≈ 1.3 MB). On breach: log, send an OpenAI `error` event (`audio` param), close both sockets with 1009 (`Message too big`), and `scheduleRealtimeSettlement`. `attachUpstream`'s drain resets the queued-seconds counter.

Deliberately **no `AbortSignal.timeout` on the upstream WebSocket connect**: `availableServers.ts:171` documents that a timeout signal previously broke pool fetches in production Workerd, so the queue cap alone bounds the memory for any connect duration.

## Verification

- The two overflow tests fail on unpatched main (no error event, no close) and pass with the fix (error + 1009 close + settlement scheduled).
- The forwarding control passes on both (queue's purpose unchanged; queued audio is billed on send).
- Realtime suite 46/46 (43 pre-existing + 3 new); `tsc --noEmit` clean.

## Companion notes

- A `solution75`-style post-paid settlement branch for the fal-fallback media legs was built this round, then **withdrawn without pushing** when the concurrent round-22 session (issues 81/82) delivered the identical sweep — no duplicate branches are left on the fork.
- Issue 82's lyria settlement (no-audio / download / empty-payload) leaves two phases unsettled: the missing `x-fal-billable-units` receipt (throws before units are known) and the failed result fetch after `COMPLETED`. A stacked variant settling both via issue 81's `paidUsage` plumbing was built, verified red→green (14/14 lyria tests, 293 across the stacked suites), then **withdrawn as a duplicate** of issue 82's file; the delta is recorded here for the issue-81/82 PR authors to fold in: pass `{ completionAudioTokens: 1 }` as `runFalJobResponse`'s `paidUsage` at the lyria call site, and wrap `falBillableUnits(result)` in the post-paid region with `{ completionAudioTokens: reportedUnits ?? 1 }`.

## Safe reproduction

Fully offline (mocked WebSocket pairs + a held connect promise, per the tests above). No live probes were needed; the bounty key's balance was untouched this round.

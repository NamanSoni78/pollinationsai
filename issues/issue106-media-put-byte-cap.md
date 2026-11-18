# Issue 106 — `MediaUpload.put` buffers the whole cached generation body with no byte cap: a community speech endpoint OOMs the shared media worker

- **Severity:** High (publisher-driven availability attack on the shared `pollinations-media` isolate — co-tenant uploads, public retrievals and gen's own audio cache reads all die with it; plus unbounded R2 objects)
- **Affected:** `media.pollinations.ai/src/media-upload.ts:203-227` — `put()`'s `const body = await response.arrayBuffer();` at :206: no content-length precheck, no running byte cap, no AbortSignal. Feed: `gen.pollinations.ai/src/audio/communityEndpoint.ts:93-102` (community speech success body is a raw passthrough `new Response(response.body, …)` with the publisher-chosen `audio/*` content-type), routed through `gen.pollinations.ai/src/routes/audio.ts:4059` (`speechAudioCache` → `audioCache`) and captured at `gen.pollinations.ai/src/middleware/media-cache.ts:92-111` → `write: c.env.MEDIA.put(cacheKey, stored)` (:110), RPC into the entrypoint bound at `gen.pollinations.ai/wrangler.toml:31` (`{ binding = "MEDIA", service = "pollinations-media", entrypoint = "MediaUpload" }`). Upstream `pollinations/pollinations` main @ `379be828d` (2026-11-19)
- **Fix branch:** `solution106-media-put-byte-cap` — fork PR [#120](https://github.com/NamanSoni78/pollinationsai/pull/120)
- **Dedup:** the cap family bounded the **gen-side read legs** — issue 22 (community text response cap) and issue 93's own dedup note both dismissed the speech success body as "egress only / no worker buffering," missing that `capture()` clones the response for the cache write and the **media worker** buffers that clone whole (`shouldCache` gates only on `response.ok` + content-type, which the publisher controls). Issues 12/100 cap the media worker's *upload* routes (busboy/FixedLengthStream), not the `put` generation-write entrypoint. Issue 87 (mesh download caps, `solution88`) caps *gen's* provider fetches; issue 98 the lyria fal download leg — neither touches the media worker's write path. `DEFAULT_MAX_SIZE` (100 MB) in the same file gates the unlisted upload routes only.

## Root cause

Every cached image/audio/3D response is persisted by RPC into the media worker, whose only generation-write path awaits `arrayBuffer()` on the **entire** body — nothing between a publisher's HTTP body and `MEDIA_BUCKET.put` enforces any size. The gen-side response caps (issues 22/26/77/93) and the JSON/multipart request caps (issues 56/100) all run before or at the gen routes; the cache write path itself was never capped, and it is fed by content the publisher fully controls: a private free speech community endpoint returns `Content-Type: audio/mpeg` with an endless (or ≥128 MB) body, gen streams its half to the caller while `capture()`'s clone is buffered whole in the **media worker's** isolate → Cloudflare `error code: 1102` kills every in-flight request on that isolate: other users' uploads, public `GET /:id` retrievals, gallery reads, and gen's own audio cache-HIT reads (`env.MEDIA.get` runs in the same worker). Sub-128 MB bodies also park unbounded objects in R2 under immutable cache-control with read-refreshed TTL. Free, repeatable at will; private models bill $0 to their owner.

## Safe repro (isolated, red on unpatched main)

`media.pollinations.ai/test/media-put-cap.test.ts` (new, worker-level against the real `MediaUpload` entrypoint with the mock R2):

1. **Streaming leg (the OOM mechanism, shrunk):** a 66 MiB `audio/mpeg` body (66 × 1 MiB chunks) — unpatched main **resolved `put()` after buffering the whole body** and stored the object in R2 (proof: promise resolved, `has(id)` true); with the cap it rejects mid-stream at ~64 MiB and nothing is stored.
2. **Declared-size leg:** a 1-byte body declared `Content-Length: 65 MiB` — unpatched main resolved and stored the byte; with the cap it rejects on the declared size alone, before anything is read.
3. **Control:** small media still stores byte-identically (same behavior as `integration.test.ts`'s store-and-serve cases).

No live probe needed; $0 spend, no production state touched (the wiring trail `communityEndpoint.ts:93` → `speechAudioCache` → `capture():110` → `wrangler.toml:31` is code-verified end-to-end, and gen's `media-cache.test.ts` — which constructs this same `MediaUpload` as the `MEDIA` binding — passes 12/12 with the cap).

## Fix

`media-upload.ts` reads through `shared/response-bytes.ts`'s `readResponseBytes` at `MAX_GENERATION_MEDIA_BYTES = 64 MiB` — the same ceiling the sonilo audio (`sonilo.ts:19`) and 3D mesh download legs already use: declared `content-length` over the cap is rejected before anything is read, a running byte count rejects mid-stream, and the write-side rejection is already swallowed by generation-cache's `waitUntil(cacheWrite.catch(…))` (`generation-cache.ts:269-272`) so callers are unaffected — oversized artifacts simply stop being cached. One choke point covers `imageCache`/`audioCache`/`model3dCache` and the detached executor's cache writes. The constant is deliberately unexported (workerd requires every export of an entrypoint module to be a handler; gen's test harness binds this module as a service).

## Tests

3 cases in `media-put-cap.test.ts` — 2 red on unpatched main (both `put()` legs resolved after buffering; the rejects assertions failed), 1 control. Full media suite 79/79; gen's `media-cache` wiring suite 12/12; `tsc --noEmit` error count identical to unpatched main (same single pre-existing shared-file error); biome clean.

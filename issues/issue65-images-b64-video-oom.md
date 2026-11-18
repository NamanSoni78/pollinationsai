# Issue 65 — Images JSON routes: uncapped provider-output buffering with ~5x `b64_json` memory multiplication on video models (shared-isolate OOM)

## Finding

`formatOpenAIImageResponse` (gen.pollinations.ai/src/routes/images.ts:443) buffers the **entire provider response** with `response.arrayBuffer()` and then multiplies it across transient copies before returning `b64_json`:

- `arrayBufferToBase64` (gen.pollinations.ai/src/util.ts:23-33) accumulates the whole binary string (`binary += String.fromCharCode(...)` in 32 KB chunks) → ~1.33x
- `btoa(binary)` result → +1.33x
- `c.json(...)` `JSON.stringify` body copy while `b64_json` is still referenced → +1.33x

Peak ≈ 4.6-5x the media size per request, inside the shared 128 MB Worker isolate.

`POST /v1/images/generations` and `POST /v1/images/edits` are OpenAI Images routes with `response_format` **defaulting to `b64_json`** (shared/schemas/openai.ts:1003-1009) and both accept **video models**:

- `VIDEO_MODEL_ENDPOINTS` includes `/v1/images/generations` (gen.pollinations.ai/src/model-registry.ts:51-55)
- the `/v1/images/edits` docs explicitly say video models use images as frame inputs (gen.pollinations.ai/src/routes/proxy.ts:1342)
- video durations reach 120s (`mirelo/sfx-2.0` defaults to 120s of source video; `flux-3-max` up to 20s 1080p+)

One 30-60 MB provider video through the default `b64_json` path peaks at 150-300 MB of transient allocations — killing **all in-flight requests** on that isolate (`503 error code: 1102`). Even 3-4 concurrent ordinary 10-15 MB videos through the default envelope reach the ceiling. This is the **response-side sibling** of the upload-side parse-before-check class (issue 12: JSON upload pre-decode OOM; issue 56: multipart `formData()` pre-auth buffering). No byte cap exists on the provider-output download itself either — every official video/image model uses bare `Buffer.from(await response.arrayBuffer())` with no `readResponseBytes` cap (26 call sites in gen.pollinations.ai/src/image/models/*), while community endpoints cap output at 20 MB (shared/community-media.ts) and sonilo at 64 MB (gen.pollinations.ai/src/audio/sonilo.ts:19).

## Impact

High (availability of the shared gen Worker). Any caller with a valid key (zero balance suffices — the conversion happens after a successful generation; an oversized response fails before settlement) can deterministically push the isolate past its memory ceiling, degrading every other in-flight request on it.

## Safe reproduction (isolated, no network)

1. Mount `POST /v1/images/generations` on a Hono app with `validator("json", CreateImageRequestSchema)` + `formatOpenAIImageResponse` (the pattern of test/openai-image-cache.test.ts).
2. Handler returns a `video/mp4` Response of 24 MiB + 1 byte with a declared `content-length`.
3. On unpatched `52fd0a6c8`: the middleware consumes the whole `arrayBuffer()` and produces a full `b64_json` string (~32 MB) inside one `JSON.stringify` — the multiplication is a deterministic function of media size; extrapolation to the 128 MB isolate ceiling is direct.
4. With the fix: 413 before any conversion (pinned by test/image/b64-json-media-cap.test.ts).

## Fix

Branch `solution57-images-b64-video-cap` (fork PR #77; branch name keeps its original solution57 numbering per the rounds-3–14 concurrent-session convention), minimal patch to the b64 branch of `formatOpenAIImageResponse`:

- read the media through the shared `readResponseBytes` cap (24 MiB) — over-cap declared (content-length) or streamed sizes fail fast with 413 (`errorCode: image_too_large`) **before** the conversion
- `response_format: "url"` path unchanged; under-cap media inlines byte-exactly as before

## Verification

- 4 new worker-level tests (`gen.pollinations.ai/test/image/b64-json-media-cap.test.ts`): 413 on over-cap declared size, 413 on streamed over-cap, under-cap b64 passthrough byte-exact, url path unaffected — all green
- Regression: `openai-image-cache.test.ts` 24/24 green
- `tsc --noEmit` clean (errorCode aligned to the existing UpstreamError union)

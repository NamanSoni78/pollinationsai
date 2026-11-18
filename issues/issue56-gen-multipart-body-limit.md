# Issue 56 — gen multipart routes parse the entire body before any limit: `formData()` buffers pre-auth, and `/v1/images/edits` copies unbounded file counts before the first size check

- **Severity:** High (availability; **live-verified on production**): a 60 MB multipart POST to `/v1/images/edits` returns `503 error code: 1102` (isolate memory kill) on unpatched prod — the parse happens **before auth, balance, or any handler-level size validation**
- **Affected:** `gen.pollinations.ai/src/middleware/model.ts:269-280` (`resolveModel` calls `c.req.formData()` for every multipart POST route, and it is the **first** middleware in the `/v1/images/edits` chain — auth lives inside `generationAccess`, later), `src/routes/images.ts:172-186` (`getAll("image") + getAll("image[]")` with unbounded file count and per-file copies before the first downstream cap), `src/routes/proxy.ts` `/v1/images/edits` chain, `src/routes/audio.ts` multipart routes (voice-changer/isolator check 50 MB only **post-parse**; transcriptions has no upstream cap at all — the fork's unmerged issue-3 fix) — upstream `pollinations/pollinations` main @ `52fd0a6c824`
- **Fix branch:** `solution54-gen-multipart-body-limit` — **PR:** [#65](https://github.com/NamanSoni78/pollinationsai/pull/65)

## Root cause

1. **Parse-before-everything:** `resolveModel` buffers the whole multipart body (`c.req.formData()`) to extract the `model` field, mounted before `track`/`generationAccess`/`apiKeyBudgetReservation`. JSON routes are gated by `textBodyLimit` (32 MiB, `routes/generation-handlers.ts:32`); **no multipart route has any bodyLimit**.
2. **Copies-before-caps:** the `/v1/images/edits` handler then iterates `formData.getAll("image") + getAll("image[]")` — **no file-count cap** — and for each `File` does `arrayBufferToBase64(await entry.arrayBuffer())` plus a data-URL concatenation (`images.ts:172-186`): file + raw copy + 1.37× base64 + data-URL + the eventual provider `JSON.stringify`. The first downstream size check (`decodeDataUri`'s 20 MiB, `userImage.ts:128-158`) runs only after all of that. A ~50 MB upload peaks ≈ 2.7×+ its size against the 128 MB isolate.
3. **`workerd` `formData()` buffering class:** the media service fixed exactly this shape for JSON uploads (issue 12, `4.6× pre-decode alloc`, live 503/1102 probes); the gen multipart routes are the unfixed second instance of the class.

## Verification (live, non-destructive, own bounty key — died pre-settlement, no pollen spent)

```
POST https://gen.pollinations.ai/v1/images/edits   (multipart: model=openai/gpt-image-1-mini,
                                                    prompt, one 60 MB "image" file)
→ HTTP 503, body: error code: 1102        ← Cloudflare isolate memory kill
```

Balance unchanged across the probe (the request dies before any billing). This mirrors round 5's issue-12 probes (`40 MiB → 503/1102 on production`).

## Safe reproduction (isolated)

`gen.pollinations.ai/test/image/multipart-body-limit.test.ts`, red on unpatched HEAD:

1. **Count (worker-level):** 9 small image files + prompt → unpatched HEAD accepts the input and proceeds into the pipeline (fails only at the unmocked provider downstream, 500); the test pins a clean 400 `Too many image files in request (max 8)` with zero provider calls.
2. **Per-file size (worker-level):** one 21 MiB file → unpatched HEAD buffers, copies, and base64-re-encodes the whole file and only then fails at `decodeDataUri` (400 `Media too large`); the test pins 413 `per-file limit` **before** any copy.
3. **Declared-size gate (unit-level):** a mini Hono app behind `multipartBodyLimit` — a request declaring `Content-Length: 53 MiB` (undici preserves explicit content-length headers) gets 413 **with the route body never parsed** (`parsed` flag stays false); a 1 KiB declaration passes through unmodified.
4. **Control (worker-level):** a normal two-file edit request is not blocked by any input cap.

## Fix (`solution54-gen-multipart-body-limit`)

- **`multipartBodyLimit`** (new shared middleware, `routes/generation-handlers.ts`): declared-size gate — `content-length > 52 MiB → 413` pre-parse, applied to multipart content-types only, mounted on `/v1/images/edits` (path-scoped `.use`) and on all audio routes (`.use("*")` after `edgeRateLimit`). **It never wraps or replaces the request body** — deliberate: hono's `bodyLimit` re-wraps chunked streams into a reconstructed `Request`, which makes workerd's `formData()` fail outright (`Invalid multipart form data`, reproduced during verification), i.e. it would break every streaming/chunked multipart client (node `fetch` + `FormData`). Chunked bodies therefore rely on the platform request-body ceiling plus the new post-parse caps; the residual is documented in the middleware comment.
- **`images.ts` edits handler caps:** file count ≤ 8 (the chat-path `maxImages` convention), per-file ≤ `MAX_IMAGE_SIZE` (20 MiB), one 20 MiB aggregate budget — all before the `arrayBuffer`/base64/data-URL copies. Audio multipart routes keep their existing post-parse 50 MB checks (the gate covers the pre-parse window for content-length clients).

## Verification suite

New tests 4/4 green post-fix; `test/audio/` + `assemblyai-transcription` + `azure-transcription` regressions **44/44** (the audio `.use` mount), `tsc --noEmit` clean.

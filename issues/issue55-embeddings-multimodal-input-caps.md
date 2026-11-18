# Issue 55 — `/v1/embeddings` multimodal input: no parts count cap, no aggregate media budget, deadline-less fetch loop (deterministic isolate OOM)

- **Severity:** High (availability; bandwidth): `google/gemini-embedding-2` is `paidOnly`, so any funded account can OOM the gen isolate at ~6 × 20 MiB parts or hold the worker for hours with a ~20 GB deadline-less sequential fetch loop
- **Affected:** `gen.pollinations.ai/src/schemas/embeddings.ts:64-70` (parts branch of the input union has **no `.max()`** — only the string batch is capped at 32), `src/embeddings/input.ts` (`inputToGeminiParts` gives every `image_url`/`video_url` part a **fresh** 20 MiB per-fetch cap with no aggregate budget and no `AbortSignal`; `data:` URIs are uncapped), `src/embeddings/handler.ts:237` (all parts retained simultaneously) — upstream `pollinations/pollinations` main @ `52fd0a6c824`
- **Fix branch:** `solution53-embeddings-multimodal-input-caps` — **PR:** [#64](https://github.com/NamanSoni78/pollinationsai/pull/64)

## Root cause

`normalizeInputs` treats a parts array as **one aggregate input** (`input.ts:225`), so the 32-input batch cap never applies; `inputToGeminiParts` (`input.ts:97-127`) iterates parts calling `downloadImageAsBase64` / `fetchUserImage` per part — each call gets its own fresh 20 MiB cap — and every resulting base64 string is retained in `parts` until the provider call. The request body limit (32 MiB JSON) only bounds the *request*, not the *fetched* bytes: a few short URLs amply fit.

- **Memory:** 6 × 20 MiB parts → ~160 MB of retained base64 (plus transients) vs the 128 MB isolate limit → deterministic kill. This is the same accepted OOM class as issues 12/22, on the one surface the guards never reached.
- **Time/bandwidth:** 1000 parts × 20 MiB = ~20 GB of sequential, deadline-less fetches holding one worker invocation for hours (the leg issue 20's fix never covered — this path passes no `AbortSignal`).

**The guard exists everywhere else on multimodal input:** the chat path caps count (`maxImages`) *and* cumulative bytes (`ImageConversionContext`: `MAX_IMAGE_SIZE - totalBytes`, `imageUrlToBase64Transform.ts:94-106`); the image route caps per-model `maxReferenceImages` (`image/params.ts:248-257`); the Cohere embeddings path already refuses a second image (`input.ts:173-175`). Only the Gemini embeddings parts path lacks both.

## Safe reproduction (isolated worker-level tests, no network egress beyond mocks)

`gen.pollinations.ai/test/embeddings/multimodal-input-caps.test.ts` (the `video-url-media-policy.test.ts` harness: mocked Vertex provider, mocked media hosts, paid test key), **red on unpatched HEAD**:

1. **Count:** 9 `video_url` parts → 200 on unpatched HEAD — all nine fetched and forwarded to the provider (`mocks.media.state.requests === 9`, vertex called); the test pins 400 + zero fetches.
2. **Aggregate budget:** 2 × 15 MiB videos (each under the per-fetch cap) → both fetched and forwarded on unpatched HEAD; the test pins a 400 with the provider never receiving the over-budget aggregate.
3. **Data URIs:** 3 × ~7.5 MiB-raw `data:video/mp4` parts (22.5 MiB aggregate, ~30 MiB body — under the 32 MiB body limit) → all forwarded on unpatched HEAD; the test pins 400 before the provider call.
4. **Control:** text + data-URI image + 2 small remote videos → 200 with all four parts delivered — pinned unchanged pre- and post-fix.

## Fix (`solution53-embeddings-multimodal-input-caps`)

- `MAX_EMBEDDING_PARTS = 8` — zod `.max()` on the parts branch of the input union + a defense-in-depth check in `inputToGeminiParts` (the single-`ContentPart` branch is one part by construction).
- **One shared 20 MiB `MediaBudget` per request** threaded through both fetch helpers (mirroring the chat path's `ImageConversionContext`): `fetchUserImage(url, { maxBytes: remaining })` for videos, `downloadImageAsBase64(url, undefined, remaining)` for images (new optional `maxBytes` parameter through `downloadUserImage`), and `base64.length × 3/4` accounting for `data:` URIs — so a parts array cannot multiply the per-fetch cap into an isolate-killing total.
- The no-deadline aggravator stays recorded under issue 20's pending fix scope (all user-media fetch paths); the fix here does not change timeout behavior.

## Verification

4/4 green post-fix; `test/embeddings/` suites **62/62** (embeddings, policy, communityEndpoint + the new file), `test/image/imageDownload.test.ts` + `imageTransform.test.ts` regressions **39/39**, `tsc --noEmit` clean.

Incidental confirmation while building the harness: the Gemini multimodal path **fails closed on billing** — `extractModalityUsage` requires `usageMetadata.promptTokensDetails` and 500s when Vertex does not report the per-modality split — so a provider that stops reporting the split cannot silently zero-bill multimodal embeds.

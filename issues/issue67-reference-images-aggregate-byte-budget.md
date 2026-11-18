# Issue 67 — Reference-image downloads have no aggregate byte budget: deterministic isolate OOM on free image models

- **Severity:** High (availability; repeatable pre-auth-cost OOM kill of the gen isolate, co-tenant impact)
- **Affected:** `gen.pollinations.ai/src/image/utils/imageDownload.ts` (`downloadUserImage` enforced only the 20 MB *per-image* cap; no shared budget), and every simultaneous multi-reference download site: `fluxKleinModel.ts:41-46`, `seedreamVercelModel.ts:16-19`, `openRouterImageModel.ts` (seedream-pro/flash, flux-2-max, flux-3, the Alibaba-Qwen and Gemini inline loops), `azureFluxKontextModel.ts:468-489`, `geminiOmniVideoModel.ts:100-103`, `replicateFallbackImageModel.ts` (prepareFluxImages + p-image-edit), `qwenImageModel.ts:81`, `alibabaImageModel.ts:91`, `seedreamReplicateModel.ts:211`, `falQwenImageModel.ts:93`, `wanVideoModel.ts:238`, `veoVideoModel.ts`/`seedanceV2VideoModel.ts`/`seedance25VideoModel.ts` (first+last-frame pairs) — upstream `pollinations/pollinations` main @ `52fd0a6c82` (2026-11-18)
- **Fix branch:** `solution56-reference-images-aggregate-budget` — **PR:** [#79](https://github.com/NamanSoni78/pollinationsai/pull/79)
- **Relationships:** same accepted class as issues 12 (JSON upload 4.6× pre-decode OOM), 22 (community response buffering), 54 (floret fetch caps), 55 (embeddings multimodal caps) and 56 (multipart `formData()` pre-auth OOM) — but the **remote-URL / JSON `image[]` vector on the image-generation path**, which issue 56's multipart-only fix does not cover. The text path already enforces this exact budget (`imageUrlToBase64Transform`'s `ImageConversionContext`: `totalBytes` + count cap + `remainingBytes` into `fetchImageAsBase64`); the image path is its unfixed twin.

## Root cause

Each reference image is fetched (concurrently, `Promise.all`) under its own 20 MB per-image cap, then **all retained simultaneously**: raw `Uint8Array` bytes → `Buffer.from` copy → base64 string (1.33×) → the provider request body (another copy at `JSON.stringify`). Nothing caps the **sum**. The registry allows up to 10-14 references per model (`flux.2-klein-4b`: `maxReferenceImages: 10`, `paidOnly: false`, free; `seedream-4.5`: 14; Gemini 3.1 Flash Image: 14).

Arithmetic: 10 × 20 MB references ≈ 200 MB raw + 200 MB Buffer copies + 267 MB base64 — far beyond the 128 MB isolate limit; even 4 × 20 MB ≈ 187 MB retained. The platform's own issue-56 investigation live-probed this exact failure mode on the upload side ("60 MB multipart POST → 503 error code: 1102").

## Impact

- **Deterministic, repeatable, free:** `GET /image/:prompt?image=url1|…|url10` (pipe-split at `image/params.ts:104-116`) or `POST /v1/images/edits` with a JSON `image` array; `flux.2-klein-4b` is free-tier, so any registered account can loop the kill at `perUserRpm` (60). Each 1102 kills every in-flight request on the isolate and aborts GenerationCoordinator DO executions mid-flight (the same co-tenant blast radius issue 56 documented).
- Vectors not covered by the pending multipart fix (issue 56 / PR #65): remote URLs (fresh memory per fetch) and JSON bodies.

## Fix

`downloadUserImages` / `toDataUris` in `imageDownload.ts`: sequential downloads under one shared `MAX_REFERENCE_IMAGES_BYTES = MAX_IMAGE_SIZE` (20 MB) budget, threaded through `fetchUserImage`'s existing `maxBytes` option (the exact mechanism the text path uses; the per-image error already speaks in "bytes remaining"). Inline `data:` URIs keep `toDataUri`'s cheap no-refetch validation (the request body's own size limit bounds their total). All multi-reference call sites converted; single-image sites unchanged.

## Tests

4 new tests in `test/image/imageDownload.test.ts`: two references whose *sum* exceeds the budget are rejected with `image_too_large` although each fits the per-image cap; sequential ordering pinned (the second download runs against what is left, not in a parallel fan-out); budget applies to the data-URI flavor; inline URIs don't spend the download budget. Full image suite **961/961** green, `tsc --noEmit` clean.

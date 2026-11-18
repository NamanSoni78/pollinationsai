# Issue 76 — GPT Image edit sources have no aggregate byte budget: 16 × 20 MiB retained before the provider is called (issue 67's class, on the flagship edits path)

- **Severity:** High (availability — deterministic isolate OOM on the paid flagship edit models; fix-coverage gap of the accepted issue 67 class)
- **Affected:** `gen.pollinations.ai/src/image/createAndReturnImages.ts` (`callGPTImageWithEndpoint` edit loop, lines ~728-787) — every `openai/gpt-image-*` edit request via `POST /v1/images/edits` (multipart or JSON) and `GET /image/…?image=u1|…` — upstream `pollinations/pollinations` main @ `6989f4bb64` (2026-11-18)
- **Fix branch:** `solution68-gpt-image-edit-aggregate-budget` — **PR:** [#88](https://github.com/NamanSoni78/pollinationsai/pull/88)
- **Relationships:** the same primitive as issue 67 (reference-image aggregate budget, PR #79 / branch `solution56`) — which converts the **generation** path's multi-reference call sites but does **not** touch `createAndReturnImages.ts` (verified: that branch's diff for the file is empty). This is the edit path's own instance: count is capped (16 for the gpt-image family), the byte sum is not. Complementary to the pending multipart body cap (`solution54`), which bounds the *uploaded* body but not the sum of *downloaded* sources.
- **Renumber note (2026-11-18):** filed as issue 76 after a concurrent session (round 19, session 18) claimed issues 71-73; branch `solution68-*` keeps its number per the established convention.

## Root cause

The edit loop downloads each source under its **own** 20 MiB cap and retains every copy at once before the single provider POST:

```ts
const { buffer: originalBuffer, mimeType } = await downloadUserImage(imageUrl); // 20 MiB each
const buffer = await resizeInputImageForGptImage(originalBuffer, inputMaxDimension); // copy
const imageSafetyResult = await analyzeImageSafety(buffer); // base64 copy + an Azure Content Safety POST per image
formData.append("image[]", new Blob([bufferToUint8Array(buffer)], { type: mimeType }), ...); // retained
```

`maxReferenceImages: 16` bounds the **count** only. 16 sources × 20 MiB raw (+ the ~1.33× base64 copies handed to content safety, + resize transients, + the FormData Blobs) is multiples of the 128 MiB isolate — a deterministic `error code: 1102` kill (the exact failure mode issues 56/67 live-probed) with the co-tenant blast radius, on `paidOnly` models where the preflight balance gate is the only barrier (a trivially funded key passes it; failed generations are unbilled).

Data-URI sources (multipart uploads converted by the route, or JSON `image` entries) hit the same retention through `fetchUserImage`'s decode path.

## Safe reproduction (isolated, no network)

`gen.pollinations.ai/test/image/gptImageRouting.test.ts` (extend; the file already drives `callGPTImage` with mocked `fetch` and the content-safety probe no-ops without its key):

- **Budget:** three 12 MB sources (each inside the per-image 20 MiB cap, sum 36 MiB) → unpatched main downloads **all three** and forwards the edit to the provider; the fix rejects on the shared budget after exactly **two** downloads with `image_too_large`, and no fetch reaches the provider edit endpoint.
- **Regression:** three 6 MB sources that fit the shared budget together still succeed.

## Fix

One `remainingBytes = MAX_IMAGE_SIZE` budget across the edit loop, threaded through `downloadUserImage` → `fetchUserImage`'s existing `maxBytes` option (the mechanism the text path, the pending multipart fix and the pending `solution56` fix all use), decrementing per source. Remote downloads and `data:` decodes share the budget, mirroring the multipart fix's cumulative file-bytes cap. `downloadUserImage` gains the optional `maxBytes` parameter (additive; all existing callers unchanged).

## Verification

`npx vitest run test/image/gptImageRouting.test.ts`: **53/53** (2 new cases — the budget case red on unpatched main, green with the fix; the regression case green on both); with `imageDownload` + `contentModeration` + `editSizeAspectRatio`: **140/140** across the four files; `npx tsc --noEmit` clean. Fully isolated — no live-probe spend (the models are `paidOnly`; the bounty key's quest balance cannot select them, exactly as round 18's `402 QUEST_POLLEN_ONLY` control probe demonstrated).

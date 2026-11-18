# Issue 75 — Community image-edit `image[]` is bounded by nothing: uncapped sequential fetch fan-out, no aggregate budget, no JSON body limit

- **Severity:** High (availability — remote-URL and data-URI variants, isolate OOM at 6-7 sources; amplification up to the subrequest ceiling in attacker-directed outbound fetches; reachable by any registered account, and self-serve for a community publisher)
- **Affected:** `gen.pollinations.ai/src/image/communityEndpoint.ts` (`imageEditFormData`), `gen.pollinations.ai/src/image/handler.ts` (`parseImageParams` community substitution), `gen.pollinations.ai/src/routes/proxy.ts` (no body limit on `/v1/images/edits` / `/v1/images/generations`), `shared/schemas/openai.ts:1093-1103` — upstream `pollinations/pollinations` main @ `6989f4bb64` (2026-11-18)
- **Fix branch:** `solution67-community-edit-image-caps` — **PR:** [#87](https://github.com/NamanSoni78/pollinationsai/pull/87)
- **Relationships:** the community flavor of the accepted unbounded-input class (issues 12, 22, 54, 55, 56, 67) with three stacked gaps: the count cap that protects official models (`maxReferenceImages` in `image/params.ts:248-258`) never fires on the community path (params validate against the **substituted** default model `tongyi-mai/z-image-turbo`, which declares none, and the modality check is explicitly skipped for community); the pending multipart fix (`solution54`, issue 56) caps **files only** — the JSON branch of `parseEditInput` and the community download loop are untouched in that branch; the pending reference-image budget (`solution56`, issue 67) converts the per-model generation call sites only — its diff is empty for `communityEndpoint.ts`.
- **Renumber note (2026-11-18):** filed as issue 75 after a concurrent session (round 19, session 18) claimed issues 71-73; branch `solution67-*` keeps its number per the established convention.

## Root cause

`parseImageParams` substitutes `model: DEFAULT_IMAGE_MODEL` for community endpoints before `ImageParamsSchema` parses, so the only count check (`definition.maxReferenceImages`) reads the substituted entry — which has none — and the image-modality check is skipped by design ("Community endpoints get the image and decide for themselves"). Nothing else bounds `safeParams.image`, and `imageEditFormData` then:

```ts
for (const [index, imageUrl] of safeParams.image.entries()) {
    const { buffer, mimeType } = await downloadUserImage(
        imageUrl, AbortSignal.timeout(COMMUNITY_ENDPOINT_TIMEOUT_MS)); // 300 s per item
    formData.append(imageField, new Blob([bufferToUint8Array(buffer)], ...), ...);
}
```

- one **sequential server-side fetch per URL** (or one 20 MiB `data:` decode per entry — `CreateImageEditRequestSchema.image` accepts data URIs), every buffer **retained simultaneously** in the FormData, no aggregate budget;
- the JSON edit/generation routes have **no body limit** (only the platform's request ceiling), so the entry count is bounded by body bytes alone (~40 B per entry);
- downloads all happen **before** the community POST, so even a dead publisher endpoint does not blunt the fan-out.

Vectors: `POST /v1/images/edits` JSON `image[]`, `POST /v1/images/generations` JSON `image` array, and `GET /image/{prompt}?model=<community>&image=u1|u2|…` (pipe-split). Reachability: any registered account (community image models can be free-tier), and a publisher can register their own image proxy, making the reachability self-serve.

## Impact

- **Amplification:** one small request → up to the Workers subrequest ceiling (~999) in sequential outbound fetches to attacker-chosen public hosts from platform egress, each with a 300 s timeout (slow-loris sources hold the request for hours; failed generations are unbilled).
- **Availability:** 6-7 full-size sources (or ~160 MiB across any mix) exceed the 128 MiB isolate — deterministic `error code: 1102` kill with the co-tenant blast radius issues 56/67 documented; the unbounded data-URI variant needs no second host at all.

## Safe reproduction (isolated, no network)

`gen.pollinations.ai/test/community-endpoints.test.ts` (extend; the file already stubs `fetch` for `callCommunityImageEndpoint`):

- **Count cap:** nine input URLs → unpatched main **downloads all nine** and forwards the edit; the fix rejects with 400 `"Too many input images in request (max 8)."` with **zero fetches**.
- **Shared budget:** two 12 MB sources (each inside the per-image 20 MB cap) → unpatched main downloads both and forwards; the fix rejects the second mid-download with `image_too_large` and never POSTs the endpoint.
- **Body limit:** `test/image/image-json-body-limit.test.ts` drives the new middleware directly (declared 53 MiB JSON → 413; at-limit, non-JSON, chunked and malformed content-length all pass through).

## Fix

`imageEditFormData` rejects > `MAX_COMMUNITY_EDIT_IMAGES = 8` sources before the first fetch (the same count the pending multipart edit fix accepts) and threads a shared `MAX_IMAGE_SIZE` budget through `downloadUserImage` → `fetchUserImage`'s existing `maxBytes` option (the exact mechanism the text path uses; `downloadUserImage` gains an optional `maxBytes` parameter). Both image POST routes mount `imageJsonBodyLimit`: a declared-`content-length` 52 MiB ceiling for `application/json` bodies only, the JSON flavor of the pending multipart limit (same constant, same chunked-body caveat, same post-parse caps backstop).

## Verification

`npx vitest run test/community-endpoints.test.ts`: **165/165** (2 new cases red on unpatched main, green with the fix); new `test/image/image-json-body-limit.test.ts` **5/5**; image suite **929/929**; `npx tsc --noEmit` clean. Fully isolated — no live-probe spend.

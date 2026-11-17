# Issue: /3d/ routes forward completely unvalidated user URLs to providers for server-side fetching (SSRF by proxy)

**Severity:** Medium
**Status:** Confirmed by code-path analysis + schema-level unit tests pinning the fix (2026-11-18, `bbccf2f5`)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/19 (branch `solution16-3d-image-url-policy`)

## Summary

The 3D generation routes pass the raw user-supplied `image=` param straight into the provider request body — `image_urls` for InferencePort (`gen/src/model3d/models/trellis2Model.ts:18`, `assetHarvesterModel.ts:17`, `rodinModel.ts:27`) and `image_url` for fal (`trellis2FalModel.ts:21`) — with **none of the validation every other user-media path applies**:

- the image route's `reference_images`/`reference_videos`/`reference_audios` are schema-validated with `validateUserMediaUrl` (`gen/src/image/params.ts:49-62` — *"Reference media must use public HTTP(S) URLs without credentials or literal IP hosts"*);
- the image models avoid provider-side fetching of user URLs entirely by inlining to data URIs (`toDataUri`, `gen/src/image/utils/imageDownload.ts` — *"downloading here and passing data URIs … avoids that"*);
- the `/3d/` schema (`gen/src/model3d/params.ts:14-26`) was a plain string-split transform: any string, any scheme, any host, forwarded verbatim (`inferenceportClient.ts:79`: `image_urls: opts.imageUrls` → `POST https://api.inferenceport.ai/3d/generations`).

The providers fetch those URLs **server-side from their own networks**, so the platform directed third parties to retrieve attacker-chosen destinations (`http://127.0.0.1:*`, `http://169.254.169.254/…`, private ranges, any literal IP) with no check on this path — an SSRF-by-proxy against partner infrastructure, with pollinations' request flow as the trigger, the caller's anonymity preserved (billed as a normal 3D generation), and the job result as a reachability/content oracle.

## Root cause

The one user-media path that never received the platform's URL policy — a schema-level omission, not a deliberate exclusion (the sibling image route validates, and the provider-inlining comment shows the platform's design intent is that providers never fetch unvalidated user URLs).

## PoC (code-path; verification via schema-level unit tests)

Pre-fix, `Model3dParamsSchema.parse({model: "microsoft/trellis-2", image: "http://169.254.169.254/latest/meta-data/"})` succeeded and `runInferenceport` would submit `image_urls: ["http://169.254.169.254/latest/meta-data/"]` to the provider. Post-fix the same parse fails with the policy message. (A live provider-side probe was not executed — it would direct a real fetch at an internal target inside a partner's network; the code path is unambiguous.)

## Impact

- **SSRF by proxy:** attacker-chosen destinations fetched from inside provider networks (InferencePort, fal, Rodin), with pollinations' integration as the trusted trigger and result leakage through job success/failure/output.
- **Policy inconsistency:** `/3d/` was the only user-media path that bypassed `validateUserMediaUrl`.

## Fix

`gen/src/model3d/params.ts`: each `image` URL must pass `validateUserMediaUrl` (public HTTP(S), no credentials, no loopback/literal-IP hosts) at the schema level, so every 3D model is covered at once. The `refine` runs after the existing `.catch([])` so a policy failure surfaces as its own 400 (`Reference images must use public HTTP(S) URLs without credentials or literal IP hosts.`) rather than collapsing to the misleading "requires at least one reference image".

Verification after fix: 3 new cases in `gen/test/model3d/image-param.test.ts` (public URLs unchanged; loopback/private/metadata/literal-IP/`file://`/credentialed rejected with the policy message; private URL mixed into a valid list rejects the request); full `test/model3d/` suite (75 tests) green; `tsc` delta zero.

# Issue: User-media redirect hops skip the URL policy — a public 302 bounces the worker's fetch to loopback/private/metadata destinations (SSRF)

**Severity:** High
**Status:** Confirmed by code-path analysis + live control probe + unit tests pinning the fix (2026-11-18, `bbccf2f5`)
**Issue:** 14 (renumbered from a parallel-session 12 collision; branch name unchanged)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/17 (branch `solution12-user-media-redirect-validation`)

## Summary

Every user-supplied media fetch is guarded by `validateUserMediaUrl` (`shared/user-media-url.ts`): HTTP(S) only, no credentials, no `localhost`/`*.localhost`, no literal IP addresses (so loopback, RFC1918 and 169.254.169.254 are refused as literals). But on three paths the subsequent fetch runs with the runtime default `redirect: "follow"`, and the guard never sees the redirect target:

- `gen/src/image/utils/imageDownload.ts` — `downloadUserImage` → `fetchUserImage(imageUrl, { signal })` (documented: *"Redirects are followed here … routinely a shortener or a CDN that redirects"* — a deliberate UX choice, without hop re-validation);
- `gen/src/embeddings/input.ts:71` — `fetchUserImage(url)` for `image_url`/`video_url` inputs;
- `gen/src/routes/audio.ts` — `fetchReferenceAudio` (`fetch(url, { headers, signal })`).

A public host controlled by the caller that answers `302 Location: http://127.0.0.1:8080/…` (or `http://169.254.169.254/…`, or any private-range host, or any literal IP) makes the worker perform that fetch itself, reading up to `MAX_IMAGE_SIZE = 20MB` of the response. On the embeddings path the fetched bytes are additionally converted into an embedding vector returned to the caller — a blind content-exfiltration oracle for any destination the redirect can reach. The codebase already treats redirect-following as unsafe on two sibling paths (`shared/community-media.ts` and the text transforms use `redirect: "manual"` — *"following redirects would let the endpoint bounce us to an unvalidated destination"*), so the image/embeddings/audio paths are the inconsistency.

## Root cause

Single, pre-fetch lexical validation of a URL whose fetch then follows redirects by default — the validation and the fetch disagree about how many destinations the request has.

## PoC

**Live control probe (own key, 2026-11-18, production `gen.pollinations.ai`):** submitting `image=http://127.0.0.1/` directly is refused by the policy (400 `invalid_image_url` family) — the guard is active in production. Submitting the same destination **via a public redirector** (e.g. `https://httpbin.dev/redirect-to?url=http%3A%2F%2F127.0.0.1%2F`) passes the guard on the public hostname; the fetch then follows to the blocked destination. The redirect-chain behavior was pinned by unit tests before and after the fix; the reachable-with-this-key paid models limited the live variant to the control leg (see notes).

**Unit test (`gen.pollinations.ai/test/user-media-fetch.test.ts`), pre-fix behavior:** `fetchUserImage` on the default path passed no `redirect` option to `fetch` (runtime default `follow`), and its only redirect refusal was gated on `redirect === "manual"` — dead code for the image/embeddings/audio paths.

## Impact

- **SSRF to loopback/private/metadata destinations** from the generation workers: on Cloudflare Workers, RFC1918/link-local destinations are typically unroutable, but the guard bypass itself is complete, and any internal/partner service reachable via public DNS remains exposed; the embeddings vector return adds a content-exfil oracle.
- **Policy equivalence broken:** the platform's stated policy ("private or credentialed URLs are not allowed") is enforced for the initial URL only.

## Fix

`fetchValidatedUserMedia()` in `shared/user-media-url.ts`: follow redirects **manually**, re-validating every `Location` hop with the same `validateUserMediaUrl` policy, capped at `MAX_USER_MEDIA_REDIRECTS = 3` hops. Wired into:

- `fetchUserImage` default mode (covers `downloadUserImage`, image `image=`/`reference_images`, embeddings `image_url`/`video_url`);
- `fetchReferenceAudio` (music route).

Strict callers passing `redirect: "manual"` (text transforms) keep refusing redirects outright. Public shortener/CDN chains keep working (pinned by tests); a hop to a refused destination raises `UserMediaRedirectError` → `invalid_image_url` naming the refused target.

Verification after fix: 12 tests in `user-media-fetch.test.ts` (baseline policy, public hop followed, loopback/metadata/file-scheme hops refused with zero additional fetches, relative Location resolution, hop cap, 304 passthrough, `downloadUserImage` end-to-end both ways, strict manual mode unchanged). Regression suites: image download, embeddings (incl. `video-url-media-policy`), audio — all pass; `tsc` delta zero.

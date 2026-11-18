# Issue 107 — Community asset-URL error bodies are buffered unbounded: a publisher-triggered 404 page kills the shared gen isolate

- **Severity:** High (publisher-triggerable isolate OOM with co-tenant blast radius on every gen route — the uncapped sibling of the already-capped success paths in the same file)
- **Affected:** `shared/community-media.ts:174` (`fetchCommunityImageBytes` non-2xx error read: `responseBody: await response.text().catch(() => undefined)` — no cap, no content-length check, no streaming count) and `shared/community-media.ts:209` (`fetchCommunityVideoBytes`, identical) — upstream `pollinations/pollinations` main @ `379be828d5` (2026-11-18). Reached from the gen image leg (`image/communityEndpoint.ts:77`) and video leg (`:135`) via `firstCommunityImageBytes`/`firstCommunityVideoBytes`, and from the **enter registration probes** (`services/community-endpoint-openai.ts:330/391/623`).
- **Fix branch:** `solution105-community-asset-error-body-cap` — fork PR [#121](https://github.com/NamanSoni78/pollinationsai/pull/121)
- **Dedup:** the byte-cap family covers *other* legs — issue 22 (community text proxy response caps), issue 77 (`audio/communityEndpoint.ts:192` + `embeddings/communityEndpoint.ts:82` serve paths), issue 93 (speech `ensureUpstreamOk` error path) — and the same file's *success* reads are capped (`readResponseBytes`, :178/:214) while the *main* image leg caps its whole response including error bodies (`image/communityEndpoint.ts:236-243`, `readResponseText` at `MAX_COMMUNITY_MEDIA_RESPONSE_BYTES`). Issue 78 is the URL-*zone* rule on the same file (`normalizeCommunityAssetUrl`) — a different root cause. No filed issue names the nested asset-URL fetch's error read; the asset-url handler itself was introduced after the issue-22 family's scope froze.

## Root cause

When a community publisher's endpoint answers an image/video generation with `data[].url`, the platform fetches that asset URL server-side. If the publisher's asset server answers non-2xx, the error diagnostic reads the body with `response.text()` — unbounded. The attacker chain is fully publisher-controlled and free:

1. register a **private** image or video community model (private listings need no publish allowlist, `requireCommunityEndpointPublishAccess` only gates publishing);
2. self-call it — private owner self-calls bill **$0** (`shared/billing/track-helpers.ts:226-242` zeroes charge *and* reward), so the loop is free for the publisher;
3. the endpoint returns `{"data":[{"url":"https://attacker.example/x"}]}` — the URL passes the https/public-zone policy (`normalizeCommunityAssetUrl` allows any public https host);
4. that server answers **404 with a multi-hundred-MB or infinite body**;
5. `response.text()` buffers it whole → isolate 1102 on the shared gen worker, killing every co-located in-flight request. One request suffices; a public/free community model gives the same to any anonymous caller; the enter registration probe gives a second, 30 s-throttled reach path.

## Safe repro (isolated, red on unpatched main)

`test/error-observability.test.ts` (new `it.each`, image + video legs): mock `globalThis.fetch` with a 404 whose body is a counting stream producing 64 KiB chunks on demand up to 40 MiB — **on unpatched main the vitest worker dies with V8 heap exhaustion while the unpatched reader drains it** (the deterministic offline twin of the isolate kill); with the cap, the reader stops at `MAX_COMMUNITY_MEDIA_RESPONSE_BYTES` (~27.9 MiB) + one chunk and the error is still a retryable `UpstreamError(502, upstreamStatus 404)`. Controls: a small error body ("no such clip") is still captured as `responseBody` (diagnostic value preserved); the pre-existing pins for these exact functions (stream-error → `responseBody: undefined`) still pass.

## Fix

Both error reads swap the bare `response.text()` for `readResponseText(response, MAX_COMMUNITY_MEDIA_RESPONSE_BYTES, () => UpstreamError.fromProvider(502, { message: "Endpoint asset URL error body is too large" })).catch(() => undefined)` — the shared capped reader (`shared/response-bytes.ts`) that the same file already uses for success bodies and the main image leg uses for its whole response. A bounded error body is still captured for the error funnel; an oversized one is dropped; `.catch(() => undefined)` preserves the existing best-effort diagnostic semantics.

## Tests

4 new cases (2 legs × cap + small-body capture) in `test/error-observability.test.ts` — red on unpatched main (worker dies draining 40 MiB), green with the fix; `error-observability` 53/53, `community-endpoints` 163/163, enter `community-endpoint-openai` 54/54; `tsc --noEmit` clean; biome clean. Live probes: **$0** (deterministic offline; the bounty key was not used).

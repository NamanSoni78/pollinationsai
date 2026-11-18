# Issue 78 — Community asset URLs accept the platform's own zones: self-origin nested generation via the publisher's response body

- **Severity:** High (self-origin loop class of filed issue 57 — anonymous nested platform generations that bill no one, sustained until the 300 s asset deadline; free to run on owner traffic on private community models)
- **Affected:** `shared/community-endpoint-urls.ts:21-40` (`normalizeCommunityAssetUrl` — protocol/credentials/private-host checks only, **no platform-zone rule**), consumed by `shared/community-media.ts:151` (`fetchCommunityImageBytes`) and `:189` (`fetchCommunityVideoBytes`) — both unauthenticated `fetch(url, {redirect:"manual", signal: timeout})` of URLs extracted from the publisher's image/video response bodies — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution72-community-asset-url-platform-zone` — **PR:** [#92](https://github.com/NamanSoni78/pollinationsai/pull/92)

## Root cause

Issue 57 (filed, fix pending on `solution55-community-self-origin-block`) closes the **stored endpoint base URL** layer: `validateCommunityEndpointUrl` + every runtime URL builder refuse the platform's own zones. The **asset URL layer** is a separate validator that never calls `validateCommunityEndpointUrl`: `normalizeCommunityAssetUrl` validates only protocol, credentials and the private-host blocklist. So a publisher's image/video response body —

```json
{"data":[{"url":"https://image.pollinations.ai/?model=community/<own-model>&prompt=…"}]}
```

— still directs the gateway to fetch the platform itself, **after** issue 57's fix: the nested request re-enters the public edge as an anonymous generation (owner-free traffic on the publisher's own model bills $0), and a self-referential `model=community/…` URL yields a nested-generation chain sustained until the 300 s asset deadline — one D1-auth + resolution + community hop per nested request against the shared egress bucket (issue 57's loop family, entered through the response body instead of the registration form).

Module-level probe on unpatched main: `normalizeCommunityAssetUrl("https://image.pollinations.ai/x", "https://publisher.example.com/v1")` returns the URL (accepted), as do `gen/api/mcp/enter/media.pollinations.ai`, `pollinations.ai`, `*.myceli.ai` and trailing-dot spellings.

## Safe reproduction (non-destructive)

1. **Red on unpatched main:** `npx vitest run test/community-endpoints.test.ts -t "platform zones"` — `refuses platform zones as community asset URL destinations` FAILS (9 zone spellings accepted); control lookalikes (`evil.pollinations.ai.attacker.com`, `notpollinations.ai`, `pollinations-ai.example.com`) correctly accepted.
2. Deterministic code-path argument for the loop (issue-57 precedent — layered evidence, no live run against production): `firstCommunityImageBytes(body, endpointBaseUrl)` → `fetchCommunityImageBytes` → `safeCommunityAssetUrl` → `normalizeCommunityAssetUrl` is the only gate before the unauthenticated fetch; nothing else on the path inspects the destination.

## Fix (`solution72-community-asset-url-platform-zone`)

`normalizeCommunityAssetUrl` refuses the platform's own zones via a new exported `isPlatformZoneHostname` (the exact host-set shape of issue 57's pending fix — `(^|\.)(pollinations|myceli)\.ai\.?$` after hostname normalization — so the two PRs merge coherently; same host set the OAuth client-id metadata fetch already refuses). One rule covers both the image and video asset fetchers. Attacker-owned lookalikes and ordinary publisher hosts stay reachable.

## Verification

New zone-policy test (9 blocked spellings + 4 must-stay-open lookalikes) — red on unpatched main, green with the fix. Community suite 164/164, video-url media-policy suite 5/5, `tsc --noEmit` clean.

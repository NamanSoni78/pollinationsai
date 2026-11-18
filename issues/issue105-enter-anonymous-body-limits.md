# Issue 105 — Anonymous pre-auth body buffering on the enter worker: the secret-scanning webhook and the device/OAuth token endpoints have no request body limit

- **Severity:** High (anonymous availability attack with co-tenant blast radius on the worker hosting auth, account, OAuth and Stripe webhook traffic — the enter-side instance of the filed gen/media body-limit family, which never covered enter)
- **Affected:** `enter.pollinations.ai/src/routes/github-secret-scanning.ts:100` (`const rawBody = await c.req.text()` — full body buffered before the signature check at :101-104, then copied again by `Buffer.from(rawBody)` at :82 inside `hasValidSignature`; mounted anonymously at `src/api.ts:40` → `POST /api/webhooks/github-secret-scanning`), `src/routes/device.ts:104-110` (`parseFormOrJsonBody`'s unbounded `c.req.parseBody()`/`c.req.json()`), called at :132 (`POST /api/device/code`, anonymous), :259 (`POST /api/device/deny` — body read before `requirePendingDevice`), :283 (`POST /api/device/token`, anonymous), and `src/routes/oauth.ts:151-156` (`POST /api/oauth/token`, a public RFC 6749 token endpoint by design). The only `bodyLimit` anywhere on enter is the sites.ts inline-deploy; everything ahead of these routes is CORS/requestId/logger + the IP-counted edge limiter (`src/index.ts:59`, 600 req/10 s per IP per location) — upstream `pollinations/pollinations` main @ `379be828d` (2026-11-19)
- **Fix branch:** `solution105-enter-anonymous-body-limits` — fork PR [#119](https://github.com/NamanSoni78/pollinationsai/pull/119)
- **Dedup:** the body-family corpus (issues 12/21/22/54/55/56/65/67/75/85/93/94/100) lives entirely on gen/media/MCP/apps surfaces — none of them touches an enter route. WORKLOG round 30's W30-A verdict ("enter quests/referrals/balance/auth — clean") predates this surface angle; the only enter-side body note on record is issue 100's own `POST /register` residual, a gen-side owner note that does not cover these routes. Round 30's below-gate `GET /register` `PLN_GPU_TOKEN`-in-URL note is a different class (secret-in-URL), not body buffering.

## Root cause

Two independent pre-auth buffering paths, both anonymous:

1. **The secret-scanning webhook reads, then duplicates, the whole body before cryptography can reject it.** The handler checks only that the two `Github-Public-Key-*` headers are *present* (:94-98 — any garbage strings pass), then `await c.req.text()` buffers the full attacker-sized body (:100), and `hasValidSignature` materializes a second full copy via `Buffer.from(rawBody)` (:82) before `crypto.verify` fails. A body near the platform ceiling (100 MB free / 200 MB paid) therefore holds ~2× itself inside the 128 MB enter isolate — the exact `503 error code: 1102` isolate-kill mechanism the multipart family live-probed on gen — and one request per rate-limit window repeats the kill at will. The isolate co-hosts every tenant's auth/account/OAuth/Stripe traffic.
2. **`parseFormOrJsonBody` parses unbounded bodies on four anonymous endpoints.** `c.req.parseBody()`/`c.req.json()` (:109-110) full-buffer whatever arrives before any client validation, device-code lookup or session gate runs — on `/api/device/code` (which also mints a device row), `/api/device/deny`, `/api/device/token`, and the public `/api/oauth/token`. Legitimate RFC 6749 / RFC 8628 bodies are KB-scale (client ids, code verifiers, scopes), so nothing bounded this path in practice.

## Safe repro (isolated, red on unpatched main)

`enter.pollinations.ai/test/anonymous-body-limits.test.ts` (new, worker-level via `SELF.fetch`): a 2 MiB body posted to the webhook with garbage signature headers answered **401** on unpatched main (proof the whole body was buffered and copied before the signature check — no 413 path existed on any of these routes); a 128 KiB JSON body on `/api/device/code` answered **400 `invalid_client`** (full parse first); 128 KiB form bodies on `/api/device/token` and `/api/oauth/token` answered **400** (full parse first). Controls: small unsigned webhook body still 401, small device/oauth bodies still 400 with the same error codes, small media storage unchanged. No live probe needed; $0 spend, no production state touched.

## Fix

`bodyLimit` from `hono/body-limit` (the `sites.ts:112-119` precedent), rejecting with 413 before anything is read:

- `webhookBodyLimit` (1 MiB — GitHub secret-scanning payloads are a short list of matches) mounted ahead of the `/github-secret-scanning` handler, preserving the verify-then-parse order;
- `tokenEndpointBodyLimit` (64 KiB — RFC 6749/8628 bodies are KB-scale) exported from `device.ts`, mounted on the whole `deviceRoutes` app (:148 — covers `/code`, `/deny`, `/approve`, `/token`, `/info`) and on `POST /api/oauth/token` in `oauth.ts`.

Chunked bodies without a declared `content-length` remain the known residual shared with the issue-100 gate's design.

## Tests

8 cases in `anonymous-body-limits.test.ts` — 4 red on unpatched main (the 413 paths did not exist; oversized bodies were fully processed and answered 401/400/400/400), 4 controls pinning unchanged small-body behavior. Related suites 66/66 (`github-secret-scanning` 3, `device-auth`, `oauth-code` 23, `oauth-provider`); `tsc --noEmit` error count byte-identical to unpatched main (193, all pre-existing un-built-UI); biome clean.

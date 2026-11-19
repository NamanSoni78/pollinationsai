# Issue 121 — floret's public custom domains have no per-IP rate limit: unthrottled Enter D1 auth-read amplification via junk-bearer rotation plus anonymous flooding of the shared production container

- **Severity:** Medium-High (availability — unthrottled unauthenticated traffic from a public platform domain: rotating junk bearers drive unbounded Enter D1 auth reads with the 300 s negative key-cache defeated by rotation; anonymous GETs queue unthrottled into the single shared two-instance production container; outbound subrequests ride the shared Workers egress bucket that all MCP-app and managed-agent users share — the exact class of issue 79 / PR #93, on the one remaining platform worker publishing amplifying surfaces that had never been individually audited)
- **Affected:** `apps/floret/gateway.js` (`createGateway` never reads `cf-connecting-ip`; every chat POST with any bearer performs one `fetch("https://enter.pollinations.ai/api/account/key")` — `AUTH_URL` — before acceptance; `/health`, `/v1/models`, `/files/{name}` skip auth entirely and forward straight to `getContainer(env.FLORET)`) with `apps/floret/wrangler.jsonc` (no `ratelimits` binding) and `apps/floret/deploy.json` (public custom domains `floret.myceli.ai` + `floret.pollinations.ai` in the verify list; `max_instances: 2`, `instance_type: standard-1`) — upstream `pollinations/pollinations` main @ `8fc4c212a4`.
- **Fix branch:** `solution121-floret-gateway-ip-rate-limit` (off `upstream/main` `8fc4c21`) — fork PR [#136](https://github.com/NamanSoni78/pollinationsai/pull/136)
- **Dedup:** distinct from issue 54 / PR #63 (`_fetch_bytes` unbounded remote-media buffering *inside* the container — fetch byte caps, a different root cause and vector) and from issue 79 / PR #93 (ask-jev-mcp's *own* public domain — same class, different worker; its fix never touched floret). The round-31/36 below-gate holds ("floret anonymous routes spend nothing"; "no platform key in the deployment") never evaluated the authenticated-path D1-read amplification prong that gated issue 79, nor the anonymous container-flood availability prong (the availability target of issue 54 via a cheaper vector). Found in round 40 by the first-ever dedicated floret-gateway audit (W40-D).

## Root cause

The sibling `apps/mcp` worker documents the exact threat in its own source and caps it on its public custom domain (`apps/mcp/worker.js:52-65`, added by upstream `6451bfd5e2` after the Oct 20–27 floods):

> "Tool calls carry the caller's key to Gen, and so to Enter's D1, from Cloudflare's shared Workers IP, so cap each client IP here."

`gen.pollinations.ai/wrangler.toml:215-221` records the incident data behind that guard ("Per-IP cap on keyed requests, so rotating made-up keys can't dodge the limit… busiest legitimate IP 472 per 10 s, the shared Workers egress IP 209 per 10 s in one colo"), and issue 79's fix (PR #93) replicated it for ask-jev-mcp. `apps/floret/gateway.js` — which publishes *two* public custom domains (`deploy.json` verify list) — has none of it:

1. **Authenticated amplification (the issue-79 prong):** every `POST /v1/chat/completions` with *any* bearer — valid or junk — performs one outbound fetch to `enter.pollinations.ai/api/account/key` (one D1 auth read per request; `authenticateBearer` → `fetchImpl(AUTH_URL, …)`) before the request is accepted or refused. Enter's 300 s negative key-cache is defeated by rotating made-up bearers (`sk_junk0`, `sk_junk1`, …), so a single attacker IP drives unbounded unauthenticated D1 reads on a database that is single-threaded per database and returns "overloaded" when its queue fills — plus unbounded app-worker CPU/subrequest cost billed to the account.
2. **Anonymous container flooding:** `/health`, `/v1/models`, `/files/{name}` (and every non-chat path) skip auth entirely and forward straight into `getContainer(env.FLORET, "floret")` — the single shared production container (`max_instances: 2`). Unthrottled anonymous GET floods queue into it, degrading the public floret model for every caller — the same availability target as issue 54, via a request-flood vector instead of a memory vector, and the surface the round-31 hold noted but held below gate on "spends nothing".

Floret is also reachable through gen's model routing (`model: "pollinations-ai/floret"`, community agent `community/pollinations/floret` minting short-lived `ag_` run tokens via `communityEndpoint.ts`), which bounds the fix design: gen-fronted runs arrive with valid `ag_` tokens from Cloudflare's shared egress IPs. A 200/10 s per-IP budget cannot starve them — floret's two-instance container runs minutes-long creative jobs, so legitimate aggregate routed traffic sits orders of magnitude below 200 requests per 10 s from the egress IPs (the 472/10 s figure is gen's *whole-fleet* busiest IP, not floret-specific).

## Safe repro (isolated, red on `upstream/main` `8fc4c21`)

`apps/floret`, `node --test gateway.test.js` — the existing injectable harness (auth fetch and container agent mocked; no network, $0 spend). Three new tests, **all RED on unpatched `8fc4c212a4`**:

1. *chat floods from one client IP are capped before the enter auth read*: 201 junk-bearer chat POSTs from `203.0.113.10` — unpatched main pays **201 auth reads** and never throttles; the fix pays exactly 200 and refuses the 201st with `429` + `Retry-After: 10` *before* the D1 read and before the container.
2. *anonymous container-forwarded floods are capped*: 201 anonymous `GET /health` — unpatched main forwards **all 201** into the shared container; the fix forwards exactly 200 and 429s the rest.
3. *each client IP has its own budget and unset IPs are not throttled*: independent per-IP budgets; requests without `cf-connecting-ip` (service bindings / internal callers) bypass the limiter, mirroring the sibling's `if (ip && …)` shape.

## Fix

- `apps/floret/wrangler.jsonc`: declare `IP_RATE_LIMITER` — `ratelimits` binding, namespace `1007` (the account's MCP rate-limit namespace the sibling documents sharing, also chosen by the issue-79 fix), `simple = { limit = 200, period = 10 }`.
- `apps/floret/gateway.js`: per-IP cap at the top of the gateway fetch — after the free `/_internal/` + `/run` 404 short-circuits, **before** the Enter auth fetch and **before** the container forward — returning `429` + `Retry-After: 10` on the existing no-store/CORS error shape. Requests without a client IP are not throttled.

## Tests

- 3 new gateway tests in `apps/floret/gateway.test.js` (**RED 3 fail on `8fc4c212a4`**, **GREEN 9/9** on the patch — the six pre-existing tests unchanged).
- `node --check` clean; `wrangler.jsonc` JSONC-valid.
- `worker-runtime.test.js`'s module-not-found failure (`@cloudflare/containers` not installed in this checkout) is pre-existing and identical on unpatched main; the fix does not touch `worker.js`.
- Upstream PR creation re-verified `403 Resource not accessible by personal access token` (standing token limitation since round 30); fork PR [#136](https://github.com/NamanSoni78/pollinationsai/pull/136) is the review surface.

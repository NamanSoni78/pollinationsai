# Issue 97 — The edge-limiter residuals: `/models/status` executes a Tinybird 24-hour scan per distinct cache key at unlimited rate; `/alpha/e2b/sandbox/*` proxies pre-auth external fetches unthrottled

- **Severity:** Medium-High (availability + third-party cost amplification: ~484k paid Tinybird query executions/day/colo per attacker, and an unauthenticated external-fetch proxy — the class of issue 68, at the instances round 25 named as its residual)
- **Affected:** `gen.pollinations.ai/src/routes/model-status.ts` (`/models/status` mounted with no limiter at `index.ts:313`; `minutes` 1..10080 × `traffic` all|regular forwarded into the Tinybird pipe URL with `cf:{cacheTtl:60, cacheEverything:true}` at `:124-126`), `routes/e2b.ts:905-926` (`.all("/sandbox/*", proxyEnvd)` registered **before** `sandboxApi`'s own `.use("*", edgeRateLimit)` mount, so nothing bounds it; the proxy issues an external fetch to `https://sandbox.e2b.app/<path>` before envd's per-sandbox token check), `index.ts:280-287` (`/quests/catalog` — unthrottled Enter hop), `model-status.ts:149-176` (`/models/stats` — one KV read per request) — upstream main @ `282ac54aeb` (2026-11-18)
- **Fix branch:** `solution90-models-status-e2b-sandbox-edge-limiter` — fork PR [#110](https://github.com/NamanSoni78/pollinationsai/pull/110)
- **Dedup:** issue 68 / `solution57-edge-rate-limit-coverage` (PR #80) covers `/v1/messages`, `/internal/generation/:id` and the two OpenAPI routes only — full diff re-verified; round 25's worklog explicitly recorded these instances as "new instances of the filed issue-68 class whose pending fix branch covers only openapi.json/messages/handoff". No concurrent round 26-28 branch touches them.

## Root cause

Hono applies a sub-app's `.use("*", …)` only to requests that reach it; the mounts above sit before `proxyRoutes` (whose catch-all `edgeRateLimit` at `routes/proxy.ts:459` is the platform's flood bound) and define no limiter of their own:

1. **`/models/status`** — Cloudflare's cache key is the full URL including query string, so every distinct `minutes`×`traffic` combination is a distinct edge-cache entry: sweeping the 20,160 bounded combos executes a fresh `model_route_health` pipe query per combo (the file's own comment: *"Tinybird runs the query on every call … instead of each paying for a 24-hour scan"*), repeatable every 60 s as TTLs expire, unauthenticated, from one IP.
2. **`/alpha/e2b/sandbox/*`** — the `.all` registration precedes the `sandboxApi` mount, so its limiter never wraps `/sandbox/*`; every request with `e2b-sandbox-id`/`e2b-sandbox-port` headers performs an external fetch to the sandbox host before envd rejects the caller — unauthenticated external-fetch fan-out at unlimited rate (proven by the existing azure-sandboxes test that proxies an unauthenticated request to `https://sandbox.e2b.app/files?path=/x`).
3. **`/quests/catalog`** — each request is one gen invocation + Enter service-binding hop (enter's own 600/10 s limiter bounds it; the gap is the `/account/*` defense-before-hop pattern documented at `index.ts:267-269`).
4. **`/models/stats`** — one KV `get` per request at unlimited rate (KV-read cost amplification).

## Fix

Mount the shared per-IP `edgeRateLimit` on all four, mirroring the in-repo pattern `jobs.ts:56` and the `/account` mount. No legitimate-traffic impact: production buckets are 600/10 s per key and 1000/10 s per IP (wrangler.toml; the documented Oct 20–27 busiest legitimate IP was 472 per 10 s) — a health dashboard polling once a minute is unaffected.

## Safe reproduction (isolated, red on unpatched main)

`test/rate-limit-edge-residual.test.ts` — 4 tests, each asserting 429 with `Retry-After: 10` **and** that the expensive side effect never ran: a Tinybird fetch spy (pre-fix: the existing green tests at `index.test.ts:1048-1077` prove one pipe query per request), a KV `get` spy, the azure-sandboxes external-fetch shape, and an `ENTER.fetch` counting spy. All 4 fail on unpatched main (the side effects run); all pass on the fix branch.

## Verification

- New suite 4/4 red→green; `index`/`rate-limit-edge` suites 96/96 green; `tsc --noEmit` clean
- No live probes; $0 spend
- `/alpha/e2b/pricing` was audited and left unthrottled deliberately: its response is built entirely from in-memory constants (`callerRates` is a table lookup, `SANDBOX_TEMPLATES` a const) — zero per-request I/O, below gate (class-parity only).

## Residuals for the next round

- None named on these surfaces; the pre-limiter mount enumeration (all 19 mount groups at HEAD) is recorded in the session's subagent report — every other group is either static, KV/isolate-cached cheap, or already carries its own limiter.

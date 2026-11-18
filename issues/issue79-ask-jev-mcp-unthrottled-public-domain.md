# Issue 79 — ask-jev-mcp's public custom domain has no per-IP rate limit and no body-size guard (cross-tenant shared-bucket starvation + unbounded probe parse)

- **Severity:** Medium-High (availability — unthrottled unauthenticated traffic from a public platform domain into the shared Workers-egress bucket that all MCP-app and managed-agent tool calls share; per-request D1 auth-read amplification; unbounded request-body parse up to the Workers platform's 100 MB limit)
- **Affected:** `apps/ask-jev-mcp/worker.js` (fetch handler takes no `env`, no per-IP check, `request.clone().json()` batch probe at `:102-110`) with `apps/ask-jev-mcp/wrangler.jsonc` (custom domain `ask-jev-mcp.pollinations.ai`, no `ratelimits`) and `apps/ask-jev-mcp/deploy.json` — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution73-ask-jev-mcp-ip-rate-limit` — **PR:** [#93](https://github.com/NamanSoni78/pollinationsai/pull/93)

## Root cause

The sibling `apps/mcp` worker documents the exact threat in its own source and caps it:

> `apps/mcp/worker.js:54-65` — "Tool calls carry the caller's key to Gen, and so to Enter's D1, from Cloudflare's shared Workers IP, so cap each client IP here."

> `apps/mcp/wrangler.jsonc:22-28` — `IP_RATE_LIMITER`, namespace 1007, 200 req/10 s per client IP, added by upstream `6451bfd5e2` ("cap mcp clients per ip before tool calls reach gen") after the Oct 20–27 floods cited in `gen.pollinations.ai/wrangler.toml:217` ("shared Workers egress IP 209 per 10 s in one colo") and `shared/auth/api-key.ts:225-227` ("a write per request was most of D1's load during the 2026-10-27 floods").

`apps/ask-jev-mcp/worker.js` — which publishes its own custom domain `ask-jev-mcp.pollinations.ai` and forwards every tool call to `POST gen.pollinations.ai/alpha/decisions` with the caller's bearer (`packages/mcp/src/utils/coreUtils.js:89-95`) — has none of it: `async fetch(request)` takes no `env`, any non-empty bearer string passes (`:99-100`), and the batch-rejection probe `request.clone().json()` JSON-parses the entire attacker-controlled body (Cloudflare allows 100 MB Free/Pro request bodies).

Impact, honestly bounded (correcting the round-18 near-miss headline — there are **no unauthenticated D1 writes**: `auth()` 401s before any write path):

1. **Cross-tenant availability:** an attacker's IP is never capped at the ask-jev domain, so their junk-key tool calls land in gen's **shared Workers-egress IP bucket** (1000/10 s per colo — 5× looser than the sibling's per-client 200/10 s, multiplied by reachable colos), starving that bucket for every other MCP-app and managed-agent user (429 + Retry-After). The sibling's own limiter cannot stop this — the attack rides ask-jev's domain. The gen-fronted `/mcp/:serverId` gateway path is protected separately (`routes/mcp.ts:169-183`), so the direct custom domain is the sole unauthenticated surface.
2. **D1 read amplification at up to the bucket rate** on a database that is single-threaded per database and returns "overloaded" when its queue fills: one indexed `api_key → user → byop` JOIN read per request (`shared/auth/api-key.ts:259`), with the 300 s negative key-cache defeated by rotating made-up keys.
3. **Unthrottled app-worker cost:** unlimited request rate + full JSON.parse of up to 100–200 MB bodies per invocation (CPU billed to the account).

## Safe reproduction (non-destructive)

**Red on unpatched main** (`apps/ask-jev-mcp`, `npm test`):

- `caps each client IP before the bearer check` FAILS — the worker ignores `env`/`cf-connecting-ip` entirely; three POSTs without a bearer return `[401, 401, 401]` instead of `[401, 401, 429]` (the sibling's `worker.test.js:84-111` harness, mirrored against a mock `IP_RATE_LIMITER` counting per key).
- `rejects oversized bodies before parsing them` FAILS — a 1 MiB+ JSON object body is forwarded into the MCP handler instead of being refused 413 before parsing.

No load was generated against production (that is the destructive prong this program never exercises); the impact bounds are architecture-derived from the in-repo rate-limit configuration and the sibling's own incident comments.

## Fix (`solution73-ask-jev-mcp-ip-rate-limit`)

- Replicates the sibling's limiter verbatim before the bearer check: `cf-connecting-ip` → `env.IP_RATE_LIMITER.limit({ key: ip })`, 429 + `Retry-After: 10` — declared in `wrangler.jsonc` (namespace 1007, 200/10 s) for both the production custom domain and the public staging `workers.dev` URL.
- The batch probe reads the cloned body once under a 1 MiB cap (streaming counter; the teed clone's `cancel()` is fired without awaiting — it never settles alone) and 413s anything larger before parsing.

## Verification

Both new tests red on unpatched main, green with the fix; suite 12/12; the sibling `pollinations-mcp` suite 10/10 untouched; `wrangler deploy --dry-run` validates the binding (`env.IP_RATE_LIMITER (200 requests/10s)`).

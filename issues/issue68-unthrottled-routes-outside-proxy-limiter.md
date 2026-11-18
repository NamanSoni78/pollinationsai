# Issue 68 — Routes mounted outside `proxyRoutes` bypass the edge rate limiter: unauthenticated 32 MiB parses on `/v1/messages`, unthrottled DO RPCs on `/internal/generation`, and per-request ENTER/media fan-out on the OpenAPI routes

- **Severity:** Medium-High (availability of the main gen worker and the ENTER control plane)
- **Affected:** `gen.pollinations.ai/src/index.ts:248-249` (`GENERATION_HANDOFF_PATH` mounted with no middleware), `:308-311` (`/openapi.json`), `:315-321` (`createMessagesRoutes` mounted **before** `proxyRoutes`, whose `.use("*", edgeRateLimit)` at `routes/proxy.ts:459` therefore never runs for it); `routes/messages.ts` (no limiter of its own: `textBodyLimit` + recursive zod `validator` + translate + `JSON.stringify` + in-process dispatch); `routes/docs.ts:1226-1233` + `:825-853` (per-request `fetchEnterSchema` service-binding fetch and `fetchMediaSchema` external fetch; only the gen half is cached via `generationSchemaPromise`) — upstream `pollinations/pollinations` main @ `52fd0a6c82` (2026-11-18)
- **Fix branch:** `solution57-edge-rate-limit-coverage` — **PR:** [#80](https://github.com/NamanSoni78/pollinationsai/pull/80)
- **Relationships:** the platform's own threat model for the limiter is documented in-repo (`index.ts:267-269`: "one IP rotating made-up keys cannot turn into one D1 lookup per request"; `shared/rate-limit.ts`'s "public routes … cannot be flooded into D1"). `jobs.ts:56` (`.use("/v1/jobs/*", edgeRateLimit)`) is the in-repo pattern for exactly this class of gap. Not covered by any filed issue.

## Root cause

Hono applies a sub-app's `.use("*", …)` only to requests that reach it. Three route groups are registered on the root app ahead of, or outside, `proxyRoutes`:

1. **`/v1/messages`** (Anthropic-compat): mounted at `index.ts:315-320` before `proxyRoutes` at `:321`, so the catch-all limiter never runs for it, and `createMessagesRoutes` defines none. The outer route reads, parses, recursively zod-validates (`unknownBlockType` walks the whole tree), translates and re-serializes up to **32 MiB per request** (the inner dispatched `/v1/chat/completions` request does pass the limiter — *after* the expensive work). **Live probe:** one unauthenticated request with a 5 MiB body gets the full parse+validate pass (`400 max_tokens: expected number` in 0.14 s) — repeatable at unlimited rate; the per-IP/per-key buckets bound only the inner dispatch, never the outer parse.
2. **`/internal/generation/:id`** (coordinator handoff): the nonce check lives **inside** the DO (`takeHandoff`), so every request with any 64-hex id performs a Durable Object stub call — and an on-demand DO instantiation — before it can be refused (`execute-generation.ts:189-220`). No limiter; unauthenticated churn inside the `GENERATION_COORDINATOR` namespace (alarm latency for real jobs) plus DO request/duration billing.
3. **`/openapi.json` + `/docs/open-api/generate-schema`**: `buildMergedOpenApiSpec` re-fetches the ENTER schema (service binding; enter regenerates its whole spec per call) and the media schema (external fetch) on **every** request — only the gen half is cached. One cheap unauthenticated request amplifies into three worker invocations, two of them CPU-heavy, one landing on the auth/billing control plane.

## Fix

- `.use("*", edgeRateLimit)` on the messages routes (mirroring `jobs.ts`) and on the handoff routes (internal calls arrive without a client IP and are not limited — verified in `rate-limit-edge.test.ts`'s enter-limiter suite);
- the same limiter on both OpenAPI routes, plus a 5-minute TTL cache for the enter/media halves in production only (dev/test/staging keep fresh fetches so schema changes and per-test service bindings are seen; a failed refresh doesn't pin a rejected promise).

## Tests

4 new tests: limiter-first 429 on `/v1/messages` with an invalid-JSON body (pre-fix: 400 from the body validator — proving the 32 MiB parse ran), 429 on `/internal/generation/:id` (pre-fix: 404 after the DO RPC), 429 on `/openapi.json`, and a single enter+media fan-out per TTL window across two `buildMergedOpenApiSpec` calls. `docs`/`openapi-json`/`rate-limit-edge` suites **41/41** green, `tsc --noEmit` clean. All pre-existing docs/openapi tests pass unchanged.

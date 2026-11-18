# Issue: unbounded JSON-RPC request-body buffering in the standalone MCP workers (public umbrella isolate OOM)

**Severity:** High (availability / shared-isolate memory amplification on a public platform domain, reachable with a garbage bearer token)
**Status:** Confirmed by red→green isolated tests against unpatched `282ac54aeb` (2026-11-18)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/97 (branch `solution86-mcp-worker-body-caps`; upstream PR creation 403-blocked by the fork token's `pull_requests:read` scope — the standing limitation every round re-verifies)

## Summary

Every standalone MCP worker reads the **entire** JSON-RPC request body into isolate memory before the MCP handler runs, as part of the JSON-RPC batch pre-check:

```js
// apps/mcp/worker.js:70-78 (upstream main 282ac54aeb) — identical pattern in
// apps/machines-mcp/worker.js:398, apps/exa-mcp/worker.js:206 (inside createWorker),
// apps/ffmpeg-mcp/worker.js:307; apps/composio-mcp/worker.js:386 reads the same
// clone for its proxy payload.
if (
    request.method === "POST" &&
    Array.isArray(
        await request
            .clone()      // tees the whole body for the handler branch
            .json()       // buffers + UTF-decodes + JSON.parses the clone branch
            .catch(() => null),
    )
) { /* "Batch requests are not supported." */ }
```

No content-length check, byte cap, or `bodyLimit` exists anywhere on these paths (grepped every worker: zero 413/body-limit on request bodies). Cloudflare accepts request bodies far larger than the 128 MiB Workers isolate, so a single oversized POST — the SDK handler then re-reads the original tee branch, so peak allocations are a multiple of the body — kills the isolate and **every concurrent request co-hosted on it**. Same accepted class as issues 12 (media upload OOM), 65 (b64 video OOM), 75 (community edit fan-out) and 84 (Scribe queue).

**Surfaces (this issue):**

| Worker | Exposure | Gate before the read |
|---|---|---|
| `apps/mcp` (umbrella: text/image/audio/embeddings/3D/account tools) | **Public custom domains `mcp.pollinations.ai` + `mcp.myceli.ai`** (`apps/mcp/wrangler.jsonc`) | bearer-token **presence only** (`readBearerToken`, worker.js:67-68) — any non-empty string passes; the key is only validated downstream when a tool call forwards it to gen. IP limit 200 req/10 s (= 20 req/s per IP, unlimited IPs) |
| `apps/machines-mcp`, `apps/exa-mcp`, `apps/ffmpeg-mcp`, `apps/composio-mcp` | gen-fronted via service bindings (`workers_dev: false`, no routes) — reachable through gen's `/mcp/:serverId`, which is itself uncapped on main | ffmpeg/exa: none before the batch check; machines: bearer presence; composio: `requireUserId` |

**Already covered elsewhere (not this issue):** `apps/ask-jev-mcp`'s public domain — issue 79 / fork PR #93 added the per-IP limiter and a 1 MiB probe cap; the gen `/mcp/:serverId` gateway route — the concurrent session's `solution85-mcp-gateway-body-cap` branch (4 MiB cap, issue report pending there). This fix deliberately touches neither file.

## Root cause

The pre-check needs only "is the top-level JSON an array", but it materializes the whole body: `clone()` tees the stream (the handler branch's bytes are retained while the clone branch reads ahead), `.json()` decodes the full UTF-8 string and parses it, and the MCP SDK handler then re-reads the original branch (another string + parse). A ~40-90 MB body exceeds the 128 MiB isolate deterministically; the platform's own caps elsewhere (32 MiB gen text, 20 MiB media, issue 56's multipart gate) exist precisely because no WAF body limit can be assumed.

## PoC (isolated, red on unpatched main)

`apps/mcp/worker.test.js` (house `node:test` harness posting real `Request`s to `worker.fetch`):

1. **"rejects request bodies over the 8 MiB cap before parsing them"** — a 9 MiB fixed-length body (undici sets Content-Length): unpatched main returns **406** (the SDK's parse-error response *after* fully reading and parsing the body); the fix returns **413** from the content-length precheck without reading a byte.
2. **"bounds streamed bodies instead of buffering them whole"** — a chunked body of 64 KiB enqueues that errors the stream at 32 MiB: unpatched main drains the **whole 32 MiB** through the tee before returning 400; the fix stops near the cap and returns 413, with the test asserting `pushed <= 12 MiB` (the worker stopped pulling).

`apps/ffmpeg-mcp/worker.test.js`: the same oversize body → **413 before any container interaction** (`calls.run.length === 0`); unpatched main 400-after-read.

Access on the umbrella: `Authorization: Bearer x` (any string) — no account, no pollen, no valid key needed.

## Impact

- Deterministic isolate-memory exhaustion on a **public platform domain** with a garbage bearer token, at 20 req/s per IP from arbitrarily many IPs (`apps/mcp` rate limit), killing co-hosted unrelated requests per colo.
- The four gen-fronted workers are reachable through gen's gateway, which on main is itself uncapped (solution85 pending merge); their own caps close the direct service-binding path and add defense-in-depth for any future direct exposure.

## Fix (`solution86-mcp-worker-body-caps`)

- New `shared/mcp-request.ts`: `MCP_REQUEST_LIMIT_BYTES = 8 MiB`, `McpRequestTooLargeError`, and `readMcpRequestJson(request)` — clones, reads through the existing bounded reader (`readResponseText`: content-length precheck, then a counted stream read), `JSON.parse`, `null` on parse failure (mirroring the old `.catch(() => null)`). The 8 MiB size keeps the umbrella's largest documented tool payload working: `deploySite` at "up to 5 MB per request" (`packages/mcp/src/services/accountService.js`).
- `shared/response-bytes.ts`: parameter type widened to `BoundedBodySource` (any body-bearing request or response) so a `Request` clone is accepted; existing callers unaffected.
- `apps/mcp`, `apps/machines-mcp`, `apps/exa-mcp`, `apps/ffmpeg-mcp`: the batch pre-check now uses the bounded read; over-cap → 413 `invalid_request`; batch → 400 unchanged.
- `apps/composio-mcp`: the proxy payload read uses the bounded reader; over-cap → 413 through the existing catch (same `invalid_request` shape).

## Verification

- Red on unpatched main / green with the fix for all three new tests (statuses 406/400 → 413; 32 MiB drained → ≤ 12 MiB pulled).
- Suites: `apps/mcp` 12/12 (10 pre-existing + 2 new), `apps/ffmpeg-mcp` 15/15 (14 + 1), `apps/ask-jev-mcp` 10/10, `apps/machines-mcp` 8/8, `apps/exa-mcp` 4/4, `apps/composio-mcp` 8/8.
- `npm run typecheck --workspace pollinations-gen` clean (covers `@shared/*`); `biome check` clean on all changed files; `wrangler deploy --dry-run` bundles the new `shared/mcp-request.ts` import.

## Companion notes

- **Coordination:** ask-jev (issue 79 / PR #93) and the gen gateway (`solution85-mcp-gateway-body-cap`) are separate deliveries; this branch does not touch `apps/ask-jev-mcp/worker.js` or `gen.pollinations.ai/src/routes/mcp.ts` to avoid duplication and merge conflicts.
- **Review note for solution85:** the gen gateway's 4 MiB cap will 413 the umbrella's documented 5 MB `deploySite` payloads when they route through `gen.pollinations.ai/mcp/pollinations`; this round's worker cap is 8 MiB for that reason. Consider aligning the gateway to 8 MiB or documenting the tighter limit on `deploySite`.

## Safe reproduction

Fully offline (the three tests above; no load was generated against production). No live probes this round; the bounty key's balance was untouched.

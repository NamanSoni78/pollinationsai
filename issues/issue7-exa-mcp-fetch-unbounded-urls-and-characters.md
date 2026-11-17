# Issue: `web_fetch_exa` MCP tool accepts unbounded `urls` array and `maxCharacters` — platform-cost amplification and Worker memory exhaustion

**Severity:** Medium-High
**Status:** Confirmed by live test (2026-11-17)
**Fix:** PR from `solution7-exa-mcp-fetch-caps`

## Summary

The `web_search_exa` tool got a `numResults` cap during the earlier amplification fix, but its sibling `web_fetch_exa` still accepts an unbounded `urls` array and an unbounded `maxCharacters` value. A single authenticated MCP call can bill hundreds of Exa pages to the platform's `EXA_API_KEY` and buffer a response large enough to kill the Worker isolate that serves other users' requests.

## Root cause

`apps/exa-mcp/worker.js` (at commit `0cf0ad1`), `web_fetch_exa` input schema:

```js
inputSchema: z.object({
    urls: z.array(z.url()).min(1),          // no max
    maxCharacters: z.number().int().positive().optional(),   // no max
}),
```

The whole MCP response is also buffered before usage headers attach (`worker.js:232-234`: `const body = await response.arrayBuffer()`), and `formatFetchedPages` concatenates every page's full text before `JSON.stringify`.

Impact chain:

1. Each URL is billed at the per-page rate (`exa.contents.text.v1`, `EXA_CONTENTS_PRICE_PER_PAGE = 0.001`) — `params.urls.length` is the attacker-chosen unit count in `runWithUsage`.
2. `maxCharacters` is forwarded to Exa verbatim (`params.maxCharacters ?? 3000`), so the caller picks the response size per page.
3. Gen's MCP preflight (`gen.pollinations.ai/src/routes/mcp.ts:210-215`) only runs `requireAccountFunds(c, 0)` for `usage_receipt` servers — it requires a *nonzero* balance, not one that covers the receipt. The caller's deduction clamps at whatever they have (`handleBalanceDeduction`), and the Exa bill lands on the platform's key.

## PoC (executed 2026-11-17, cost 0.025 pollen on my own key)

```bash
# 1. initialize an MCP session
curl -sS -D headers.txt -X POST https://gen.pollinations.ai/mcp/exa \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"poc","version":"1.0"}}}'

# 2. call web_fetch_exa with 25 URLs and 100k characters per page — accepted
SID=$(grep -i mcp-session-id headers.txt | awk '{print $2}' | tr -d '\r')
curl -sS -X POST https://gen.pollinations.ai/mcp/exa \
  -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"web_fetch_exa","arguments":{"urls":["https://example.com/?i=0", ... 25 total ...],"maxCharacters":100000}}}'
# → HTTP 200, all 25 pages fetched and returned

# 3. balance check before/after:
#   before: 1.99999171
#   after:  1.97499171   (Δ = 0.025 = 25 × 0.001 — exactly the 25 per-page charges)
```

Nothing rejects `urls.length = 25` (would be 10 under the proposed cap), `maxCharacters = 100000` (33× the default), or anything larger. Scaling the same call to thousands of URLs / tens of millions of characters is only bounded by Exa's own tolerance and the isolate's 128 MB.

## Why this must be fixed

- Every amplified unit is real money: the platform pays Exa, the caller's balance only covers what it had. A key with 0.01 pollen can extract dozens of dollars of Exa spend per call.
- The buffered response (25 pages × 100k chars already ≈ 2.5 MB of JSON text in this PoC; unbounded in general) risks `EXCEEDS_LIMITS`/isolate kills that fail co-located requests — a denial-of-service lever any authenticated key holder holds.
- The fix pattern is already established in this repo: `web_search_exa` capped `numResults` at 10 with a mirrored test assertion (`worker.test.js:81`). This PR completes it for the fetch tool.

## Fix

`apps/exa-mcp/worker.js`:

```js
inputSchema: z.object({
    urls: z.array(z.url()).min(1).max(10),
    maxCharacters: z.number().int().positive().max(50_000).optional(),
}),
```

plus `worker.test.js` assertions that `urls.maxItems === 10` and `maxCharacters.maximum === 50_000`, mirroring the existing `numResults` test. Tests: 4/4 pass (`node --test worker.test.js`).

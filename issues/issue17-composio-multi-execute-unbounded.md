# Issue 17 — composio-mcp `COMPOSIO_MULTI_EXECUTE_TOOL` bills and executes an unbounded `tools[]` array per call

- **Severity:** High (unbounded platform-key spend + unbounded action execution per single request)
- **Affected:** `apps/composio-mcp/worker.js` (thin proxy) + `gen.pollinations.ai/src/routes/mcp.ts` pre-flight — upstream `pollinations/pollinations` main @ `549feee`
- **Fix branch:** `solution17-composio-multi-execute-caps` — **PR:** [#21](https://github.com/NamanSoni78/pollinationsai/pull/21)

## Root cause

`routerUsage()` derives billed units directly from the caller-supplied array with no bound anywhere in the worker (`apps/composio-mcp/worker.js:226-247`):

```js
const tools = payload.params.arguments?.tools;
const billable =
    payload.params.name === "COMPOSIO_MULTI_EXECUTE_TOOL" &&
    status >= 200 && status < 300;
const units = billable
    ? Array.isArray(tools) ? Math.max(1, tools.length) : 1
    : 0;
return { cost: units * COMPOSIO_TOOL_CALL_PRICE, ..., adjustmentUnits: units };
```

`proxyRouter()` forwards the JSON-RPC body **verbatim** to the caller's Composio router session (every action executes under the platform `COMPOSIO_API_KEY`, `worker.js:272-291`), while the gateway pre-flight only proves *any* positive balance — `gen.pollinations.ai/src/routes/mcp.ts:214` runs `requireAccountFunds(c, 0)` and line 109 settles with `apiKeyReservedAmount: 0` ("reconcile the final receipt directly instead of inventing a maximum-cost preflight"). So one HTTP request carrying a `tools` array of arbitrary length executes N actions and bills N units (`COMPOSIO_TOOL_CALL_PRICE` = 0.0002 pollen each, `shared/registry/mcp.ts:77`) after the fact — an overdraft the caller may never be able to cover, all executed against the platform's Composio account.

This is the same amplification class the exa-mcp caps closed for `web_fetch_exa` (issue 7), in a different app and a different tool — there the cap landed in the tool's zod schema; the composio worker is a **thin proxy with no local input schema**, so nothing bounded this array.

## Safe reproduction (isolated, no network)

Extend the existing `apps/composio-mcp/worker.test.js` harness (injectable `fetchImpl`, no live calls): a `tools/call` for `COMPOSIO_MULTI_EXECUTE_TOOL` with `tools: Array(26)` is proxied verbatim on unpatched main and billed `26` units (`x-pollinations-mcp-adjustment-units: 26`); scaling the array to thousands bills thousands of units in a single request. The pre-flight it passed needed only a non-zero balance.

## Fix (`solution17-composio-multi-execute-caps`)

`assertMultiExecuteBounds(payload)` rejects a `tools/call` batch above `MAX_MULTI_EXECUTE_TOOLS` (**25**) with HTTP 400 before the Composio session is even loaded or the body proxied — mirroring the exa-mcp house pattern. Billed units therefore stay bounded by the same cap that bounds executions.

## Verification

`node --test worker.test.js` in `apps/composio-mcp`: **10/10** (8 existing + 2 new — an oversized batch is rejected pre-proxy with zero billed units and zero upstream calls; a batch at the cap is proxied and bills exactly `min(len, cap)` units).

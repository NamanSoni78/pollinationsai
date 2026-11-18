# Issue 58 — `composio-mcp` settles every non-`MULTI_EXECUTE` tool call at zero under the platform's Composio key (`REMOTE_BASH`, `REMOTE_WORKBENCH`, per-app tools)

- **Severity:** High (free remote-execution environment for any authenticated caller — even at zero balance — at the platform's Composio expense, unbounded in request count; the platform's own shipped tests pin the zero-cost passthrough)
- **Affected:** `apps/composio-mcp/worker.js` (`routerUsage`, `proxyRouter`, `createSession` — router sessions created with no `toolkits` filter), settling through `gen.pollinations.ai/src/routes/mcp.ts:210-236` — upstream `pollinations/pollinations` main @ `52fd0a6c824`
- **Fix branch:** `solution56-composio-tool-call-allowlist` — **PR:** [#67](https://github.com/NamanSoni78/pollinationsai/pull/67)

## Root cause

The usage receipt is derived from a hard-coded, **client-declared tool name** rather than from execution evidence:

```js
// apps/composio-mcp/worker.js:230-234 (unpatched)
const billable =
    payload.params.name === "COMPOSIO_MULTI_EXECUTE_TOOL" &&
    status >= 200 && status < 300;
```

Every other `tools/call` name is still proxied **verbatim** to the caller's Composio tool-router session (`fetchImpl(session.mcp.url, { …, body: request.body })`) with the platform `x-api-key` (`worker.js:273`), and settles `cost: 0, adjustmentUnits: 0`. The gen route charges exactly the receipt (`mcp.ts:222-236`, `isBilledUsage: usage.cost > 0` → false) and its only preflight is `requireAccountFunds(c, 0)` (`mcp.ts:210-215`) — a spendable-balance check that a zero-balance key passes. Router sessions are created with **no `toolkits` filter** (`createSession(userId, [], …)` → no `toolkits` key in the config), so the hosted router exposes whatever the platform's Composio account answers with.

The hosted tool router answers more than the four platform tools. Live `tools/list` (production, own key, read-only) returns six:

```
COMPOSIO_GET_TOOL_SCHEMAS, COMPOSIO_MANAGE_CONNECTIONS,
COMPOSIO_MULTI_EXECUTE_TOOL, COMPOSIO_REMOTE_BASH_TOOL,
COMPOSIO_REMOTE_WORKBENCH, COMPOSIO_SEARCH_TOOLS
```

`COMPOSIO_REMOTE_BASH_TOOL` and `COMPOSIO_REMOTE_WORKBENCH` are execution tools outside the platform's intended surface, and per-app tools (e.g. `GITHUB_CREATE_AN_ISSUE`) appear whenever a connected app exists on the account — all reachable at `gen.pollinations.ai/mcp/composio` at zero pollen per call, bounded only by edge rate limits.

## Safe reproduction (live, non-destructive, own key)

One harmless probe with the bounty test key — no state created, nothing deleted, one sandbox `echo`:

```jsonc
// POST https://gen.pollinations.ai/mcp/composio  (after initialize + tools/list)
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
  "name":"COMPOSIO_REMOTE_BASH_TOOL",
  "arguments":{"command":"echo pollinations-audit-probe"}}}
```

Response: HTTP **200**, body `"successful":true,"data":{"stdout":"pollinations-audit-probe\n", …,"sandbox_id_suffix":"8s9q"}`, and **no `x-pollinations-*` cost/receipt headers at all** — a real remote-shell execution under the platform key, settled at zero. (`tools/list` and `initialize` are unbilled metadata operations; the key's balance was unaffected.)

Red on unpatched `main` (harness, `node --test apps/composio-mcp/worker.test.js`): the four new `refuses to proxy …` tests fail — `COMPOSIO_REMOTE_BASH_TOOL` and `COMPOSIO_REMOTE_WORKBENCH` (and arbitrary names) are proxied to the hosted router and answered 200 at cost 0; the shipped suite already asserted zero-cost passthrough for non-billable names, i.e. it pinned the vulnerable behavior as intended.

## Fix (`solution56-composio-tool-call-allowlist`)

`tools/call` names are checked against the platform's four tools (`MULTI_EXECUTE_TOOL`, `SEARCH_TOOLS`, `GET_TOOL_SCHEMAS`, `MANAGE_CONNECTIONS`) and refused with 400 `"Unknown Composio tool"` **before** session load or proxying — the exa/ffmpeg house pattern (refuse at the worker; never settle unseen executions at zero). The three free meta tools keep their zero-cost passthrough (their shipped tests are unchanged), `MULTI_EXECUTE` keeps its per-tool billing. If upstream wants to expose `REMOTE_BASH`/`REMOTE_WORKBENCH` deliberately, they need explicit rates and a product decision — this keeps them off until then.

## Verification

`node --test --experimental-strip-types apps/composio-mcp/worker.test.js` — **12/12** (8 shipped + 4 new: REMOTE_BASH / REMOTE_WORKBENCH / an app-tool name / a case-variant spoof all 400 before any outbound call, with `calls.length === 0`, status/cost/units receipt headers pinned). `npx biome check` clean. Gen-side MCP route untouched (it already settles exactly the receipt). Live probes were limited to `initialize`, `tools/list` and the single `echo` execution above; no connections were created, no destructive tools called, production balance unchanged.

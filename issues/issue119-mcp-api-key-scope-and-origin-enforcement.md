# Issue 119 — /mcp/:serverId omits API key origin (BYOP) and model-restriction checks, exposing victim Composio integrations, personal computer sandbox, and unrestricted Pollen spend

- **Severity:** High (privilege escalation & billing bypass: any third-party website holding an ordinary BYOP key with zero account scopes can invoke `/mcp/composio` to act on the victim's Gmail/GitHub/Google Sheets/Slack and `/mcp/computer` to run arbitrary code in the victim's personal Durable Object and push GitHub-attributed commits; any model-restricted API key — including `allowedModels: []` — can call `composio`, `computer`, `exa`, and `ffmpeg` and drain Pollen balance)
- **Affected:** `gen.pollinations.ai/src/routes/mcp.ts:183-238` (direct API key authorization gate on `POST /mcp/:serverId`).
- **Fix branch:** `solution119-mcp-api-key-scope-and-origin-enforcement` (off `upstream/main` `8fc4c21`) — fork PR [#134](https://github.com/NamanSoni78/pollinationsai/pull/134)
- **Dedup:** not a duplicate of issues 1–117 (issues 1–117 do not cover `redirectOrigin` / `canGrantKeysByLink` or `permissions.models` enforcement on `gen.pollinations.ai/src/routes/mcp.ts`; note `pk_` publishable keys are already rejected upstream in `shared/auth/api-key.ts:442`).

## Root cause
`POST /mcp/:serverId` requires `auth({ allowApiKey: true, allowSessionCookie: true })` and `balanceCheck`, then proxies directly to the target MCP server without inspecting `apiKey.metadata?.redirectOrigin` or `apiKey.permissions?.models`:
1. **BYOP origin bypass on user-scoped MCP servers (`composio`, `computer`):** `enter.pollinations.ai` restricts `/api/account/integrations` (Composio) behind `account:keys` and enforces `canGrantKeysByLink(redirectOrigin)` so third-party websites requesting BYOP keys cannot mint `account:keys` grants. However, `gen.pollinations.ai/src/routes/mcp.ts` accepts *any* secret API key regardless of `redirectOrigin` — allowing any third-party BYOP app to bypass `account:keys`, invoke `/mcp/composio` against the victim's connected third-party OAuth accounts, and execute arbitrary commands in the victim's personal `/mcp/computer` DO.
2. **Model-restriction bypass on user-scoped and receipt-billed MCP servers (`composio`, `computer`, `exa`, `ffmpeg`):** Keys explicitly scoped via `apiKey.permissions?.models` (e.g., `allowedModels: ["openai-fast"]` or `allowedModels: []`) are blocked on generation routes, but `/mcp/:serverId` never checks `permissions.models`, allowing model-restricted keys to call paid `usage_receipt` MCP tools (`exa`, `ffmpeg`) and drain the owner's Pollen balance, or access user-scoped tools (`composio`, `computer`).

## Safe repro (isolated, red on `upstream/main` `8fc4c21`)
Added 7 Miniflare/workerd tests in `gen.pollinations.ai/test/mcp-proxy.test.ts` covering:
- Third-party BYOP key (`redirectOrigin: "https://third-party.example"`) blocked on `/mcp/composio` and `/mcp/computer` (403), still allowed on public stateless `/mcp/exa`.
- Model-restricted keys (`permissions: { models: ["openai-fast"] }` and `models: []`) blocked on `/mcp/composio`, `/mcp/computer`, `/mcp/exa`, and `/mcp/ffmpeg` (403).
- Dashboard sessions (`sess_`), unrestricted personal/CLI keys (no `redirectOrigin`), loopback/localhost keys, and `ag_` agent run tokens unaffected.
- **RED on `8fc4c21`:** 6/7 new tests failed (returned `200` instead of `403`).
- Deterministic offline — live probes **$0**.

## Fix
In `gen.pollinations.ai/src/routes/mcp.ts`, for direct API key requests (`apiKey && !c.var.auth.agentRun`):
- If `server.userScoped && !canGrantKeysByLink(apiKey.metadata?.redirectOrigin)`, throw `HTTPException(403)` blocking third-party BYOP keys from accessing personal MCP servers.
- If `(server.userScoped || server.billing === "usage_receipt") && apiKey.permissions?.models !== undefined`, throw `HTTPException(403)` blocking model-restricted keys from invoking personal or receipt-billed MCP tools.

## Tests
- 7 new regression tests in `gen.pollinations.ai/test/mcp-proxy.test.ts` (**RED 6/7 fail on `8fc4c21`**, **GREEN 41/41** on patch).
- `npx tsc --noEmit` clean (0 errors).

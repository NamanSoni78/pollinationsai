# F-02 — Platform-key spend abuse: free remote execution, identity forgery, and unbounded spend through MCP apps and bots (Critical)

**Consolidates:** issues [#58](../issues/issue58-composio-non-surface-tool-calls-zero-billing.md) (composio REMOTE_BASH at $0), [#17](../issues/issue17-composio-multi-execute-unbounded.md) (unbounded `tools[]`), [#7](../issues/issue7-exa-mcp-fetch-unbounded-urls-and-characters.md) (unbounded exa fetch), [#6](../issues/issue6-ffmpeg-mcp-args-protocol-bypass.md) (ffmpeg `args` bypass), [#5](../issues/issue5-polli-api-tool-restrictions-schema-only.md) (polli tool restrictions schema-only), [#118](../issues/issue118-mcp-agent-github-identity-isolation.md) (agent-run GitHub identity leak), [#119](../issues/issue119-mcp-api-key-scope-and-origin-enforcement.md) (MCP API-key origin/scope bypass), [#18](../issues/issue18-discord-bots-ungated-platform-key-spend.md) (catgpt/opposite-prompt ungated spend), [#27](../issues/issue27-discord-bot-family-ungated-spend.md) (discord-bot-family ungated spend) — 9 issues, one root pattern: **third parties can spend or abuse the platform's own credentials, and in several places execute code, without paying and without the caller's consent.**

**Status: LIVE on upstream `main` @ `4e662050`** — re-verified by code inspection 2026-11-19: `apps/composio-mcp/worker.js:231-235` still bills only the client-declared name `COMPOSIO_MULTI_EXECUTE_TOOL`; `gen.pollinations.ai/src/routes/mcp.ts` still sets `MCP_USER_GITHUB_HEADER` on agent-run requests with no `!agentRun` gate and never checks `apiKey.metadata.redirectOrigin` / `apiKey.permissions.models`.

**Fix PRs:** [#67](https://github.com/NamanSoni78/pollinationsai/pull/67), [#21](https://github.com/NamanSoni78/pollinationsai/pull/21), [#10](https://github.com/NamanSoni78/pollinationsai/pull/10), [#6](https://github.com/NamanSoni78/pollinationsai/pull/6), [#5](https://github.com/NamanSoni78/pollinationsai/pull/5), [#133](https://github.com/NamanSoni78/pollinationsai/pull/133), [#134](https://github.com/NamanSoni78/pollinationsai/pull/134), [#22](https://github.com/NamanSoni78/pollinationsai/pull/22), [#31](https://github.com/NamanSoni78/pollinationsai/pull/31).

---

## What this chain can do, end to end

1. **Any authenticated caller — even with zero balance — executes commands in the platform's Composio cloud sandbox for free.** The MCP gateway preflight reserves $0 (`requireAccountFunds(c, 0)`), and the composio worker bills only calls that *declare themselves* as `COMPOSIO_MULTI_EXECUTE_TOOL`. Every other tool — including `REMOTE_BASH` and `REMOTE_WORKBENCH` — is proxied verbatim under the platform's Composio API key and settles 0 pollen. Live-proven with a harmless `echo` (below).
2. **One request amplifies N times.** `COMPOSIO_MULTI_EXECUTE_TOOL` takes an unbounded `tools[]` array — 26+ actions per call, each executing under the platform key (issue 17). The exa-mcp `web_fetch_exa` tool takes unbounded `urls`/`maxCharacters` — a key with 0.01 pollen extracted 25 pages/0.025 pollen of Exa spend in one live call (issue 7).
3. **Third-party agents forge commits as the victim, and reach the victim's SaaS.** On `/mcp/:serverId`, agent-run tokens (`ag_`) still receive the caller's real GitHub identity header — an untrusted community agent can read it and push commits attributed to the victim (issue 118, unit-proven). The same gateway ignores BYOP key origins and model restrictions — a zero-scope key from any third-party website drives the victim's Composio integrations (Gmail/GitHub/Sheets/Slack) and their personal computer sandbox (issue 119, unit-proven 6/7 red).
4. **Container file read / SSRF exfiltration via ffmpeg-mcp.** Model-supplied `args` bypass the validated-sources policy (`file:///etc/passwd` → public unlisted media URL at 0.0002 pollen/call — original live exfil; unit tests pin pre-execution rejection, issue 6).
5. **polli's official bot identity is writable by API callers.** Tool restrictions are enforced only in the LLM tool *schema*; the executor never checks, so a crafted tool-call creates/edits/deletes GitHub issues and comments as the verified `pollinations` bot (issue 5 — static analysis; fix enforces at the executor).
6. **Anyone on Discord spends the platform key by mentioning a bot.** catgpt/opposite-prompt bots answer every mention from any channel with 1 text + up to 3 paid image generations (retry-amplifiable); the 5-bot discord-bot-family fleet answers every mention/reply/DM with an ungated paid completion (issues 18/27, unit-proven).

## Proof (strongest evidence per member)

**issue 58 — live zero-cost remote shell (2026-11-18, own key):**

```
MCP tools/list -> 6 tools incl. REMOTE_BASH, REMOTE_WORKBENCH
tools/call REMOTE_BASH {"command": "echo pollinations-audit-probe"}
-> HTTP 200  {"stdout":"pollinations-audit-probe\n"}
   (no cost/receipt headers; balance unchanged)
```
Post-fix unit tests: REMOTE_BASH / REMOTE_WORKBENCH / app-tool / case-variant spoof all 400 **before** any outbound call (`calls.length === 0`) — the platform's own shipped test suite had pinned the zero-cost passthrough as intended behavior.

**issue 7 — live amplification (2026-11-17, own key):** `web_fetch_exa` with 25 URLs × 100k chars → `200`, all 25 pages; balance `1.99999171 → 1.97499171` (Δ = 0.025 = exactly 25 × 0.001/page). Nothing rejects larger values.

**issue 17 — unit, red on unpatched:** a `tools/call` with `tools: Array(26)` is proxied verbatim and billed 26 units (`x-pollinations-mcp-adjustment-units: 26`); preflight passes with only a non-zero balance. Post-fix: batch > 25 → 400 pre-proxy, zero upstream calls.

**issue 118 — unit, red on unpatched (2026-11-19 code still unfixed):** `POST /mcp/computer` with an `ag_` token → `COMPUTER_MCP` received `x-pollinations-user-github: 583231+octocat` (expected `:null`).

**issue 119 — unit, red 6/7 on unpatched:** third-party BYOP key and model-restricted keys returned `200` on composio/computer/exa/ffmpeg (expected 403).

**issue 6 — unit (16/16) + original live exfil:** five URL/path `args` variants rejected with **zero container runs**; ordinary filter args still accepted. Original tracker's live proof (`file:///etc/passwd` contents exfiltrated to a public unlisted media URL) cited as unchanged.

**issue 5 — static analysis (honestly labeled):** `apps/polli/src/ai/client.py:730` write-guard fires only for `discord_mixed_batch`; `is_http_api` requests never executor-checked. No executed PoC (the fix, merged on the fork, enforces the existing `tool_filters.py` restriction sets at the executor).

**issues 18/27 — unit, red/green:** on unpatched main any-channel mentions invoke the paid path (no channel check exists at all); post-fix out-of-channel mentions never bill, 60 s per-user cooldown, independent users.

## The chain

```
zero-balance sk_/ag_ key (or any Discord user)
        │
        ├─ /mcp/composio  REMOTE_BASH / WORKBENCH ──> free remote execution, platform key   (58, LIVE)
        │      └─ tools[] unbounded ──> N actions per request                              (17, unit)
        ├─ /mcp/exa       urls[] unbounded ──> $-extractable Exa spend at 0.01 pollen       (7, LIVE)
        ├─ /mcp/ffmpeg    args bypass ──> container file read → public URL exfiltration     (6, LIVE+unit)
        ├─ /mcp/computer  ag_ token ──> victim GitHub identity → commits forged as victim   (118, unit)
        │      └─ BYOP/restricted keys ──> victim's Gmail/Slack/sandbox, Pollen drain       (119, unit)
        ├─ polli HTTP API ──> GitHub issues/comments as the official bot                    (5, static)
        └─ Discord mention/DM ──> ungated platform-key spend across the bot fleet            (18/27, unit)
```

## Members & fixes

| Issue | One-line | Verification | Fix branch | Fork PR |
|---|---|---|---|---|
| 58 | composio-mcp settles every non-`MULTI_EXECUTE` tool at $0 under the platform key (REMOTE_BASH live) | **Live** + unit 12/12 | `solution56-composio-tool-call-allowlist` | [#67](https://github.com/NamanSoni78/pollinationsai/pull/67) |
| 17 | `COMPOSIO_MULTI_EXECUTE_TOOL` unbounded `tools[]` (N actions/req under platform key) | Unit red/green | `solution17-composio-multi-execute-caps` | [#21](https://github.com/NamanSoni78/pollinationsai/pull/21) |
| 7 | exa `web_fetch_exa` unbounded urls/maxCharacters (platform-key Exa spend) | **Live** (Δ 0.025) | `solution7-exa-mcp-fetch-caps` | [#10](https://github.com/NamanSoni78/pollinationsai/pull/10) |
| 6 | ffmpeg-mcp `args` bypasses validated-sources policy (container file read/SSRF) | Unit 16/16 + live exfil (original) | `solution6-ffmpeg-mcp-args-protocol-guard` | [#6](https://github.com/NamanSoni78/pollinationsai/pull/6) (merged on fork 2026-11-17) |
| 5 | polli API tool restrictions schema-only (bot identity writable by callers) | Static (labeled) | `solution5-polli-api-tool-enforcement` | [#5](https://github.com/NamanSoni78/pollinationsai/pull/5) (merged on fork 2026-11-17) |
| 118 | Agent-run MCP requests receive caller's GitHub identity → commits forged as victim | Unit red/green | `solution118-mcp-agent-github-identity-isolation` | [#133](https://github.com/NamanSoni78/pollinationsai/pull/133) |
| 119 | `/mcp/:serverId` ignores BYOP origin + model restrictions → victim SaaS/sandbox access | Unit red 6/7 | `solution119-mcp-api-key-scope-and-origin-enforcement` | [#134](https://github.com/NamanSoni78/pollinationsai/pull/134) |
| 18 | catgpt/opposite-prompt bots: ungated, unrate-limited platform-key spend per mention | Unit red/green | `solution18-discord-bots-channel-gate-cooldown` | [#22](https://github.com/NamanSoni78/pollinationsai/pull/22) |
| 27 | discord-bot-family fleet: every mention/reply/DM = ungated paid completion | Unit red/green | `solution23-discord-family-spend-gating` | [#31](https://github.com/NamanSoni78/pollinationsai/pull/31) |


## Merge guidance

1. **#67 + #21 first** (same worker, same surface) — they stop free remote execution and amplification under the platform key.
2. **#133 + #134 together** (same file `routes/mcp.ts`, two gates — the reports recommend co-review).
3. **#10, #6, #5** are independent app-level caps/enforcements; #6 and #5 were already merged on the fork on 2026-11-17 (fork/main was later re-synced to upstream, so review the PR diffs).
4. **#22 + #31** are the bot-fleet pair (channel gate + cooldown; per-user cooldown fleet-wide).
5. Shared precondition worth a product decision: the gateway's `requireAccountFunds(c, 0)` zero-reserve preflight (named by both 7 and 17) — reserve or receipt-settle MCP calls instead.

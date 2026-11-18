# Issue 94 — The gen MCP gateway (`/mcp/:serverId`) buffers unbounded JSON-RPC request bodies: one authenticated POST OOMs the shared generation-gateway isolate

- **Severity:** High (availability — cross-tenant isolate kill on the shared gen worker; the body-limit family of issues 56/65/67/75/76/85)
- **Affected:** `gen.pollinations.ai/src/routes/mcp.ts:186-191` — the handler's `c.req.raw.clone().json<{ method?: unknown } | null>().catch(() => null)` fully buffers whatever an authenticated caller POSTs, before forwarding the surviving copy to the server binding; the only pre-handler middlewares are `edgeRateLimit` and `auth()` — no body cap exists anywhere on the `/mcp` route family — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution85-mcp-gateway-body-cap` — fork PR [#104](https://github.com/NamanSoni78/pollinationsai/pull/104)
- **Dedup:** issue 85 (PR #97, `solution86-mcp-worker-body-caps`) capped the **standalone workers'** own reads — the public umbrella (`mcp.pollinations.ai`, garbage-bearer reachable) and machines/exa/ffmpeg/composio behind their own probes; that round's own worklog records this branch as the complementary gen-gateway side ("the gen `/mcp/:serverId` gateway cap is `solution85-mcp-gateway-body-cap`... this round's branch touches neither file") and left the review note about the 4 MiB draft vs the umbrella's documented 5 MB `deploySite` payloads — this branch was revised to **8 MiB** accordingly (matching their worker cap). Issue 79 (PR #93) is ask-jev's own worker. One route family = one finding per the registry convention.

## Root cause

The gen gateway is the one authenticated JSON surface on gen without a body limit: chat/messages carry 32/100 MiB (`textBodyLimit`, `large-chat-body`), the image JSON routes their own caps (issues 75/76), and the MCP workers got theirs in issue 85 — but `/mcp/:serverId` parses the raw body with `clone().json()`:

1. Any authenticated caller (free-tier `sk_`/`ag_`/BYOP key suffices; `requireAccountFunds(c, 0)` only demands a non-negative balance, and `initialize`/`tools/list` skip it) POSTs a JSON-RPC body of ~40-100 MB (the platform's documented per-request transport ceiling is 100 MiB — `routes/proxy.ts:742`). The natural carrier: any tool argument accepting a large string/array (the model-controlled `arguments` field — e.g. computer `bash.command`, machines `run_command.command`, ask-jev `state`).
2. `c.req.raw.clone().json()` drains one branch of the tee, leaving the full body resident in the clone's internal buffer while the JSON string and parsed object are allocated on top — peak resident ≈ 2-3x body size against the 128 MiB isolate. A ~60 MB POST deterministically OOMs (Cloudflare `error code: 1102`, the class issues 56/65/75 live-probed).
3. The gen worker isolate is shared across all tenants — every in-flight request co-located on it dies with it; the attack repeats at `edgeRateLimit` cadence (one request per window is enough).
4. Second-order: the surviving copy is forwarded to the target MCP server binding, where the worker's own batch probe re-buffers it — the same OOM lands on the per-server shared worker (issue 85's cap now bounds that side; this branch bounds the gateway side so the forwarded body never exceeds it).

## Safe reproduction (non-destructive, isolated)

```ts
// test/mcp-proxy.test.ts (the SELF.fetch + createTestApiKey harness):
const response = await SELF.fetch("https://gen.pollinations.ai/mcp/ffmpeg", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "listModels", arguments: { filler: "x".repeat(9 * 1024 * 1024) } } }),
});
expect(response.status).toBe(413); // RED on unpatched main: 200 "ffmpeg proxied" — the binding was invoked
```

The chunked variant (no `content-length`, a 64 KiB-chunk stream) is the second red case — only a running byte count can reject it. The under-cap control (64 KiB body) still dispatches and reaches the binding.

## Fix (`solution85-mcp-gateway-body-cap`)

`readMcpMessage` replaces the bare `clone().json()`: the declared `content-length` is rejected over the cap before any read, and a chunked body is read once, bounded, rejecting 413 **before** the main branch is ever forwarded to the binding (the probe shape ask-jev's worker established — `solution73-ask-jev-mcp-ip-rate-limit`). The cap is **8 MiB**: JSON-RPC tool arguments are KB-scale (each server's tool schemas bound their own arguments), 8 MiB matches the standalone workers' cap (issue 85) and keeps the umbrella's documented 5 MB `deploySite` payloads routed through gen working.

## Verification

Three new route-level cases in `test/mcp-proxy.test.ts` — declared-length 413, chunked-stream 413, under-cap control still dispatched (binding reached) — all red on unpatched main, green with the fix; mcp-proxy + mcp-card 45/45, `tsc --noEmit` clean. Live probes: $0 (deterministic offline).

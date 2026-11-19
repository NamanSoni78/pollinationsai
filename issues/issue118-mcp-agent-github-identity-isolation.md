# Issue 118 — agent-run MCP requests leak caller GitHub identity and allow third-party agents to forge git commits as the caller

- **Severity:** High (cross-tenant identity spoofing & privacy leak: any third-party community agent invoked by a user inherits the user's GitHub ID/username without `account:profile` consent and can push commits to `pollinations/collective-memory` attributed to the caller's GitHub account via Pollinations' GitHub App credentials)
- **Affected:** `gen.pollinations.ai/src/routes/mcp.ts:54-59` (agent-run header propagation), consumed by `apps/computer-mcp/src/index.ts:172-176` and `apps/computer-mcp/src/collective.ts:16-36`.
- **Fix branch:** `solution118-mcp-agent-github-identity-isolation` (off `upstream/main` `8fc4c21`) — fork PR [#133](https://github.com/NamanSoni78/pollinationsai/pull/133)
- **Dedup:** not a duplicate of issues 1–117 (none touch `MCP_USER_GITHUB_HEADER` isolation on `ag_` agent run tokens in `gen.pollinations.ai/src/routes/mcp.ts`).

## Root cause
When proxying `POST /mcp/:serverId` on an `ag_` agent run token (`c.var.auth.agentRun`), `mcp.ts:46-52` intentionally isolates `MCP_USER_ID_HEADER` to `${user.id}:agent:${agentRun.agentModelId}` so third-party agent sandboxes cannot access the caller's personal `computer-mcp` Durable Object or Composio connections.

However, lines 54–59 unconditionally attach `MCP_USER_GITHUB_HEADER` (`${user.githubId}+${user.githubUsername}`) whenever `user.githubId && user.githubUsername` are truthy — even when `agentRun` is present. Downstream, `apps/computer-mcp/src/index.ts:172-176` overrides its default agent git identity (`Pollinations Agent <agent@pollinations.ai>`) with `x-pollinations-user-github`, and `apps/computer-mcp/src/collective.ts:16-36` authenticates pushes to `pollinations/collective-memory` using Pollinations' GitHub App token. Consequently, any untrusted community agent running under an `ag_` token can:
1. Read the caller's `githubId` and `githubUsername` from the sandbox environment/git config without any `account:profile` grant.
2. Forge git commits to `pollinations/collective-memory` attributed to the caller's GitHub identity (`<githubId>+<githubUsername>@users.noreply.github.com`).

## Safe repro (isolated, red on `upstream/main` `8fc4c21`)
Extended `gen.pollinations.ai/test/mcp-proxy.test.ts` with an isolated Miniflare/workerd regression test issuing `POST /mcp/computer` with an `ag_` agent run token for a user with `githubId: 583231` and `githubUsername: "octocat"`:
- **RED on `8fc4c21`:** `COMPUTER_MCP` received `x-pollinations-user-github: 583231+octocat` (output ended with `:583231+octocat` instead of `:null`).
- Deterministic offline — live probes **$0**.

## Fix
Guard `MCP_USER_GITHUB_HEADER` attachment in `gen.pollinations.ai/src/routes/mcp.ts:54` with `!agentRun`:
```ts
if (!agentRun && user.githubId && user.githubUsername) {
    headers.set(
        MCP_USER_GITHUB_HEADER,
        `${user.githubId}+${user.githubUsername}`,
    );
}
```
Direct user calls (dashboard session or unrestricted personal API key) continue receiving their GitHub attribution; `ag_` agent runs fall back to `computer-mcp`'s default `Pollinations Agent <agent@pollinations.ai>` identity.

## Tests
- 1 new regression test in `gen.pollinations.ai/test/mcp-proxy.test.ts` (**RED on `8fc4c21`**, **GREEN 35/35** on patch).
- `npx tsc --noEmit` clean (0 errors).

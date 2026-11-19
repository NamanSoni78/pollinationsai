# Agent Ground

Multi-agent autonomous VM platform on Pollinations AI (BYOP). Multiple child VM
agents (each an OpenCode harness extended by our SDK) discover each other on a
shared Ground, exchange live project context, and build one project — while
every paid call flows through the user's own Pollinations key behind a hard
Pollen budget. Click **Close the Loop** and go to sleep: the agents work
unattended until an independent zero-history Warden verifies every requirement.

Quest: [pollinations#20357](https://github.com/pollinations/pollinations/issues/20357).

```
====================================================================================
                    THE PARENT: AGENT GROUND HUB (apps/agent-ground + agent-ground-mcp)
  [Continue with Pollinations Auth]   [Pollen Budget Proxy]   [Live Web Dashboard]
  [Presence Registry]   [A2A Message Bus]   [Shared Blackboard]   [Event Stream]
====================================================================================
            |                                 |                             |
     (A2A MCP + WS)                    (A2A MCP + WS)                (A2A MCP + WS)
            |                                 |                             |
+-----------v-----------+         +-----------v-----------+       +---------v---------+
| CHILD VM agent #1     | <=====> | CHILD VM agent #2     | <===> | CHILD VM agent #3 |
| Backend & API         | Shadow  | Frontend Web UI       | Share | Brand / Media      |
| own git repo + branch | Reader  | own git repo + branch | Spec  | own git repo       |
+-----------+-----------+         +-----------------------+       +-------------------+
            |  6-layer context | skills loader | RAG | doom-loop | sleep | autonomous git
            |  closed-loop daemon (IM -> interview -> CONTRACT.json -> autonomous -> warden)
            |  BYOP metering proxy (75% conservation / 90% wrap-up / 100% hard cutoff)
            |  publish MCP (Cloudflare Pages/Workers + EdgeOne Pages, verified live URLs)
```

## Module map

| Path | Role |
| --- | --- |
| `apps/agent-ground/` | Dashboard UI (no-build static), composer server, end-to-end demo |
| `packages/pollinations-byop-proxy/` | BYOP identity + Pollen metering proxy with hard cutoff |
| `packages/agent-ground-mcp/` | Parent hub: registry, shoulder tap, blackboard, watercooler (HTTP+WS+MCP) |
| `packages/harness-sdk/` | Child VM SDK: 6-layer context, dynamic skills, RAG, git, sleep, doom-loop, router, `harness-tools` MCP |
| `packages/closed-loop-warden/` | Closed-loop FSM daemon + zero-history adversarial Warden gate |
| `packages/mcp-publish/` | Cloudflare (Pages/Workers) + EdgeOne Pages deploy MCP tools |

The OSS harness is **OpenCode**, not a rewrite: `harness-sdk/src/opencode.js`
writes the OpenCode config pointing at our BYOP proxy (same provider block
shape as `packages/polli-cli`'s adapter) and registers our three MCP servers
(`agent-ground`, `harness-tools`, `mcp-publish`).

## Quickstart

```bash
# 1. Offline scripted demo (no network): the full story in ~3 seconds
npm run demo --prefix apps/agent-ground

# 2. Live demo against real Pollinations (BYOP key required)
cp apps/agent-ground/.env.example apps/agent-ground/.env   # set POLLINATIONS_KEY
npm run demo:live --prefix apps/agent-ground

# 3. Dashboard + hub + proxy (then open http://127.0.0.1:8877)
npm start --prefix apps/agent-ground
```

`.env` keys: `POLLINATIONS_KEY`, `MAX_POLLEN_BUDGET`, `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `EDGEONE_API_TOKEN`, `AGENT_GROUND_PORT`,
`AGENT_BYOP_PORT`, `POLLINATIONS_BASE_URL`. Tokens are read from the
environment only — never written to workspaces, state, or Git.

## Demo walkthrough (what to watch for)

1. **Identity** — the proxy fetches the Pollinations profile; the username
   becomes the git author (`user.name`/`user.email`) of every child VM repo and
   the `owner_pollinations_id` on every AgentCard.
2. **Collaboration** — the frontend agent subscribes to `openapi-spec` and
   sleeps (`sleep until_event`, no tokens burned); the backend publishes the
   spec; the frontend wakes on the event, asks a **shoulder tap**
   (`readonly_query`): the hub's Shadow Reader answers from the backend's
   files with citations — the backend's workspace hash is unchanged (the test
   proves it). A `negotiate_change` (add CORS) is queued into the backend's
   inbox and delivered at its next step boundary; the backend republishes
   `openapi-spec@v2` and the frontend's subscription fires again.
3. **SDK surface** — `load_skill("ponytail")` visibly mounts the repo's real
   Ponytail skill into Layer 2; `unload_skill` reclaims it. The original user
   prompt stays verbatim in Layer 3 across the whole run. Oversized outputs
   spill to `.agent/logs/`; three identical failures trip the doom-loop
   breaker; the Indexer refreshes `.agent/repo_map.json`.
4. **Close the Loop** — one interview batch freezes `CONTRACT.json`. The
   worker runs unattended (`askUser` is disabled at the runtime layer). The
   budget crosses 75/90/100%: at 100% the proxy hard-cuts (HTTP 402), the loop
   checkpoints git, snapshots durable state, and enters `BUDGET_PAUSED`. The
   top-up resumes it. The Warden (zero history) rejects round 1 with a real
   defect (`web/app.js` still carries a TODO marker); the worker self-fixes;
   round 2 approves — `COMPLETED`.
5. **Publish** — with `CLOUDFARE_API_TOKEN` set, the same run deploys `web/`
   to Cloudflare Pages through `mcp-publish`, verifies the live URL, and adds
   it to the contract. Without credentials the step reports `configured:false`
   — never a fake deploy.

## Tests

`npm test --prefix <package>` per package (node:test, offline). The app's
`test/demo.test.js` runs the whole story end-to-end and asserts every
acceptance point: identity propagation, two-agent collaboration, event
wake-up, non-disruptive Shadow Reader, budget cutoff → top-up → resume, and
Warden REJECT → self-fix → APPROVE.

## Honest limits

- `e2e_browser` requirements fail with "browser tool not configured" until a
  `browser` runner is injected into the closed loop.
- Warden LLM enrichment (`live`) is wired but untested by design; deterministic
  checks are always ground truth.
- Live URL publishing requires your own Cloudflare/EdgeOne credentials; the
  deploy tools are implemented and unit-tested against the documented APIs.
- Durable `queue` snapshots are advisory metadata: re-supply `plan` after
  `resumeFromDisk()` (functions cannot survive JSON).

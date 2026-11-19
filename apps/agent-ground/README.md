# Agent Ground — Multi-Agent Autonomous VM Platform on Pollinations AI (BYOP)

> **Fixes #20357**

Agent Ground is a modular multi-agent autonomous VM control plane built on **Pollinations AI (BYOP)**. Rather than rewriting a coding harness from scratch, it extends Pollinations' existing OpenCode integration (`packages/polli-cli/src/harnesses/opencode.ts`) with six cleanly decoupled modules for BYOP metering, peer-to-peer Shadow Reader interrogation, 6-layer heavy-context survival, Closed-Loop multi-day durability with a zero-history Adversarial Warden, and Cloudflare/EdgeOne Publish MCP.

## Architecture

```text
====================================================================================
                        THE PARENT: AGENT GROUND (CONTROL PLANE)
  [Pollinations Pay <polli-connect>]  [Pollen Budget Firewall]  [Live Web Studio]
  [Presence Registry]  [Shadow Reader Bus]  [Shared Blackboard]  [Watercooler Feed]
====================================================================================
           |                                |                              |
   (MCP JSON-RPC 2.0)              (MCP JSON-RPC 2.0)             (MCP JSON-RPC 2.0)
           |                                |                              |
+----------v----------+          +----------v----------+        +----------v----------+
| CHILD VM #1         | <======> | CHILD VM #2         | <====> | CHILD VM #N         |
| Backend & API       |  Shadow  | Frontend Web UI     |  Share | Brand / QA Agent    |
| branch: agent/be/*  |  Reader  | branch: agent/fe/*  |  Spec  | branch: agent/qa/*  |
+----------+----------+          +---------------------+        +---------------------+
           |
+----------v--------------------------------------------------------------------------+
|            CHILD AGENT INTERNALS (EXTENDED OPENCODE HARNESS SDK)                    |
|  1. Deterministic 6-Layer Context Compiler (Static / Skills / Intent / Worklog /    |
|     Live Telemetry / Working Window with 70% auto-compaction)                       |
|  2. Multi-LLM Router (Indexer | Worker | Embedding | Vision | Expert | Warden)      |
|  3. Heavy-Context Survival (>4KB Spill-to-Disk | summarize_context | Doom-Loop 3x)  |
|  4. Dynamic Skills Loader (list_skills | load_skill | unload_skill via SKILL.md)    |
|  5. Autonomous Git Engine (Pollinations author | .gitignore | secret-leak blocker)  |
|  6. Closed-Loop Daemon & Zero-History Adversarial Warden + Publish MCP (CF/EdgeOne) |
+-------------------------------------------------------------------------------------+
```

## Module Layout

| Package / App | Responsibility |
| --- | --- |
| `packages/pollinations-byop-proxy` | Pollinations BYOP identity lookup (`/account/profile`, `/account/balance`), Git author propagation, real-time `PollenBudgetFirewall` (75% conserve, 90% wrap-up, 100% HTTP `402` cutoff + Top-Up & Resume), and out-of-band HTTP Metering Proxy. |
| `packages/agent-ground-mcp` | Parent A2A Hub + Streamable HTTP JSON-RPC 2.0 MCP server (`ground_list_agents`, `ground_ask_agent`, `ground_publish_artifact`, `ground_fetch_artifact`, `ground_subscribe`, `ground_broadcast`, `ground_request_peer_check`) with `owned_paths` conflict locking. |
| `packages/harness-sdk` | OpenCode bridge (`opencode.json` routed via Metering Proxy), Multi-LLM Pollinations router, Deterministic 6-Layer Context Compiler, >4 KB spill-to-disk, `summarize_context`, Hybrid BM25 + semantic RAG (`rag_search`), 3x Doom-Loop circuit breaker, Dynamic `SKILL.md` Loader, zero-token `sleep`, Shadow Reader, `consult_expert`, and Autonomous Git Engine with pre-commit secret-leak guard. |
| `packages/closed-loop-warden` | Durable FSM (`IM_CHAT` -> `PREFLIGHT_INTERVIEW` -> `AUTONOMOUS_EXECUTION` -> `WARDEN_AUDIT` -> `COMPLETED` / `BUDGET_PAUSED`), hard-disabled human asking at runtime, atomic `.agent/durable-state.json` crash/restart recovery, zero-history Adversarial Warden auditor, and automatic `consult_expert` escalation on 2x consecutive rejection of the same requirement. |
| `packages/mcp-publish` | Cloudflare (`cloudflare_deploy_pages`, `cloudflare_deploy_worker`, `cloudflare_set_env_var`, `cloudflare_get_deployment_logs`) and EdgeOne (`edgeone_deploy_pages`, `edgeone_get_deployment_status`, `edgeone_get_logs`) MCP server with out-of-band credential vault and live HTTP `200` smoke verification (`publish_smoke_test`). |
| `apps/agent-ground` | Full-stack Parent Control Plane Express + Vite server and React Studio Web Dashboard with `<polli-connect>` Pollinations Pay sign-in. |

## Quick Start

```bash
cp .env.example .env
npm install
npm test      # Runs all 5 package unit & integration test suites (12/12 tests)
npm run lint  # TypeScript strict check
npm run dev   # Launches Agent Ground Control Plane at http://localhost:3000
```

## Reproducible End-to-End Walkthrough

1. **Pollinations BYOP & Budget Firewall:** Open `http://localhost:3000`, click **Pollination Connect** (`<polli-connect>`), adjust the max Pollen cap, or click **Test +0.40 Burn** to verify `75%` Conserve, `90%` Wrap-Up, and `100%` HTTP `402` Hard Cutoff + clean Git checkpoint + **Top-Up & Resume**.
2. **Non-Disruptive Shoulder Tap (Shadow Reader):** In **Studio**, run a `readonly_query` from `agent-frontend-02` to `agent-backend-01` asking about `/api/session` 401 JSON shape. Verify the file-cited answer (`apps/api/src/routes/session.ts`) returns with `worker disrupted: false` and `Worker loop mutations: 0`.
3. **Blackboard Versioning & Sleep Wake-Up:** Switch to **Blackboard**, publish `openapi-spec@v2`, inspect the line diff, and run a Pre-Warden Peer Smoke Check (`ground_request_peer_check`).
4. **Dynamic Skills & Publish MCP:** Switch to **Publish & Skills**, toggle `Load Skill` / `Unload Skill` on `cloudflare-deploy` and observe Layer 2 prompt tokens increase/reclaim live. Deploy via `cloudflare_deploy_pages` or `edgeone_deploy_pages` and confirm live `HTTP 200` smoke verification.
5. **Closed-Loop ("Sleep Mode") & Adversarial Warden Reject -> Fix -> Approve:** Switch to **Closed Loop**, click **Close the Loop**, submit the single-batch Pre-Flight Interview to freeze `CONTRACT.json`, click **Verify Zero-Human Guard** (confirming `HARD-DISABLED`), click **Simulate Crash & Restore**, then click **Run Zero-History Warden Audit** to see a real `REJECTED` verdict (catching the `TODO` stub & console error). Finally click **Worker Self-Fix & Re-Audit** to watch the Worker patch the file, checkpoint Git, pass HTTP `200` live verification, and earn Warden `APPROVED` -> `COMPLETED`.

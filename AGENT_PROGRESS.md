# AGENT_PROGRESS

## Wave 1 (6 agents, launched 2026-11-17)

| Agent | Scope | Status |
|---|---|---|
| W1-A | enter auth/session/keys/OAuth | launching |
| W1-B | enter payments/x402/topup/payouts | launching |
| W1-C | gen realtime WS + presence | launching |
| W1-D | gen audio/text/image routes | launching |
| W1-E | apps MCP servers | launching |
| W1-F | shared billing/auth/infra | launching |

## Wave 30 (4 agents, launched 2026-11-18, session 28 / cron 536599)

| Agent | Scope | Status |
|---|---|---|
| W30-A | enter quests/referrals/balance/auth | clean (0 gated findings; decisive guards documented) |
| W30-B | gen under-audited routes (sites/docs/userImage/routes/media/embeddings/middleware) | 1 gated finding → issue 100 |
| W30-C | durable objects + realtime + billing primitives | 1 gated finding → issue 101; 2 below-gate (frame governance, handoff-route dup of solution57) |
| W30-D | apps + operations + .github/workflows | 1 gated finding → issue 102; verified-clean inventory recorded |

## Wave 31 (5 agents, launched 2026-11-19, session 30 / cron 536170)

| Agent | Scope | Status |
|---|---|---|
| W31-A | enter routes with line-priority on never-audited files (github-secret-scanning, unsubscribe, session-token, status-notice, url-utils, integrations, app-lookup) | 2 gated findings → issue 105 (webhook pre-verify 2× buffering + parseFormOrJsonBody on 4 anonymous endpoints); rest verified clean with evidence |
| W31-B | gen under-audited routes (docs-samples, e2b-docs, azure-sandboxes, transcription-response, generation-executor, seo, model-catalog, mcp-card, jobs, docs) | clean (0 gated findings); below-gate handoffs to solution57/issue-87-98/issue-93 owners recorded |
| W31-C | shared/packages billing+auth core (atomic ops, x402, Stripe, JWTs, grants) | clean; 1 investigated-and-excluded hardening note (x402 questPollenOnly) |
| W31-D | media worker + community serve path + 3D/download legs | 1 gated finding → issue 106 (MediaUpload.put unbounded generation-write buffering, community speech feed) |
| W31-E | apps fleet + operations + all 43 workflows | clean; 3 new below-gate observations recorded (composio callbackUrl, floret anonymous routes, mcp coreUtils timeouts) |

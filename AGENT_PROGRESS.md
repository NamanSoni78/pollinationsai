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

## Wave 36 (5 agents, launched 2026-11-19, session 34 / cron 536170 / task AutoSecAudit_Pollinations)

| Agent | Scope | Status |
|---|---|---|
| W36-A | numeric/count/array parameter amplification matrix (image/video/audio/3d/text/embeddings/realtime) | clean (0 gated findings; exhaustive parameter table + 12 below-gate residuals recorded) |
| W36-B | rate-sheet + billing-parity fresh sweep (416-entry registry dump, every modality) | 1 gated finding → issue 113 (OpenRouter image receipt-discard: seedream-4.5 unpriced 4K tier + grok-imagine routes); 9 below-gate recorded |
| W36-C | server-side regex/ReDoS inventory + fresh-commit corners + gen utility files | 1 gated finding → issue 114 (adaptedChat quadratic tool_calls, measured ×4-per-doubling); regex inventory all anchored/linear; 6 below-gate recorded |
| W36-D | enter money/account deep corners (bounty/referral/topup/x400/session/auth-order) | clean (0 gated findings; all money paths transactional-idempotent offline-verified; 12 below-gate recorded) |
| W36-E | apps fleet escalation review + never-audited remainder + workflow deltas | clean (0 gated findings; all below-gate holds stayed below with evidence; 8 below-gate recorded) |

## Wave 37 — round 37 (session 35, cron 536002)

| Agent | Scope | Status |
|---|---|---|
| W37-A | audio surfaces + round-32 handoff verification (every outbound fetch enumerated, pending-branch coverage diffed) | 1 gated finding → issue 115 (SFX-fal/Qwen/SA3-M/L artifact caps+deadlines); ElevenLabs input-driven buffers recorded below gate |
| W37-B | model-fleet billing parity (134 text + 76 image + 40 audio primaries, 196 fallback routes vs cost sheets) | 4 below-gate cache-read sheet residuals recorded (need provider price confirmation); vision/audio/video axes otherwise clean; fresh-range Azure DeepSeek move clean |
| W37-C | enter authz + churn (39 commits classified hunk-by-hunk; money-path second pass; key management) | 1 gated finding → issue 116 (PR payout re-arm); everything else re-verified clean with evidence |
| W37-D | apps/MCP/ops second pass (polli tools, ffmpeg exec surface, exa caps, umbrella, workflows, news, infra-watch) | 0 gated findings (rg `--` below gate); informational: 6 filed fixes verified still unmerged upstream (issues 6/7/11/21/85+94/102) |
| W37-E | gen route body-parse matrix + community residuals + settlement-funnel coverage map | 1 gated finding → issue 117 (declared-header gate bypass); transcription settle companions + community schema verified covered by pending branches |

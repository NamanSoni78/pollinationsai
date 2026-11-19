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

## Wave 38 — round 38 (session 36, cron 537621, task AutoBugBountyAudit)

| Agent | Scope | Status |
|---|---|---|
| W38-A | fresh-range diff audit (8 commits `30a8939fd..c6badca138` hunk-by-hunk: TTS-HD cost, agents baseModel skip, embeddings rejection, Kilo-on-429, keyless Connect /code, speech seed=-1, quest retirement, APIDOCS) | clean (0 gated findings; 8 per-commit clean verdicts with evidence — the Kilo local-429 fail-closed path, seed cache-identity separation, and quest-source-removal completeness all verified by code-path; 9 below-gate observations) |
| W38-B | audio/transcription settlement residuals gate-pass attempt (round-37 companion notes + every sibling leg; pending-branch coverage branch-diffed) | 0 gated findings (all anomaly-gated cents — the issue-113 every-request differential does not exist in the audio fleet); 7-site class-sweep bundle recorded + the issue-115 deferral-sentence correction (verified by main agent via merge-base branch diffs) |
| W38-C | rate-sheet parity + cache-read pricing confirmation via public provider pages (the 4 round-37 residuals + fresh-range model additions + the 2 unprobed vision surfaces) | 0 gated findings (all 4 residuals unconfirmable — DeepInfra publishes `rate_per_input_token_cached: null` on 3, Alibaba does not list the 4th; nova-2-lite fold-in documented by AWS with vendor evidence, glm-5.3-flashx parity confirmed vs the pinned endpoint; 2 dead OR routes observed) |
| W38-D | apps/MCP fleet + community endpoints second pass (fresh-range + R35-D holds re-verification) | clean (0 gated findings; fleet byte-identical since round 37 — zero commits touched apps/packages/mcp/workflows; community registration + per-fetch validation re-verified; 11 below-gate holds re-verified verbatim) |
| W38-E | enter money/authz + text residuals (oauth.ts rewrite, agents.ts, quest retirement, issue-116 siblings, fresh text changes incl. Kilo fallback billing) | clean (0 gated findings; issue-114/116 fixes re-confirmed still unmerged upstream; 4 below-gate — keyless /code redirectUri server-side validation, apiKey session binding, KV burn race; Kilo cost-ledger note) |

## Wave 39 — round 39 (MCP AuthZ/Identity, Community Endpoints & Transcription Postpaid Sweep)
| Agent | Scope | Status |
|---|---|---|
| W39-A | MCP proxy & downstream apps (`gen.pollinations.ai/src/routes/mcp.ts`, `apps/computer-mcp`, `apps/composio-mcp`) | 2 gated findings → issue 118 (agent-run `x-pollinations-user-github` leak/commit spoofing, PR #133, 35/35 GREEN) + issue 119 (BYOP `redirectOrigin` & `permissions.models` bypass on `/mcp/:serverId`, PR #134, 41/41 GREEN); `pk_` keys killed at `api-key.ts:442` |
| W39-B | Community endpoints & enter authz (`community-endpoints.ts`, `agents.ts`, `oauth.ts`) | clean (0 gated findings; all `community-endpoints.ts` routes enforce `account:keys` + ownership; private code-agent `/sync` killed by existing test contract; keyless `/oauth/code` `redirectUri` held below gate) |
| W39-C | Deferred billing/usage transcription settlement & deadlines (`audio.ts`, `mai-transcription.ts`, `track.ts`, `shared/error.ts`) | 1 gated finding → issue 120 (postpaid `billedUsage`/`providerBilling` preservation on 200 OK schema/JSON failures + 120s `AbortSignal.timeout` deadlines across Azure GPT, xAI, ElevenLabs Scribe, MAI Azure/Vercel Gateway, PR #135, 146/146 GREEN); `gemma-4-26b-a4b-it:deepinfra` held below gate |

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

## Wave 40 — round 40 (session 37, cron 537621, task AutoBugBountyAudit)
| Agent | Scope | Status |
|---|---|---|
| W41-A | sandbox surfaces first pass (`e2b.ts` 1449 ln, `azure-sandboxes.ts` 514 ln, `machines-mcp`, computer-mcp interplay) | clean (0 gated findings; 14-route-group mount matrix — machines authz airtight cross-tenant; both real weaknesses already filed: issue 97 item 2 / issue 117; 10 kills with evidence) |
| W41-B | least-covered gen routes (`jobs/messages/well-known/model-catalog/model-status/mcp-card/generation-executor/generation-handlers` + docs/seo residuals) | clean (0 gated findings; mount-matrix anomalies = issues 68/97 already filed; job-ID predictability + Range forwarding verified-correct controls; 15 kills) |
| W41-C | 21-app `agent-*` fleet first per-app read | clean (0 gated findings; W36-E verdict confirmed at per-app level with code evidence — caller-pays at 3 independent layers, no scheduled platform-token runs, secrets sweep clean; 8 below-gate holds recorded) |
| W41-D | MCP/tool apps first pass (`network/research/news/calculators/packages-mcp`, `pi-workbench`, `floret`, consumer fleet) | 1 gated finding → issue 121 (floret gateway per-IP rate limit absence on public custom domains, PR #136, gateway tests RED 3/3 → GREEN 9/9); issue 54 re-confirmed open; consumer fleet clean |
| W41-E | packages (auth/sdk/mcp) + pollinations.ai site + workflows residuals | clean (0 gated findings; auth core 18 behaviors test-pinned; sdk header-only auth grep-verified; site zero XSS sinks at this SHA; all 55 workflows base-checkout verified; residuals dedupe to issues 21/48/94) |
## Wave 41 — round 41 (rate-sheet parity, inline-audio JSON TTS, transcription completion, ElevenLabs deadlines)
| Agent | Scope | Status |
|---|---|---|
| W41-A | Rate-sheet & billing parity (TTS-1 HD vs Azure retail, the four cache-read residuals, Kilo fallback parity, full-registry sweep) | 1 gated finding → issue 122 (qwen3.8-2.4t-a95b missing promptCacheWriteTokens, PR #137); TTS-1 HD verified correct; the four residuals NOT-CONFIRMED (public evidence); Kilo parity confirmed; gemma-4-26b:deepinfra cached-line over-billing left for a priced round |
| W41-B | Enter authz + quest money paths (retired-quest payout safety, keyless OAuth, agents.ts ownership) | clean (0 gated; pays-new-users: NO definitive; keyless /code self-impacting only; two hardening notes) |
| W41-C | Gen settlement residuals + fresh-commit corners (the 5 transcription legs, seed=-1 matrix, embeddings residuals) | fed issues 123/124 (the 3 backends issue 120 missed + the TTS inline-JSON legs via R40-E overlap); embeddings parts = issue 55 dup killed; GET/dialogue caps re-killed per the round-37 registry verdict |
| W41-D | Apps/MCP fleet + community endpoints (six handoffs, apps churn, registration bounds) | clean (all six HOLD; exa issue 7 fix still fork-only; wording/test churn only) |
| W41-E | Audio/timeout residuals + unprobed vision (ElevenLabs buffering math, deadline table, vision probeability) | fed issues 123/125 (the inline-JSON TTS family; the deadline sweep); WAV byte cap held below gate with the streaming-RIFF escape hatch; vision probes documented for a paid key |

## Wave 42 — round 42 (fresh-dimension sweep: live pricing drift, never-read enter routes, injection, concurrency, streaming)
| Agent | Scope | Status |
|---|---|---|
| W42-A | Registry pricing parity vs providers' live published prices (the standing DeepInfra/StreamLake residuals + top-15 drift sweep, all evidence fetched today) | 4 candidates; main-agent verification killed 1 (deepseek streamlake — wrong-slug evidence, the pinned -0813 endpoint is at parity) and confirmed 3 → issues 128/129 + flux-3-max; issue 80's rows re-verified still live upstream (unmerged fork fixes); gemma-4-26b cached-line residual re-killed (upstream has no cached line) |
| W42-B | Dedicated first read of the never-audited enter routes (admin, session-token, unsubscribe, referral, quest-grants, quest-leaderboard, sites, device, integrations, github-secret-scanning, account, app-lookup, product-analytics, status-notice) | clean (0 gated findings; every candidate kills against the W31-A/W30-A/round-6/7 kill lists — admin export-token compare, device-approve key hand-off, promo race, quests throttle race, sites races, referral self-credit, session replay) |
| W42-C | Injection families first pass (CRLF/header injection, SSE framing, prototype pollution, ReDoS, canonicalization) | 1 gated finding → issue 127 (trailing-root-dot bypass of `validateUserMediaUrl` — `localhost.`/`foo.localhost.` pass the blocked-name rules; the community sibling strips the dot); CRLF/PP/ReDoS/SSE-framing clean with 3-layer/0-sink evidence |
| W42-D | Concurrency / idempotency / atomicity dedicated first pass (every money path: settle dedup, reserve atomicity, refunds, agent-run replay, KV burn races, D1 batches) | clean (0 gated findings; 20-path protection inventory recorded — the concurrent-overspend semantic dedups to issue 31, the promo race is accepted-by-design, no KV read-modify-write on balances exists) |
| W42-E | Streaming/protocol corners deep pass (SSE chunk-split integrity, framing injection, torn-stream caching, WS, Range) | 2 gated findings → issues 126 (vercelSearch unguarded parse + raw usage throws tear the 200'd public stream, two paid generations settle $0) + 130 (sonilo bare result parse discards the paid receipt); 19 remaining legs catalogued clean with guards |

## Wave 44 — round 44 (cron agent-loop 202611200024, task AutonomousBugBounty)

| Agent | Scope | Status |
|---|---|---|
| W44-A | Stability-on-Bedrock integration deep-dive (params/reference caps, fallback billing, signer reuse, family comparison) | 1 gated finding → issue 131 (settlement drops, incl. the retryable-502 fallback double-spend amplification); below-gate: deadline-less model-owned reference fetch (inherited family), BEDROCK_REGION drift, ~28 MB base64 body |
| W44-B | R2-retry blast radius (write consumers, requestId provenance, settlement ordering, TTL interplay) | clean (0 gated findings; ≤4 s worst-case retry fits every deadline; requestId is nonce-gated telemetry; the billed-but-no-artifact 503-after-charge ordering is pre-existing and pinned-as-intended by #20321's own tests — recorded as a design note) |
| W44-C | fresh-corner sweep (model-evals sinks, never-audited files, registry churn, standing residuals, claim-site staleness) | clean (0 gated findings; registry churn verified descriptions-only; model-evals has no repo-content→shell sink; staleness line-number refresh: cache-before-auth now at routes/proxy.ts:239/253/278/915/944/986 + routes/audio.ts:4920/5043) |
| W44-D | image-fleet settlement-consistency map (38 model files × bare-parse/post-billed-throw inventory vs the filed registry) | 1 gated finding → issue 131 (the only unfiled instance — the new Stability file); top claim killed in personal verification: the xai video download leg is already wrapped on the pending `solution72` branch (diff-verified) — duplicate, not re-filed |

## Wave 44 (concurrent session 40 — cron 536163, task AutonomousAuditWorkflow)

| Agent | Scope | Status |
|---|---|---|
| 44-A | Delta code audit of the 9 fresh upstream commits (`4e662050..4f3585e97`): R2-write-retry semantics, Stability model integration, dashboards/wording, doc-regen leak scan | clean (0 gated findings; 10 rejected candidates recorded — R2 regex non-match = pre-fix behavior, Bedrock non-JSON-200 = issue-130/126 class, deadline-less reference download = issue 20's scope, etc.; the commit's own new tests re-run green: media integration 80/80) |
| 44-B | Registry rate-sheet recount on `4f3585e97` (all 421 models; split-reporting exposure; new-model pricing completeness) | 1 gated finding → issue 132 (`mistral-large-4` vision $0 — missed by issues 46/49/52 and the PR-#61 superset, files-patch verified); F-06 corrections: flux-3-max family now receipt-settled (quotes/preflight drift only), SD-3.5-large free input = deliberate flat-per-image convention; 41 split routes still unpriced, all previously enumerated |
| 44-C | Flagship regression sweep — all 13 consolidated reports' flagship claims re-verified on `4f3585e97` | all LIVE (0 fixed upstream; every cited line byte-identical); staleness notes: registry line numbers shifted by the description rewrite, Pollen→USD wording made quoted comments stale, APIDOCS regen propagated the F-13 3D claim; the Stability post-invoke guards recorded as F-04 family addendum (the concurrent session registered it as issue 131) |
| 44-D | Test-harness baseline at `4f3585e97` (install, affected suites, typecheck) | baselines recorded (text-cache 21/21, media integration 80/80, image 928/928+33/33, effective-prices 1/1); pre-existing reds documented (generation-coordinator sandbox OOM, media tsc 1 error) so fix branches are not blamed |

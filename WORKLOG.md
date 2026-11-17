# WORKLOG — Autonomous Bug Bounty (round 3)

Round 3 continues rounds 1–2 (issues 1–8, fork PRs #1–#11). Baseline: upstream `bbccf2f5` (2026-11-17). Method: parallel subagent audits (auth/OAuth, payments/billing, gen text/audio/realtime, gen images/jobs/embeddings, apps/MCP, shared core) followed by main-agent verification — only findings reproduced by isolated unit/integration tests or non-destructive live probes (own key) are accepted. Known-issue dedup registry: issues 1–8 (see SECURITY_AUDIT.md).

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 9 | Discord OAuth state replay → account takeover (provider-agnostic state + no PKCE + trusted unverified email on callback path) | Critical | Integration test reproduced ATO on unpatched `bbccf2f5`; pinned fixed behavior + 62 auth tests green | `solution9-discord-callback-state-replay` | fork PR [#12](https://github.com/NamanSoni78/pollinationsai/pull/12) |
| 10 | Community publishers bill callers on unbounded self-reported usage (9e15 tokens → 4.5e17 pollen per response; publisher earns 75%) | High | Unit test on unpatched billing path reproduced 4.5e17 charge; clamp pinned by 5 tests + 1,105 regression tests green | `solution10-community-usage-billing-cap` | fork PR [#13](https://github.com/NamanSoni78/pollinationsai/pull/13) |
| 11 | polli web_scrape/fetch_file fetch arbitrary internal destinations from the credentialed bot container (SSRF; metadata/webhook/API/compose-net reachable) | High | Unit test with mocked aiohttp reproduced metadata-credentials fetch on unpatched code; policy pinned by 6 tests + full polli suite (211) green | `solution11-polli-scraper-ssrf-guard` | fork PR [#14](https://github.com/NamanSoni78/pollinationsai/pull/14) |

## Candidate triage (round 3, not accepted — for the record)

- Promo-code `maxRedemptions` count-then-insert race — explicitly accepted in-code ("ponytail" comment, promo-codes.ts:131); not resubmitted.
- Community model-ID namespace keyed on non-unique `github_username` — real structural weakness but requires a GitHub username-recycle precondition; below the reproducibility gate.
- gen realtime overdraft / post-paid settlement, ElevenLabs SFX v3 flat 5s billing, Azure realtime usage-event dependence — documented deliberate designs or provider-side facts; not exploitable client-side.

## Sync history

| Date (UTC) | Action |
|---|---|
| 2026-11-18 | fork/main fast-forwarded to upstream `bbccf2f5`; issues_mds rebased on new baseline |


## Round 5 — ledger hygiene + alignment (2026-11-18)

Baseline: upstream `549feee`; fork/main verified identical (`ahead 0 / behind 0`). All branches and fork PRs #1–#16 preserved.

Two media findings had been written up under **duplicate issue numbers** (a second `issue10` and `issue11` were reused while those numbers already belonged to the community-usage and polli-SSRF reports). Renumbered, content preserved and tightened:

| # | Finding | Severity | Evidence | Fix branch | PR |
|---|---|---|---|---|---|
| 12 | JSON upload path allocates ≈4.6× the decoded size before the size check, so a ~40 MiB payload kills the isolate (503 / `error code: 1102`) well below the documented 100 MiB cap | High (availability) | Live: 4 MiB and 24 MiB → 200, 40 MiB → 503/1102 on production; new pre-decode 413 test; full media suite 76/76 green on the fix branch | `solution10-json-upload-memory-cap` | fork [#15](https://github.com/NamanSoni78/pollinationsai/pull/15) |
| 13 | Upload gate checks only `authResult.type`, so `ag_` agent-run tokens (which inherit the parent's `secret` type) can upload and gallery-publish, while DELETE already refuses them | Medium | Isolated test: `ag_` stub upload returns 200 on main, 403 with the fix; suite 76/76 green | `solution11-agent-run-token-upload-guard` | fork [#16](https://github.com/NamanSoni78/pollinationsai/pull/16) |

Removed the two duplicate-numbered files (`issue10-json-upload-isolate-oom.md`, `issue11-agent-run-token-upload-bypass.md`); their content lives on in issues 12 and 13, and the unsubstituted `{B11}` marker in the agent-token report is fixed.

### Surfaces reviewed this round — controls held (no new issue accepted)

| Surface | Evidence |
|---|---|
| Client IP derivation | `shared/client-ip.ts` reads only `cf-connecting-ip`; clients cannot spoof the rate-limit identity |
| Realtime sessions | `routes/realtime.ts` `authorizeRealtimeSession` calls `auth.requireUser()` before minting; balance/reservation gates mirror the text path |
| MCP proxy | `routes/mcp.ts` mounts `auth()` on `/mcp/:serverId`; caller cookies and all `MCP_USAGE_*` headers are stripped inbound, receipt headers stripped outbound, requests rewritten to `mcp.internal` (receipts come from in-repo servers, not publishers) |
| Sandbox leases (E2B / Azure) | Owner-keyed metadata checks, per-user running cap, lease-based billing, 24h ceiling; no cross-user handle reuse found |
| Model registry resolution | `buildRegistry([...STATIC_ENTRIES, ...communityEntries])` with first-wins id/alias maps; community ids are `community/<username>/<name>` via `communityModelId()`, so an official id or alias cannot be shadowed |
| Media retrieval headers | `readMedia` applies `nosniff` + sandboxed CSP last, and only the trusted generation `put()` may replay stored `header_*` metadata |
| Referrer handling | `middleware/track.ts` uses Referer for analytics only; it never selects a tier or bypasses a limit |
| Preflight affordability | `canCoverEstimatedCharge` is documented as a deliberately lightweight check that settles overdraft into Quest Pollen debt — design, not a bug |

### Blocker recorded

Upstream pull-request creation still returns `403 Resource not accessible by personal access token` although the token reports `pull_requests=write`; fork PRs #15/#16 remain the live review surface until an upstream-scoped token is supplied.

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

## Round 5 — alignment + issue reports for the two undocumented media findings (2026-11-18)

Baseline: upstream `549feee` (fork/main verified identical, `ahead 0 / behind 0`). All branches and PRs #1–#16 preserved.

Two fix branches existed without an issue report; both are now documented and linked:

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 12 | media JSON uploads decode base64 `before` the size check (100 MiB cap compared against the decoded buffer), so a ~40 MiB payload OOMs the isolate (1102) instead of 413; the privacy branch above it already pre-checks the encoded length | High (availability) | Decode order and the missing pre-decode guard confirmed at `549feee`; integration test asserts 413 for an oversized body | `solution10-json-upload-memory-cap` | fork [#15](https://github.com/NamanSoni78/pollinationsai/pull/15) |
| 13 | media uploads accept agent-run tokens (`ag_`) that inherit the parent key's `secret` type, while DELETE already refuses them — low-trust agent code can create and gallery-publish media it cannot delete | Medium-High | Upload gate vs DELETE gate compared at `549feee`; integration test asserts 403 for `ag_` | `solution11-agent-run-token-upload-guard` | fork [#16](https://github.com/NamanSoni78/pollinationsai/pull/16) |

### Surfaces reviewed this round — controls held (no new issue accepted)

| Surface | Evidence |
|---|---|
| Client IP derivation | `shared/client-ip.ts` reads only `cf-connecting-ip`; client headers cannot spoof the rate-limit identity |
| Realtime sessions | `routes/realtime.ts` `authorizeRealtimeSession` calls `auth.requireUser()` before minting; balance/reservation gates mirror the text path |
| MCP proxy | `routes/mcp.ts` mounts `auth()` on `/mcp/:serverId`; caller cookies and all `MCP_USAGE_*` headers are stripped inbound, receipt headers stripped outbound, and requests are rewritten to `mcp.internal` (receipts come from in-repo servers, not publishers) |
| Sandbox leases (E2B / Azure) | Owner-keyed metadata checks, per-user running cap, lease-based billing, 24h ceiling; no cross-user handle reuse found |
| Model registry resolution | `buildRegistry([...STATIC_ENTRIES, ...communityEntries])` with first-wins id/alias maps, and community ids are prefixed via `communityModelId()` — a community model cannot shadow an official id or alias |
| Community model ids | `community/<github_username>/<name>`; collision with official namespace structurally impossible |
| Media retrieval headers | `readMedia` sets `nosniff` + sandboxed CSP last, and only stores `header_*` metadata from the trusted generation `put()` |
| Referrer handling | `middleware/track.ts` uses the Referer only for analytics; it never selects a tier or bypasses limits |
| Preflight affordability | `canCoverEstimatedCharge` is documented as a deliberate lightweight check with overdraft settling into Quest Pollen debt — design, not a bug |

### Blocker recorded

Upstream pull-request creation still returns `403 Resource not accessible by personal access token` even though the token reports `pull_requests=write`; fork PRs #15/#16 are the live review surface until an upstream-scoped token is supplied.

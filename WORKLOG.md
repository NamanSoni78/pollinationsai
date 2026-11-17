# WORKLOG — Autonomous Bug Bounty (round 3)

Round 3 continues rounds 1–2 (issues 1–8, fork PRs #1–#11). Baseline: upstream `bbccf2f5` (2026-11-17). Method: parallel subagent audits (auth/OAuth, payments/billing, gen text/audio/realtime, gen images/jobs/embeddings, apps/MCP, shared core) followed by main-agent verification — only findings reproduced by isolated unit/integration tests or non-destructive live probes (own key) are accepted. Known-issue dedup registry: issues 1–8 (see SECURITY_AUDIT.md).

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 9 | Discord OAuth state replay → account takeover (provider-agnostic state + no PKCE + trusted unverified email on callback path) | Critical | Integration test reproduced ATO on unpatched `bbccf2f5`; pinned fixed behavior + 62 auth tests green | `solution9-discord-callback-state-replay` | fork PR [#12](https://github.com/NamanSoni78/pollinationsai/pull/12) |
| 10 | Community publishers bill callers on unbounded self-reported usage (9e15 tokens → 4.5e17 pollen per response; publisher earns 75%) | High | Unit test on unpatched billing path reproduced 4.5e17 charge; clamp pinned by 5 tests + 1,105 regression tests green | `solution10-community-usage-billing-cap` | fork PR [#13](https://github.com/NamanSoni78/pollinationsai/pull/13) |
| 11 | polli web_scrape/fetch_file fetch arbitrary internal destinations from the credentialed bot container (SSRF; metadata/webhook/API/compose-net reachable) | High | Unit test with mocked aiohttp reproduced metadata-credentials fetch on unpatched code; policy pinned by 6 tests + full polli suite (211) green | `solution11-polli-scraper-ssrf-guard` | fork PR [#14](https://github.com/NamanSoni78/pollinationsai/pull/14) |
| 12 | User-media redirect hops skip the URL policy (image=/embeddings image_url/reference_audio fetch follows 302 to loopback/private/metadata — SSRF) | High | Live control probe (guard active in prod) + pre-fix code path (no redirect option, dead manual-refusal) + 12 unit tests pin hop re-validation; image/embeddings/audio suites green | `solution12-user-media-redirect-validation` | fork PR [#17](https://github.com/NamanSoni78/pollinationsai/pull/17) |

## Candidate triage (round 3, not accepted — for the record)

- Promo-code `maxRedemptions` count-then-insert race — explicitly accepted in-code ("ponytail" comment, promo-codes.ts:131); not resubmitted.
- Community model-ID namespace keyed on non-unique `github_username` — real structural weakness but requires a GitHub username-recycle precondition; below the reproducibility gate.
- gen realtime overdraft / post-paid settlement, ElevenLabs SFX v3 flat 5s billing, Azure realtime usage-event dependence — documented deliberate designs or provider-side facts; not exploitable client-side.

## Sync history

| Date (UTC) | Action |
|---|---|
| 2026-11-18 | fork/main fast-forwarded to upstream `bbccf2f5`; issues_mds rebased on new baseline |

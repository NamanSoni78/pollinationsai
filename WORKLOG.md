# WORKLOG — Autonomous Bug Bounty (round 3)

Round 3 continues rounds 1–2 (issues 1–8, fork PRs #1–#11). Baseline: upstream `bbccf2f5` (2026-11-17). Method: parallel subagent audits (auth/OAuth, payments/billing, gen text/audio/realtime, gen images/jobs/embeddings, apps/MCP, shared core) followed by main-agent verification — only findings reproduced by isolated unit/integration tests or non-destructive live probes (own key) are accepted. Known-issue dedup registry: issues 1–8 (see SECURITY_AUDIT.md).

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 9 | Discord OAuth state replay → account takeover (provider-agnostic state + no PKCE + trusted unverified email on callback path) | Critical | Integration test reproduced ATO on unpatched `bbccf2f5`; pinned fixed behavior + 62 auth tests green | `solution9-discord-callback-state-replay` | fork PR [#12](https://github.com/NamanSoni78/pollinationsai/pull/12) |
| 10 | media JSON upload isolate OOM (buffers ~4.6× decoded size; cap checked only after allocation) — live-verified error 1102 at 40 MiB | High | Live probe: 40 MiB → 503 error 1102, 24/4 MiB controls → 200; new pre-decode 413 test; 76/76 green | `solution10-json-upload-memory-cap` | fork PR [#{15}]({https://github.com/NamanSoni78/pollinationsai/pull/15}) |
| 11 | Agent-run tokens (ag_) bypass the sk_-only media upload restriction (upload gate checks reported type only; DELETE already rejects ag_) | Medium | Unit test with ag_ stub identity reporting parent's secret type: unpatched 200 → patched 403; 76/76 green | `solution11-agent-run-token-upload-guard` | fork PR [#{16}]({https://github.com/NamanSoni78/pollinationsai/pull/16}) |

## Candidate triage (round 3, not accepted — for the record)

- Promo-code `maxRedemptions` count-then-insert race — explicitly accepted in-code ("ponytail" comment, promo-codes.ts:131); not resubmitted.
- Community model-ID namespace keyed on non-unique `github_username` — real structural weakness but requires a GitHub username-recycle precondition; below the reproducibility gate.
- gen realtime overdraft / post-paid settlement, ElevenLabs SFX v3 flat 5s billing, Azure realtime usage-event dependence — documented deliberate designs or provider-side facts; not exploitable client-side.

## Sync history

| Date (UTC) | Action |
|---|---|
| 2026-11-18 | fork/main fast-forwarded to upstream `bbccf2f5`; issues_mds rebased on new baseline |
| 2026-11-17 | fork/main fast-forwarded to upstream `549feee9`; wave-2 parallel audit (media / pollinations.ai / packages / operations — latter three clean) confirmed issues 10–11; branches pushed, PRs #15/#16 |

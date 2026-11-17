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

## Round 4 — media.pollinations.ai surface review (2026-11-18)

Baseline: upstream `549feee` (fork/main already aligned, 23 branches present; issues 1–11 and PRs #12–#14 intact).

Scope this session: full route-level review of `media.pollinations.ai` (`src/index.ts`, `catalog.ts`, `media-upload.ts`, `multipart-upload.ts`) plus a tracked-file credential scan.

**No new issue accepted — controls verified:**

| Control | Evidence |
|---|---|
| Custom upload ids are account-scoped, unguessable and unforgeable | id = `u_<hex(sha256(userId))>_<requestedId>`, requestedId validated on both multipart (`UploadIdSchema.safeParse`, index.ts:622) and JSON (`JsonUploadRequestSchema.id`, index.ts:225) paths; regex `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` blocks traversal/overlong ids |
| Deletion is owner-only and cannot be done with a publishable or agent-run key | `auth.type !== "secret"` and `ag_` prefix rejected (index.ts:1029-1038); `catalogItemOwner` compared to `auth.userId` (1046-1052); uncataloged ids answer 404 |
| Upload staging cannot be hijacked or enumerated | temp key `pending/03be6a69-b5c9-4328-bb0f-f57a84bea658`, aborted+deleted on failure (multipart-upload.ts:39,103-107); busboy limits (fields 20, files 2, parts 22, fileSize max+1) |
| Key verification fails closed, but does not mislabel valid keys | 4xx-but-not-429 => invalid; network/5xx => 503 (index.ts:107-140) |
| No plaintext credentials in tracked files | `apps/*/secrets*.json` and `secrets/env.json` are SOPS/age-encrypted; key-shaped scan hits are masked test fixtures (`worker.test.js`, `wrangler.toml`) |

Treated as deliberate design, not submitted: expired custom ids being reusable (documented at index.ts:57-58, with 409 guard against re-attaching to a live catalog row), and the `u_<sha256(userId)>_` prefix acting as a stable pseudonymous uploader handle in public galleries.

## Sync history

| Date (UTC) | Action |
|---|---|
| 2026-11-18 | fork/main verified equal to upstream `549feee`; issues 1–11 + `solution9`–`solution11` branches confirmed; round-4 review appended |

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

## Round 5 — MCP gateway, jobs, messages, shared hardening (2026-11-18)

Baseline: upstream `549feee` (fork/main equal, verified). Scope: `gen` MCP gateway (`routes/mcp.ts`, `mcp-card.ts`), async job routes, Anthropic-compat `/v1/messages`, stem separation, and shared hardening modules (`response-bytes`, `client-ip`, `community-endpoint-urls`, `error`, Stripe webhook verification, D1 query construction).

**No new issue accepted — controls verified live and in code:**

| Control | Evidence |
|---|---|
| MCP gateway cannot be reached without a key | Live against `gen.pollinations.ai`: `/mcp` 200 (public catalog, by design), `/mcp/exa` **401**, `/mcp/ffmpeg` **401**, `/mcp/EXA` **401**, `/mcp/exa/` **404**, `/mcp//exa` **404**, `/mcp/exa/card` **404** — no path variant falls through to a server binding |
| Paid-only models refuse anonymous callers | Live: `POST /v1/chat/completions` `google/gemini-3.7-flash` → **401**; `GET /image` `black-forest-labs/flux.2-max` → **401** |
| Job status/result are owner-scoped | `routes/jobs.ts` resolves through `GENERATION_COORDINATOR.getByName(id).status(userId)`; another account gets 404, results served `private, no-store` + `Vary: Authorization` |
| `/v1/messages` inherits chat auth, balance, cache and billing | Route dispatches to `/v1/chat/completions` with the caller's headers, so no parallel billing path exists |
| Stem separation runs the full gate chain | `auth`, `balance`, cache, `generationAccess`, `apiKeyBudgetReservation` before the provider call |
| Untrusted response bodies cannot exceed their cap | `shared/response-bytes.ts` checks Content-Length and a running byte count while streaming |
| Rate-limit identity is not client-spoofable | `shared/client-ip.ts` reads only `cf-connecting-ip` |
| Community endpoint URLs reject internal targets | `shared/community-endpoint-urls.ts` blocks localhost/.local, IPv6 literals, 127/10/192.168/169.254/172.16-31/CGNAT 100.64-127, 0.0.0.0/0, 224+ and 198.18-19 |
| Error responses do not leak storage internals | `shared/error.ts` drops Drizzle/D1 query text and caps upstream bodies at 16 KB |
| Payment and scan webhooks verify signatures | `routes/stripe-webhooks.ts` rejects unsigned or invalid `stripe-signature` with 400 |
| No interpolated SQL outside test helpers | Repo-wide scan: only `shared/test/reset-storage.ts` builds table names into SQL |

**Rejected this round (recorded so later sessions do not resubmit):**

- Seedance 2.5 edit without `promptVideoSeconds`: input-video cost is folded into the higher `video_in_480p`/`video_in_720p` completion rates (`shared/registry/image.ts:1933-1940`), so nothing is unbilled.
- Video preflight reserving roughly one second: `getDefinedRequestEstimate` is a deliberate soft preflight by declared unit (upstream `95a49d1` fixed the megapixel analogue and kept one-unit semantics); settlement is post-paid, so this is design, not a defect.
- `/v1/messages` dropping the query string: re-tested, `?key=` authenticates normally.

**Sync:** fork/main = upstream `549feee`; branches `issues_mds`, `solution1`–`solution11` intact.

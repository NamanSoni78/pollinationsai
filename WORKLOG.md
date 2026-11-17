# WORKLOG — Autonomous Bug Bounty (round 3)

Round 3 continues rounds 1–2 (issues 1–8, fork PRs #1–#11). Baseline: upstream `bbccf2f5` (2026-11-17). Method: parallel subagent audits (auth/OAuth, payments/billing, gen text/audio/realtime, gen images/jobs/embeddings, apps/MCP, shared core) followed by main-agent verification — only findings reproduced by isolated unit/integration tests or non-destructive live probes (own key) are accepted. Known-issue dedup registry: issues 1–8 (see SECURITY_AUDIT.md).

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 9 | Discord OAuth state replay → account takeover (provider-agnostic state + no PKCE + trusted unverified email on callback path) | Critical | Integration test reproduced ATO on unpatched `bbccf2f5`; pinned fixed behavior + 62 auth tests green | `solution9-discord-callback-state-replay` | fork PR [#12](https://github.com/NamanSoni78/pollinationsai/pull/12) |
| 10 | Community publishers bill callers on unbounded self-reported usage (9e15 tokens → 4.5e17 pollen per response; publisher earns 75%) | High | Unit test on unpatched billing path reproduced 4.5e17 charge; clamp pinned by 5 tests + 1,105 regression tests green | `solution10-community-usage-billing-cap` | fork PR [#13](https://github.com/NamanSoni78/pollinationsai/pull/13) |
| 11 | polli web_scrape/fetch_file fetch arbitrary internal destinations from the credentialed bot container (SSRF; metadata/webhook/API/compose-net reachable) | High | Unit test with mocked aiohttp reproduced metadata-credentials fetch on unpatched code; policy pinned by 6 tests + full polli suite (211) green | `solution11-polli-scraper-ssrf-guard` | fork PR [#14](https://github.com/NamanSoni78/pollinationsai/pull/14) |
| 14 | User-media redirect hops skip the URL policy (image=/embeddings image_url/reference_audio fetch follows 302 to loopback/private/metadata — SSRF) | High | Live control probe (guard active in prod) + pre-fix code path (no redirect option, dead manual-refusal) + 12 unit tests pin hop re-validation; image/embeddings/audio suites green | `solution12-user-media-redirect-validation` | fork PR [#17](https://github.com/NamanSoni78/pollinationsai/pull/17) |

> Renumber note (2026-11-18): this session's user-media-redirect report was first written as `issue12` in parallel with session 2's media findings (which also registered 12/13). It is renumbered to **issue14** (`issues/issue14-user-media-redirect-policy-bypass.md`); the fix branch keeps its `solution12-*` name and fork PR #17 is unchanged.

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


## Round 6 — enter auth surface + live probe matrix (2026-11-18, session 2)

Baseline: upstream `549feee`; `fork/main` identical; `issues_mds` `3115ddd` (parallel-session round preserved — issues 1–13 and PRs #15/#16 untouched). This round is additive only: no history rewrite, no file deletions.

Scope: `enter.pollinations.ai` authorization core (device grant, session tokens, API-key authentication, edge rate limit, admin guard, referral/quest grants, async-job ownership, app lookup, unsubscribe, repo-bot authorization) plus a non-destructive live probe matrix against `gen.pollinations.ai`.

### No new issue accepted — controls verified

| Control | Evidence |
|---|---|
| Device grant is single-use and unforgeable | 40-char device code + 8-char user code over a 32-symbol alphabet; `/token` deletes the D1 row and the KV entry in one step before releasing the key (`routes/device.ts`), so a replayed poll gets `invalid_grant` |
| Device user codes are not a token oracle | `GET /api/device/info` returns only `status`/`scope`/`clientId`; the key is released only to the holder of the 40-char device code |
| Device client ids must be real published apps | `isKnownDeviceClient` → `findPublishableClientKey`; unknown or revoked ids fail at issuance with `invalid_client` |
| Session tokens are short-lived and scoped | HS256 over a purpose-derived signing key, `iss`/`aud`/`exp` (900 s)/`typ` all required; `extractApiKey` refuses `sess_` tokens in `?key=`, so they cannot leak through referrers |
| Publishable keys can never authenticate | `pk_` prefix → 401 with an explicit refusal; `sk_`/app keys stay distinct |
| Key lookup cannot amplify floods or act as an oracle | 300 s negative cache on invalid key hashes; `last_request` write throttled to 5 minutes |
| Edge rate limit still counts IPs with `byIp:false` | `shared/rate-limit.ts` counts every unkeyed request when `cf-connecting-ip` is present, so device codes, app lookup and sign-in cannot be flooded from one host |
| Admin API is unreachable with a user credential | `routes/admin.ts` requires a bearer matching `PLN_ENTER_TOKEN` (constant-time `secretEquals`) or the hashed D1-export token on the single `trigger-d1-sync` path; there is no session or API-key path |
| Bulk pollen grants are admin-only and idempotent | admin guard + `rewardKey(questId, user)` idempotency keys in `quest-grants.ts` |
| Async job results are owner-scoped | `/v1/jobs/*` mounts `auth()`; `ownedJob` queries the per-job Durable Object with the caller's user id, ids are 64-hex hashes |
| App lookup binds client_id to its redirect allowlist | `app-lookup.ts` answers `{found:false}` on mismatch, so a public `pk_` cannot brand a consent screen and hand a key to a third-party redirect |
| Unsubscribe links are signed | `verifyUnsubscribe(BETTER_AUTH_SECRET, u, s)`; forged links get the invalid page |
| Repo bot cannot be triggered by a non-maintainer | immutable numeric user ids, `sender.type === 'Bot'` rejected, label removed on failure (`repo-auto-fix-polli-issues.yml`, `polli-authorization.mjs`) |
| Input surfaces are bounded | TTS `input` ≤ 10 000 chars, duration ≤ 380 s, steps ≤ 100, seed ≤ u32, image ≥ 16 px/side, embedding batch capped |
| Site hosts are isolated from the dashboard origin | `sites.ts` resolves names only under `SITES_HOST_SUFFIX`, never under the `enter`/`gen` hosts |

### Live probe matrix (anonymous + own key, non-destructive)

| Probe | Result |
|---|---|
| `GET /image/{prompt}` anon, prompt generated before | 200 — cache HIT, i.e. issue #1, not a new finding |
| `GET /image/{fresh prompt}` anon | 401 |
| `GET /image/...?width=16384&height=16384` anon | 401 (uncached) |
| `GET /image/...?width=abc` anon | 400 with `fieldErrors.width` |
| `GET /video/...`, `GET /3d/...` anon | 401 |
| `POST /v1/audio/transcriptions` (multipart) anon | 401 |
| `POST /v1/audio/speech`, `POST /v1/embeddings`, `GET /text/...` anon | 200 (free tier) |
| `POST /v1/chat/completions` anon with `openai/gpt-6.1-sol` or `moonshotai/kimi-k3.1-pro` | 401 — premium models are not anonymously selectable |
| `POST /mcp` anon | 405 |
| Reflected payload probe (`<script>`, `<svg onload>`) | JSON errors only, no HTML reflection |

Balance before and after the probes: `1.97499171` → `1.97499171` pollen (no spend).

### Candidates rejected (recorded, not submitted)

- Device-code phishing by borrowing a third-party `pk_` as `client_id`: the consent page shows the real owner, the grant is explicit per device, and the key is minted by the victim's own session — no server-side authorization gap to patch.
- `/approve` accepts `apiKey`/`apiKeyId` from the body: the key is minted by the same authenticated session, so there is no gain without an already-stolen key.
- Unauthenticated `/api/device/code` row creation: bounded by the IP-counted edge limit.
- Auto-fix agent reads untrusted issue text with a write token: maintainer-only label gate with immutable ids — accepted design risk, not reproducible without maintainer action.

### Fix-PR staleness check

Re-tested the removed lines of every open fix PR against upstream `549feee`: #1, #10, #11, #12, #13, #14 all still apply (the vulnerable code is still on main), so none needs a rebase and none is obsolete.

### Round 6 addendum — payment-trigger authorization

| Control | Evidence |
|---|---|
| Off-session charge trigger is internal-only | `POST /api/stripe/auto-top-up/trigger` requires `isInternalRequest` (bearer identical to `PLN_ENTER_TOKEN`, ≥ 32 chars, constant-time compare) plus an environment match before `processAutoTopUpForUser` runs (`routes/stripe.ts:285,543`) |
| Checkout status is owner-scoped | `/api/stripe/checkout/sessions/:id` requires a session user and answers 404 unless `session.metadata.userId` matches the caller; another buyer's session is indistinguishable from a missing one |
| Pack pricing is server-side | checkout builds Stripe `price_data` from the `pollen-packs` key in the path, never from a client-supplied amount; auto-top-up re-validates the pack's USD bounds |
| Webhooks are signature-verified before crediting | `stripe-webhooks` rejects a missing `stripe-signature` with 400 and calls `verifyWebhookSignature` before any credit path; credits are keyed by `stripe_checkout_credits(session_id, user_id)` |
| Portal redirects cannot leave the app | `/billing/portal` validates `body.redirect` and constrains `body.pack` to a known pollen pack key |

Net result for round 6: two surfaces swept (enter authorization core, payment triggers), 0 new issues accepted, 6 open fix PRs confirmed still applicable to upstream `549feee`.

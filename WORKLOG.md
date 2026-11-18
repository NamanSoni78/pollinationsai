# WORKLOG — Autonomous Bug Bounty (round 3)

Round 3 continues rounds 1–2 (issues 1–8, fork PRs #1–#11). Baseline: upstream `bbccf2f5` (2026-11-17). Method: parallel subagent audits (auth/OAuth, payments/billing, gen text/audio/realtime, gen images/jobs/embeddings, apps/MCP, shared core) followed by main-agent verification — only findings reproduced by isolated unit/integration tests or non-destructive live probes (own key) are accepted. Known-issue dedup registry: issues 1–8 (see SECURITY_AUDIT.md).

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 9 | Discord OAuth state replay → account takeover (provider-agnostic state + no PKCE + trusted unverified email on callback path) | Critical | Integration test reproduced ATO on unpatched `bbccf2f5`; pinned fixed behavior + 62 auth tests green | `solution9-discord-callback-state-replay` | fork PR [#12](https://github.com/NamanSoni78/pollinationsai/pull/12) |
| 10 | Community publishers bill callers on unbounded self-reported usage (9e15 tokens → 4.5e17 pollen per response; publisher earns 75%) | High | Unit test on unpatched billing path reproduced 4.5e17 charge; clamp pinned by 5 tests + 1,105 regression tests green | `solution10-community-usage-billing-cap` | fork PR [#13](https://github.com/NamanSoni78/pollinationsai/pull/13) |
| 11 | polli web_scrape/fetch_file fetch arbitrary internal destinations from the credentialed bot container (SSRF; metadata/webhook/API/compose-net reachable) | High | Unit test with mocked aiohttp reproduced metadata-credentials fetch on unpatched code; policy pinned by 6 tests + full polli suite (211) green | `solution11-polli-scraper-ssrf-guard` | fork PR [#14](https://github.com/NamanSoni78/pollinationsai/pull/14) |
| 14 | User-media redirect hops skip the URL policy (image=/embeddings image_url/reference_audio fetch follows 302 to loopback/private/metadata — SSRF) | High | Live control probe (guard active in prod) + pre-fix code path (no redirect option, dead manual-refusal) + 12 unit tests pin hop re-validation; image/embeddings/audio suites green | `solution12-user-media-redirect-validation` | fork PR [#17](https://github.com/NamanSoni78/pollinationsai/pull/17) |
| 15 | EXIF UserComment publishes unbounded caller text (32k/request) and input media URLs on the public media host (unmoderated hosting channel + signed-URL disclosure) | High | Live PoC with own key: canary prompt in EXIF of anonymously-fetchable media.pollinations.ai object; 3 unit tests pin omission+cap; 939 image tests green | `solution15-exif-usercomment-cap-and-url-omission` | fork PR [#18](https://github.com/NamanSoni78/pollinationsai/pull/18) |
| 16 | /3d/ routes forward completely unvalidated user URLs to providers for server-side fetching (SSRF by proxy against partner networks) | Medium | Code-path analysis (no other user-media path skips validateUserMediaUrl); 3 schema-level tests pin the policy; 75 3D tests green | `solution16-3d-image-url-policy` | fork PR [#19](https://github.com/NamanSoni78/pollinationsai/pull/19) |

Additional verified design-gap finding without a code PR (policy decision required): **refunds/chargebacks never revoke granted Pollen** (`stripe-webhooks.ts` refund cases are analytics-only; `charge.dispute.created` unhandled; fraud-ban threshold needs two fraudulent disputes) — full evidence in `FINDINGS.md` R3-D1.

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

## Round 7 — session 3: MCP amplification, Discord bot spend gating, CI untrusted-content, user-image fetch deadline (2026-11-18)

Baseline: upstream `549feee` (current HEAD); fork/main verified identical (no sync push needed). Method: six parallel read-only subagent audits (payments/billing/quests, auth/OAuth/tokens, gen routes/SSRF/IDOR, media service/uploads, apps/MCP, shared core + operations/CI) against the full dedup registry (issues 1–16), followed by main-agent code verification of every candidate — only findings reproduced by isolated unit tests are accepted (live probing not needed this round; every accepted finding is pinned by tests in the repo's existing suites).

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 17 | composio-mcp `COMPOSIO_MULTI_EXECUTE_TOOL` bills + executes an unbounded `tools[]` array per single JSON-RPC call under the platform Composio key (gateway pre-flight is `requireAccountFunds(c, 0)` with zero-reserve settlement) | High | 2 new tests in `apps/composio-mcp/worker.test.js` (injectable `fetchImpl`): oversized batch rejected pre-proxy with zero billing; batch at cap bills exactly cap units — suite 10/10 | `solution17-composio-multi-execute-caps` | fork [#21](https://github.com/NamanSoni78/pollinationsai/pull/21) |
| 18 | catgpt-bot / opposite-prompt-bot answer mentions from any channel/guild, unrate-limited, spending the shared platform key per mention (1 text + up to 3 paid image gens + media upload; retry loop amplification) | High | 4 new tests per app via `createMessageHandler` injectable seam (no Discord / no paid APIs): out-of-channel mention never spends; cooldown bounds per-user spend to one billed reply per 60 s window — 4/4 + 4/4 | `solution18-discord-bots-channel-gate-cooldown` | fork [#22](https://github.com/NamanSoni78/pollinationsai/pull/22) |
| 19 | `repo-auto-fix-polli-issues.yml` interpolates the attacker-authored issue title straight into the write-capable agent prompt, with no untrusted-content wrapper/system prompt (the repo's own standard, tested on both sibling workflows), the Pollen key in job-level env, and unused `id-token: write` | High (control gap; POLLI-label prerequisite disclosed) | 2 new fixtures in `.github/scripts/polli-workflows.test.mjs` (token scoping + OIDC drop, wrapper + system prompt) — 19/19; YAML parse-validated | `solution19-autofix-workflow-untrusted-content` | fork [#23](https://github.com/NamanSoni78/pollinationsai/pull/23) |
| 20 | `fetchUserImage` bounds size but not time — no main-path caller passes `signal`, so a slow-loris image host pins a generation slot (incl. detached coordinator alarm, unbilled failures) until the ~125 s platform proxy timeout; all sibling user-media fetches already carry deadlines | Medium | 3 new tests in `gen.pollinations.ai/test/image/imageDownload.test.ts`: abort deadline wired into every fetch; stalled never-finishing host rejects with the distinct timeout error; default pinned at 30 s — 40/40 + `tsc --noEmit` clean | `solution20-user-image-fetch-timeout` | fork [#24](https://github.com/NamanSoni78/pollinationsai/pull/24) |

### Surfaces audited this round with no gate-passing finding (read-only, session 3)

- **enter payments/billing/quests/referral/promo/x402** — server-derived pack pricing, signature-verified + idempotent webhooks, transactional D1 credits, constant-time compares; every maintainer fix branch in the payments family targets code absent from main or is a feature. 0 accepted (one sub-gate observation documented: referral anti-abuse blind to non-card payment methods — bounded marketing-cost leak, fails the impact gate).
- **enter auth/OAuth/session/device/agent-run/share-account** — PKCE + single-use codes + exact redirect matching + per-client binding verified on main; all 30 hint branches either landed, target deleted paths, or are features. 0 accepted.
- **media.pollinations.ai uploads/catalog/delete/cache** — cross-tenant overwrite, stored XSS, path traversal, secret exposure all controlled (ag_-upload asymmetry and JSON base64 length cap noted as below-bar hardening by the round 5 session as issues 12/13). 0 new.
- **apps/MCP fleet beyond polli/ffmpeg/exa** — network-mcp, packages-mcp, computer-mcp, machines-mcp, floret, mama-barbara, agent-* apps cleared; all committed secrets SOPS-encrypted.
- **shared core / operations dashboards / other CI workflows** — constant-time compares, AES-GCM, no plaintext tokens, pull_request_target workflows never check out PR head.

### Parallel-session coordination notes (2026-11-18)

- This session's three fix branches (`solution12/13/14-*`, as first pushed) were **deleted from the fork mid-session by a concurrent session**; they were renumbered to `solution17-18-19-20-*` (same commits, issues 17–20) and re-pushed. Stale PR #20 was closed and superseded by PR #21. **Do not delete `solution17-*`…`solution20-*` — they carry this round's findings.**
- Upstream PR creation re-verified this session: `403 Resource not accessible by personal access token` on `POST /repos/pollinations/pollinations/pulls`. Fork PRs #21–#24 remain the live review surface until an upstream-scoped token is supplied.
- `issues_mds` was already rebased onto `549feee` by the round 5 session; this round appends issues 17–20 on top (fast-forward, no force).

## Round 8 — session 4: `pollinations-mcp` remote audio fetch memory cap, timeout, and SSRF hostname hardening (2026-11-17)

Baseline: upstream `549feee`; `fork/main` identical; all prior issues (1–20) and branches (`solution1-*` through `solution20-*`) preserved untouched.

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 21 | `pollinations-mcp` (`packages/mcp/src/services/audioService.js`) buffers uncapped remote audio via `await response.blob()` (128 MiB Worker OOM via `transcribe_audio`/`isolate_speech`/`change_voice`), omits a fetch timeout, and allows trailing-dot `localhost.` / `.local` / `.internal` / single-label intranet hostnames in `publicAudioUrl` | High | 4 new unit tests in `packages/mcp/test/audioService.test.js` (trailing-dot & internal host rejection, `AbortSignal` deadline + `Content-Length` pre-check at 25 MiB / 50 MiB, streaming reader cancellation on oversized chunked stream) — full MCP suite 46/46 passing | `solution21-mcp-audio-fetch-caps` | fork [#25](https://github.com/NamanSoni78/pollinationsai/pull/25) |


## Round 9 — session 5: Wave-2 sweep — operations/CI, packages/frontend, residual gen/apps/media (2026-11-18)

Baseline: upstream `549feee` at audit time; `fork/main` kept identical and fast-forwarded to `30ae4da` mid-session (the three new commits touch GPU image validation, polli-cli and MCP completions — none overlap this round's fixes, so no rebase was needed). Issues 1–21 and fork PRs #1–#25 untouched.

Method: five parallel read-only subagents over the never-audited Wave-2 surfaces from SECURITY_AUDIT.md — operations/ + repo CI, packages/ + the pollinations.ai frontend (including the two newest "play" commits end-to-end), gen residual/billing, apps/ residual (~60 apps, only four ever audited), media + shared residual. Strict gate as before: only high-impact findings verifiable via isolated unit tests or non-destructive probes.

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 22 | Community text-proxy responses relayed and buffered with no byte cap (media legs capped at ~28 MB, text legs uncapped and deadline-less) → publisher-triggerable isolate OOM; owner calls to their own model are free and unbilled | High (availability) | Code-path traced at `549feee` (`genericOpenAIClient.ts:595`, `responses/client.ts:161,249`, `chatClient.ts:66`, `track.ts:1570,1644-1657`, `validatedSSEStream.ts:29`); 6 isolated unit tests pin the cap incl. upstream-cancel on violation; regression `community-endpoints` 170/170 (managed-agent billing suites incl.), `generateTextPortkey`+`genericOpenAIClient` 107/107, `byop-markup`/`text-cache`/`generation-vcr` 162/162; `tsc` clean | `solution16-community-text-response-cap` | fork [#26](https://github.com/NamanSoni78/pollinationsai/pull/26) |
| 23 | Stripe refunds and lost chargebacks never reverse credited Pollen (FINDINGS R3-D1 / deferred round-1 candidate #72, now verified) | High (monetary) | Code-path traced at `549feee`; 4 integration tests over the signed webhook route (mocked Stripe API + real D1) pin exact-once reversal incl. replay, partial-refund scaling + cumulative clamp, pending/non-checkout no-ops, lost-vs-won disputes; regression `integration/stripe` 105/105, `fraud-ban`, `quests` 58/58; `tsc` no new errors | `solution17-stripe-refund-pollen-reversal` | fork [#27](https://github.com/NamanSoni78/pollinationsai/pull/27) |

> Renumber note (2026-11-18): this session first wrote its reports as `issue16`/`issue17` in parallel with sessions 3–4 registering issues 16–21; renumbered to **issue22/issue23**. The fix branches keep their `solution16-community-text-response-cap` / `solution17-stripe-refund-pollen-reversal` names and fork PRs #26/#27 are unchanged. FINDINGS **R3-D1** (refund-clawback design gap) is resolved by issue 23: the product decision it requested is implemented as debit-into-negative (the platform's documented generation-overdraft semantics), quest rewards are deliberately not reversed, and the verification it prescribed — simulate `refund.created` against a test D1 and assert balance/credit changes — is exactly the test suite shipped on the branch.

Both upstream PR creations were attempted and rejected with `403 Resource not accessible by personal access token` (same as rounds 5–8); fork PRs remain the live review surface until an upstream-scoped token is supplied.

### Surfaces reviewed this round — controls held (condensed from the five subagent reports)

| Surface | Evidence |
|---|---|
| operations/ secrets | every secret store is SOPS/age-encrypted (`ENC[AES256_GCM,…]` — economics/ingest/kpi/observability/infra-watch/model-evals/cpu); repo-wide token-pattern sweep clean; community-monitor tokens live only in the uncommitted `.env` |
| repo CI/workflows | auto-fix/askpolli maintain immutable numeric-id maintainer gates (`polli-authorization.mjs` + job `if:`); `pull_request_target` usage safe (base checkout, JSON via env, no shell interpolation of untrusted fields — `apps-publish-submissions.yml` interpolates env-var references only); PR-facing jobs hold no `secrets.*`; app review bot containerized behind iptables egress deny with model-proxy key cap |
| dashboards/monitoring | economics + KPI workers session-gated, tokens in headers not URLs; observability strips browser auth headers; infra-watch public surface is read-only `/health`, Discord delivery allowlist-mentions + digit-validated ids; investigator tools field-allowlisted, official-models-only, budget-capped |
| packages/ + frontend | zero XSS sinks (no dangerouslySetInnerHTML/innerHTML/srcdoc/postMessage anywhere; only HTML sink is static ROUTE_META through HTMLRewriter); OAuth: PKCE S256 + single-use code + origin-checked `safeReturnTo` + HMAC session with constant-time verify; API keys only in Authorization headers, credential files 0600, no plaintext key constants; react-markdown without rehype-raw; new play feature (Sonilo video SDK + prompt persistence commits) reviewed end-to-end, no sinks |
| apps/ residual MCP+agents | computer-mcp per-user Durable Object workspaces, scoped git credentials never entering the shell, output caps/timeouts/`/tmp` wipe; machines/network/research/news/packages/calculators/composio/ask-jev/apps MCP servers enforce URL policies + per-hop redirect revalidation + size caps + binding-only ingress; pr-review-fixer accepts only fine-grained PATs and pushes to caller forks; pi-workbench PKCE + path-traversal guard; no plaintext secrets repo-wide; #122 (`agents:false`) re-verified as belt-and-suspenders, not a bug |
| media + shared residual | media ids unguessable/owner-namespaced, no traversal (flat keyspace, charset-validated); other metadata channels closed (SVG forced attachment, nosniff+CSP set last, header replay trusted-put only); all image fetch sites funnel through `validateUserMediaUrl`; Tinybird public pipes aggregate-only; community listing hides owner ids/PII/base URLs; billing writes single-statement atomic, exactly one settlement per request; gen↔media internal API is service-binding only |

### Candidates rejected (recorded, not submitted)

- community-monitor runs `claude --dangerously-skip-permissions` with untrusted Discord message text as its primary input: probabilistic LLM prompt-injection with a documented design; hardening recommendation (scope the `Bash` tool, add an untrusted-content rule to CYCLE.md), below the reproducibility gate. (Session 3 subsequently shipped a scoped-permissions hardening branch, `solution12-community-monitor-scoped-permissions` — complementary, no overlap with an issue here.)
- `validateUserMediaUrl` misses non-dotted-quad IPv4 encodings and `.local` names: the bypassed destination space is unroutable from Workers; fold a tighter parser into the PR #17 hop validator rather than filing separately.
- `app.json` `url` has no scheme check in `validateApps` (only `screenshotUrl` does) while the site renders it as a raw href: requires a maintainer-merged malicious edit; one-line hardening.
- Billing fail-open on settlement infra failure, and reservation stranding on mid-settlement reconcile failure: operational resilience, not attacker-forcible.
- Mutable major-version action pins and `?key=` in the Play API example: hardening/documentation only.

### Sync

- `fork/main` fast-forwarded `549feee` → `30ae4da` mid-session (no force needed; upstream moved with three commits unrelated to this round's fixes). `issues_mds` appends this round additively on top of sessions 3–4 (rebase, no history rewrite, no branch deletions).

## Round 9 — session 5: non-text community billing clamp, bot-fleet spend gating, Klein validation, fallback dimension policy (2026-11-18; renumbered issues 26-29)

Baseline: upstream `30ae4da` (fork/main fast-forwarded to it, 0 ahead / 3 behind, clean FF). Method: five parallel read-only subagent audits (image pipeline incl. the new #18202 commit, text billing integrity, community publisher flow, uncleared apps fleet, packages + website) against the full dedup registry (issues 1–21), then main-agent code verification of every candidate — only findings reproduced by isolated unit/e2e tests are accepted. Four findings passed the gate.

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 26 | Community **non-text** modalities bill unbounded publisher-self-reported usage (video `usage.duration` any positive number → $1.8M pollen in one request at the $0.5/s ceiling; transcription/speech seconds; image tokens; embeddings prompt tokens), with the owner earning 75% of the claim — the #18516 clamp is text-only and its commit notes "embeddings and media proxies are not covered" | High | 14 new cases in `gen.pollinations.ai/test/tracking-observability.test.ts` (each meter over/at ceiling via media-typed responses; embeddings case moved from "still bills" to rejected; official veo + agent controls) — file 132/132, tsc clean | `solution22-community-media-usage-clamp` | fork [#30](https://github.com/NamanSoni78/pollinationsai/pull/30) |
| 27 | `discord-bot-family` (production EC2 fleet, 5 bots on the shared `TEXT_POLLINATIONS_TOKEN`) answers every human mention/reply/DM/conversation-channel message with a paid completion — the sole rate limit excludes directed traffic ("Human mentions and DMs: always respond"); the issue-18 class in the one bot app it was never applied to | High | 5 new `node:test` cases via the injectable `generateText` seam (rapid DMs spend once then re-arm; per-user/per-bot budgets; convo-channel gating; ambient never spends); tsc clean | `solution23-discord-family-spend-gating` | fork [#31](https://github.com/NamanSoni78/pollinationsai/pull/31) |
| 28 | Klein (4th self-hosted GPU backend, `flux.2-klein-4b`) missed by the #18202 completeness validation — truncated 200 bodies were cached to R2 and billed flat $0.005 with zero checks; PNG re-encode protection is fragile (Images binding passthrough, JPEG no-op) | Medium | 2 new e2e cases in `klein-e2e.test.ts` (truncated PNG → 502 unbilled uncached, retries re-reach backend; non-image body → 502 unbilled) — file 7/7, tsc clean | `solution24-klein-response-validation` | fork [#32](https://github.com/NamanSoni78/pollinationsai/pull/32) |
| 29 | No schema max on width/height; the pool workers' caps (z-image 422 above 2,359,296 px; flux clamp at 810,000 px) never run when the pool itself 503s → raw dimensions forward to per-area-billed fal/DeepInfra at the flat quote (4096² z-image = ~21× subsidy loss; precondition = documented 2-day pool outage class) | Medium | 4 new `zImageFalModel.test.ts` cases (oversize/undersize rejected 422 pre-fetch, cap-exact served) + 2 new `prunaModel.test.ts` cases (4096² clamped under 810k px aspect-kept, sub-cap untouched) — 19/19 + fluxFallback regression 18/18, tsc clean | `solution25-fallback-dimension-policy` | fork [#33](https://github.com/NamanSoni78/pollinationsai/pull/33) |

> Renumber note (2026-11-18): a concurrent session-5 sweep registered its findings as issues 22 (community text-proxy unbounded response, fork PR #26) and 23 (Stripe refund/dispute Pollen reversal, fork PR #27) on `issues_mds` while this session's four reports were being written. This session renumbers its own reports 22–25 → **26–29** (content unchanged); the fix branches keep their `solution22-*`…`solution25-*` names and fork PRs #30–#33 are unchanged — the same convention rounds 3–5 used for the 12/13/14 collisions.

### Surfaces audited this round with no gate-passing finding (5 parallel subagents, read-only)

- **Text billing integrity (gen text core)** — all five text paths force provider usage through non-negative zod schemas; no negative-charge path exists; streaming billing survives deliberate disconnect (tee + waitUntil, offline web-streams PoC); cache identity (e013337f29) introduces no new cross-identity leak beyond dedup'd issue 1; model resolution exact-match first-wins; community→static fallback pricing rejection verified; owner self-calls zero end-to-end; search billing counts provider-reported invocations. 0 accepted (issue-10 text-clamp completeness confirmed; the non-text remainder is issue 22 above).
- **Community publisher flow (enter + gen)** — registration URL validation solid (HTTPS-only, credential/embedded-IP/private-range block, re-applied per gateway request); every publisher fetch uses `redirect: "manual"`; internal infra unreachable (service bindings not fetch-addressable, `global_fetch_strictly_public`); IDOR solid (owner-scoped WHERE clauses); no model shadowing (name regex can't forge `community/` ids); allowlist enforced on every write; only the publisher's own token is forwarded (AES-GCM encrypted at rest); earnings min-clamped to the charge and suppressed on negative payer balance. 0 accepted beyond issue 22 (self-loop amplification bounded by the no-timeout issue already dedup'd as its precondition; catalog impersonation is a moderation gap).
- **Uncleared apps fleet (19 apps)** — news/research/calculators/ask-jev MCP servers bounded and SSRF-guarded; discord-agent-osaii-swarm BYOP with per-user context; roblox apps use creator-supplied keys with in-flight locks; pi-workbench strict host bridge; gimp/krita plugins clean (offline suites 11/11 each); Pages apps BYOP or anonymous-tier only; zero hardcoded secrets in the fleet (SOPS ciphertext intact). 0 accepted beyond issue 23.
- **packages/ + pollinations.ai site** — mcp services URL-joined and capped; sdk header-auth only with PKCE+state OAuth; polli-cli 0600 credentials, stdin-passed secrets, array-args shell-outs; auth package HMAC+AES-GCM sessions; no dangerouslySetInnerHTML anywhere; no key-in-URL in site code (the Playground GET example teaching `?key=` is documentation, noted below). 0 accepted.
- **Image pipeline adjacent commits** — 8fd48101e8 (transparent), 4d6aab68cd (HEAD model resolution), 95a49d12e1 (megapixel preflight) all verified clean; the new pool JPEG validation itself is sound (offline reimplementation rejects every truncation form); billing is strictly post-validation with reservation release on throw. 0 accepted beyond issues 24/25.

### Leads recorded (below gate, for future rounds)

- Pre-fix R2 cache residue: truncated GPU images cached before `30ae4da` persist until a `cacheVersion` bump — one-time sweep of MEDIA objects whose last bytes aren't `FF D9`/IEND.
- The video preflight under-reservation (seedance 30s ≈ 29 pollen reserved at 1-second cost) remains code-verified but not live-testable with a `questPollenOnly` key (all per-second models are `paidOnly`).
- `POST /account/agents/:id/sync` unauthenticated by design (deploy-churn only); apps-directory URLs rely on framework-level `javascript:` blocking; ai-dungeon-master persists the user's `sk_` key in localStorage (user-impact hygiene).

### Sync

- `fork/main` fast-forwarded `549feee` → `30ae4da` (0 ahead / 3 behind; no force needed). `issues_mds` appends issues 26–29 additively (renumbered from 22–25 after the concurrent session-5 collision); no existing branches touched (solution1–21 and the concurrent session's solution16/17 all preserved).
- Upstream PR creation still returns `403 Resource not accessible by personal access token`; fork PRs #30–#33 are the live review surface until an upstream-scoped token is supplied.

## Round 10 — session 6: deep billing/auth/media remediation (2026-11-18)

Baseline: upstream `549feee95b` (fork/main verified identical, 0/0). Method: seven parallel read-only subagent audits (billing/credits, auth/OAuth/keys, gen text/audio/realtime, gen media/image/jobs/uploads, community platform, apps/MCP fleet, wave-2 operations/packages/frontend) against the full dedup registry (issues 1–29), followed by main-agent verification under this round's gate: every accepted finding reproduced by an isolated unit/integration test against real modules (only upstream transports mocked, no production calls). Six findings passed.

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 24 | community-monitor agent runs with `--dangerously-skip-permissions` + bare `Bash,Read,Write` while three live tokens ride its environment and its context is fed by attacker-controlled Discord messages and community-model probe output (prompt injection → host RCE as `ubuntu` + spend-key/analytics/bot-token exfil) — the hardening round 9 recorded as below-its-gate, here reproduced deterministically | Critical | 8/8 config assertions + real `probe.mjs` data-flow PoC (attacker model output → `probe-results.json` → self-approving agent with all tokens in env); new `hardening.test.mjs` 7/7 | `solution12-community-monitor-scoped-permissions` | fork [#28](https://github.com/NamanSoni78/pollinationsai/pull/28) |
| 25 | Post-paid failures on the fal-queue media legs throw without `billedUsage` (MiniMax H3 poll-timeout + no-video, Kling no-video, grok:fal missing duration, Sonilo no-audio) — fal bills the platform, the caller is charged nothing | High | Real-module PoC (5 unbilled instances vs 1 billed control); new `fal-queue-billed-usage.test.ts` 7/7 + 128 regression tests green | `solution14-fal-queue-billed-usage-on-failures` | fork [#34](https://github.com/NamanSoni78/pollinationsai/pull/34) |
| 30 | x402 prepaid keys are unrevokable: the purchase-row FK makes the only revoke path 500 (`INTERNAL_ERROR`) and the leaked key stays `valid: true` forever | High | Real worker + real D1 PoC; new `x402-key-revocation.test.ts` (revoke 200 → rows gone → raw key 401) | `solution15-x402-key-revocation-fix` | fork [#35](https://github.com/NamanSoni78/pollinationsai/pull/35) |
| 31 | `atomicAdjustApiKeyBalance` has no floor: settlement drives finite key budgets unbounded negative (0.01-budget key → −2.69; 1.0-budget → −28.10 in one request) while the reserve path keeps its guard | High | Real-function PoC (B0/B1/B3 asymmetry); new `billing-apikey-settle-floor.test.ts` 4/4; one existing expectation updated to the new contract; 148 tests green | `solution16-api-key-settle-floor` | fork [#36](https://github.com/NamanSoni78/pollinationsai/pull/36) |
| 32 | Pre-flight estimates under-reserve per-second models 3–30× (one second's rate or the Tinybird average as the whole-request estimate; a cold Tinybird reserves exactly zero) — the lead round 9 recorded as not live-testable, here verified by isolated unit tests | High | Pure-function PoC on the real registry model (`bytedance/seedance-2.0`); new `request-estimate-upper-bound.test.ts` 6/6 + `byop-markup` 41/41 | `solution18-request-estimate-upper-bound` | fork [#37](https://github.com/NamanSoni78/pollinationsai/pull/37) |
| 33 | The polli login written into every E2B sandbox never expires (`expiresIn` absent → `expires_at: NULL`), surviving the ≤24 h box in snapshots and envd listings with `profile`/`usage`/`machines` permissions | Medium | Real-route PoC (request has no expiry; 1 s control key retired while the sandbox key never is); new `e2b-sandbox-key-expiry.test.ts` + 31 e2b tests green | `solution19-e2b-sandbox-key-expiry` | fork [#38](https://github.com/NamanSoni78/pollinationsai/pull/38) |

### Independently verified but delivered concurrently (cross-references only, no duplicate PR)

- **community text-family response bodies unbounded** — this session measured the same root cause as issue 22 (30 MiB body → ≈123 MiB isolate RSS across the pipeline copies) and shipped a second fix as PR #29 before detecting the collision; **PR #29 is closed as a duplicate in favor of session-5's PR #26** (first delivered). The measurement remains useful corroboration: the unbounded legs are chat-completions, the responses adapter, embeddings (including unbounded vector length when `dimensions` is omitted) and transcription, plus the `createCaptureStream` R2-capture amplifier.
- **umbrella MCP `transcribe_audio`/`isolate_speech`/`change_voice` unbounded timeout-less source fetch** — this session's PoC (131 MiB buffered, no cap, `signal` undefined) independently confirmed issue 21 / PR #25; no duplicate filed.
- **Stripe refunds never reverse Pollen** — this session's PoC (refund.created 200 with zero DB writes; charge.dispute.created unhandled) independently confirmed the gap; a second full implementation (migration + handler + 4/4 integration tests) was built and then discarded on detecting the name collision with session-5's branch — their PR #27 stands.

### Parallel-session coordination notes (2026-11-18)

- Name collisions are now checked before every push (`git ls-remote fork 'refs/heads/solution*'`); this session's `solution18-request-estimate-upper-bound` and `solution19-e2b-sandbox-key-expiry` coexist with the other sessions' `solution18/19/20-*` branches (full names differ).
- No existing branch was deleted or force-pushed by this session; the discarded `solution17-stripe-refund-pollen-reversal` work was dropped locally only.
- Upstream PR creation re-verified this round: `403 Resource not accessible by personal access token`; fork PRs #28/#34–#38 are the live review surface until an upstream-scoped token is supplied.
- `fork/main` stayed identical to upstream `549feee` all round (no sync needed); `issues_mds` appends this round additively on top of sessions 3–5 (rebase, no history rewrite).


## Round 11 — session 7: new-commit diff-audit (GPT-6.2 Astra/Sol, messages truncation) + deferred-lead graduation (2026-11-18)

Baseline: upstream `6538ea2721` (2 new commits since round 9's `30ae4da`: `aca5490521` messages max_tokens truncation, `6538ea2721` GPT-6.2 Astra/Sol + Bedrock fallback). Sync: `fork/main` verified already identical to upstream HEAD (`0/0`, fast-forwarded by a concurrent session — no push needed); `issues_mds` rebased onto round 10's head before appending this round. Method: three parallel read-only subagent audits — (A) full diff-audit of the GPT-6.2 commit with four billing hypotheses, (B) full diff-audit of the messages-truncation commit with five regression hypotheses, (C) verification of every deferred lead recorded in rounds 9-10 — followed by main-agent verification; only findings reproduced by isolated unit tests against the real modules are accepted.

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 34 | GPT-6.2 Astra (introduced in `6538ea2721`) and pre-existing GPT-6 Astra accept image input on the Azure Responses routes but their cost sheets omit `promptImageTokens`; the usage pipeline carves `image_tokens` out of `promptTextTokens` (inclusive Azure convention) and `convertUsage` zero-fills the rate-less line — every vision request on these paidOnly models bills its image tokens at $0 (~$0.06-0.36 forgone per request at 10 reference images), while #19981 added the rate to sibling gpt-6.2-sol **in the same commit** | High | 2 new tests in `generateTextPortkey.test.ts` (base tier: exact carve-out {600 text, 400 image} bills image > 0 on both astras; long-context: 300K prompt selects `long_context` and bills image at $16/M x 0.75) — both red on unpatched registry; file 33/33, full gen `test/text/` 957/957, aliases 481/481, effective-prices snapshot updated (+12 lines incl. `:aws` fallbacks), `tsc` clean | `solution30-gpt62-astra-image-token-billing` | fork [#39](https://github.com/NamanSoni78/pollinationsai/pull/39) |
| 35 | Per-second preflight under-reservation — same vulnerability as issue 32 (concurrent session-6, PR #37), independently verified from the round-9 lead with two additional findings: (a) the `isFlatRateModel` eligibility gate (`category === "image" && …`) makes `getDefinedRequestEstimate` return null for **every** video/audio per-second model, so a Tinybird-cold model preflights at exactly $0 (worse than issue 32's 1-second reading); (b) the fix can size to the **requested duration** instead of the worst case | High (duplicate of 32, cross-referenced) | 2 new tests in `byop-markup.test.ts` (estimate scales 1s/$0.18, default 5s/$0.90, requested 15s/$2.70; sfx default $1.20; megapixel stays unit-shaped; believable Tinybird median still wins; e2e `checkBalance` 402s the 15s request for a $0.50 wallet/key the old estimate admitted, still serves an affordable 5s) — both red on unpatched main; byop-markup 43/43, realtime+tracking 163/163, billing-deduction+image 976/976, `tsc` clean | `solution31-per-second-preflight-reservation` | fork [#40](https://github.com/NamanSoni78/pollinationsai/pull/40) |

### Issue 35 collision handling (2026-11-18)

Session 6 registered the per-second under-reservation as **issue 32 / PR #37** (worst-case `rate x maxDuration` bound) while this session's fix was being built. Per the round-10 coordination convention both PRs are preserved with cross-reference comments posted on [#37](https://github.com/NamanSoni78/pollinationsai/pull/37) and [#40](https://github.com/NamanSoni78/pollinationsai/pull/40): #40 is the duration-precise alternative (no false rejections of sub-maximum requests — a $1.00 wallet gets its 5s/$0.90 render instead of being refused on the 15s/$2.70 worst case), additionally fixes the eligibility gate that leaves #37's `getDefinedRequestEstimate` multiplier unreachable for video/audio models, and plumbs the validated duration from both the GET query and the `.passthrough()` POST image body. The wallet-overdraft half of the impact is additionally addressed by session 6's issue 31 / PR #36 (settle floor). Maintainers can take either #37 or #40; they replace the same three functions.

### Audited clean this round (no gate-passing finding)

- **`aca5490521` messages truncation (AUDIT-B, all five hypotheses NOT-A-BUG):** the silent drop of truncated tool_use is documented in-source, schema-valid, and strictly safer than the removed 502/error-event path (which was retry-amplifying, i.e. re-billed); no settlement or tool-execution consumer keys on the old `finish_reason: "tool_calls"` rewrite (settlement uses usage headers; the repo's agent loop maps `length` to a loop stop — spend-reducing); billing is settled on the inner Chat Completions dispatch from provider-reported usage regardless of dropped blocks (pinned by the committed "bills like Chat Completions" test); a malicious community publisher gains no capability (they already control `tool_calls` outright, and the pre-fix 502 path was strictly better for them). One below-gate nit recorded: a complete zero-argument tool call (`arguments: ""`) is dropped when truncation occurred elsewhere in the same response.
- **GPT-6.2 commit, non-findings (AUDIT-A):** long-context tier selection is provider-usage-driven (`totalPromptTokens` over reported buckets, settlement-side only, selector errors fall back to base rates); `paidOnly` gating is airtight for the `:aws` variants (`fallbackOnly: true` rejects direct addressing, list addressing, key permissions, and community adoption; quest-Pollen keys have `packBalance` zeroed); the `:aws` fallback correctly inherits the 0.75 multiplier (snapshot-pinned; the missing explicit `priceMultiplier` only affects internal telemetry); `aliases.test.ts` Azure-multiplier policy compliant. One functional risk noted for maintainers, not verifiable offline: the new Bedrock configs use `us.openai.*` region IDs while all ten siblings use `global.openai.*`.
- **Deferred leads re-verified (AUDIT-C):** pre-fix R2 cache residue remains below-gate operational (write path fixed by #18202; residue is prod data — recommended one-time sweep of `keyType:"generation"` objects whose last bytes aren't `FF D9`/IEND, or a `cacheVersion` bump; aggravator: cache HITs ≥15 days old rewrite the object, resetting R2 lifecycle age so popular poisoned entries never expire); `POST /account/agents/:id/sync` unchanged and still below-gate (UUID ids not enumerable, sync deploys stored payloads only, 30s throttle); **ai-dungeon-master `sk_` key lead is STALE** — sessionStorage (not localStorage) since #9017, `sk_`-only since #18933; FINDINGS.md registry has no unresolved entry uncovered by issues 1-33.

### Surfaces with the astra omission NOT fixed (recorded, below the minimal-patch line)

The registry-wide scan found 53 of 93 image-input text models without `promptImageTokens`; all models **known** to report split image tokens on their routes (the Azure Responses family: sol x3, grok x4) price it except the two astras (issue 34). The remainder (claude via Anthropic usage — no `prompt_tokens_details`; gpt-5.x/gemini/qwen etc.) could not be confirmed to report split image tokens from repo evidence alone — an invariant test ("every image-input model defines an image rate") would fail 53 models today, so the patch stays scoped to the evidenced lineage.

### Sync

- `fork/main` already at `6538ea2721` (0/0 vs upstream — synced by a concurrent session; no push from this session).
- `issues_mds` appends issues 34-35 and this round additively on top of round 10 (`458cf198ae`); no existing branch touched (`ls-remote` checked before push — `solution30/31-*` names are unique; session 6's round-10 branches are `solution12/14/15/16/18/19-*`).
- Upstream PR creation re-verified this round: `403 Resource not accessible by personal access token`; fork PRs #39-#40 are the live review surface.

### Round 11 addendum — mid-session upstream movement (2026-11-18)

Upstream moved twice more while this round's fixes were being verified: `a7aed04e24` (APIDOCS.md regeneration, no security surface) and `5bdb82327b` (Microsoft-Decision-1.1 on Azure, #19988). Diff-audit of the latter against this round's bug classes: **clean** — text-only modality (no astra-class image-rate omission; a `hasImagePart` 400-guard in `systemOneClient.ts` covers the primary and both fallback ids via `split(":")[0]`), token-priced with no per-second fields (no preflight class), `paidOnly: false` + tier-gated like its sibling decision-1, fallback cost sheets (Vercel list / OpenRouter +5.5%) are a documented pricing decision. `fork/main` fast-forwarded `a7aed04e24 → 5bdb82327b` (0 unique commits, no force). Fix branches `solution30/31-*` are based on `6538ea2721`; neither commit touches their files (verified: `git merge-tree` clean vs both), so no rebase is needed.

## Round 12 — session 8 (cron job 535555): five-surface parallel audit — stem-separation exact gate, GPT-6.2 AWS multiplier, x402/video companions (2026-11-18)

Baseline: upstream `6538ea2721` at session start (`fork/main` fast-forwarded `aca5490` → `6538ea2` and pushed; concurrent sessions then advanced it to `5bdb823`, diff-audited clean by session 7's addendum). `issues_mds` rebased onto round 11's head (`31e3ed7`) before appending. Method per the job spec: five parallel read-only subagent audits — (A) the `6538ea2` GPT-6.2 commit + text registry/fallback billing blast radius, (B) preflight estimation/reservation vs settlement across all modalities, (C) deferred auth/x402/consent/E2B re-check, (D) recent-commit sweep (~25 commits), (E) residual media/community/MCP sweep — then main-agent code verification of every candidate; only findings reproduced by isolated unit/integration tests against real modules/D1 are accepted. Two prior-round rejections were re-confirmed as fixed elsewhere: the MCP audio `source` fetch deadline is already shipped on `solution21` (fork), and the `validateUserMediaUrl` sonilo sink stays the recorded below-gate lead.

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 36 | Stem separation admits on the historical mean (or $0 for a Tinybird-cold model) while the bill is the **parsed upload duration** at the variation's rate — computed before dispatch, never gated: 50 MB @ 32 kbps ≈ 13,107 billed seconds ≈ **65.5 pollen** of ElevenLabs spend admitted at $0.01 balance; same family as issues 32/35 but a distinct root site (the exact charge is known pre-execution) | High | 5 new gate cases in `stem-separation.test.ts` (variation-rate arithmetic incl. the 13,107 s worst case via `calculateUsageBilling` over the real registry; 402 below / admission above the exact charge; key-budget-first refusal; unauthenticated skip); the 13 original route-level e2e cases unchanged and green — 18/18 | `solution32-stem-separation-exact-funds-gate` | fork [#41](https://github.com/NamanSoni78/pollinationsai/pull/41) |
| 37 | `6538ea2` added `openai/gpt-6.2-astra/sol:aws` fallback routes without `priceMultiplier: 1` — the only OpenAI→AWS fallbacks (of ten) missing it; `mergeFallbacks` inherits the **0.75 Azure discount onto the AWS list sheet**: the canonical `effective-prices` snapshot now documents 0.75× for the Bedrock routes and `servedPrice` under-reports every Bedrock-rescued 6.2 request by 25% (callers keep the Azure quote; cost accounting unaffected). Session 7 had assessed the inheritance as telemetry-only below-gate; this round promoted it — the sibling-invariant `it.each` also missed the 6.2 pair, which is how it slipped past the suite, and the snapshot is the repo's rate-change review artifact | Medium | New `it.each` for the paid-only 6.2 pair in `static-provider-fallbacks.test.ts`: `priceMultiplier` 1, caller price = list × 0.75, `servedPrice` = full AWS list — **red pre-fix (0.75 to 1, reproduced)**, green after; snapshot regenerated (9 rows, both `:aws` sheets 0.75×→1×); `static-provider-fallbacks`+`modelResolver` 260/260, enter snapshot+`cost-variants` 73/73, `tsc` clean | `solution33-gpt62-aws-fallback-multiplier` | fork [#42](https://github.com/NamanSoni78/pollinationsai/pull/42) |
| 38 | x402 prepaid key revocation — **companion to issue 30 / PR #35**: the independent real-D1 verification reproduced the identical 500, and this branch ships the schema-level variant issue 30's report recommends, which preserves the purchase audit row + `encrypted_key` (support's key-recovery path for revoked keys, which PR #35's row deletion removes) and unblocks `delete-user` for the holding account | High (same vulnerability as 30; cross-referenced) | Integration test over the real D1 + real migration stack: DELETE on a credited prepaid key → **500 pre-fix (reproduced)** / 200 post-fix; revoked key 401; purchase row survives with `key_id` null + non-empty `encrypted_key`; repeat DELETE → 404; `x402-keys`+`account-keys` 49/49 | `solution30-x402-key-revocation-fk` | fork [#43](https://github.com/NamanSoni78/pollinationsai/pull/43) |
| 39 | Per-second preflight residual — **companion to issues 32/35**: (a) model-picked output length has no request duration to thread — seedance-2.5 adaptive reference-video edits (documented default) bill up to 30 × $0.9676 ≈ **29.03 pollen** while duration-precise fixes resolve `defaultDuration` = 4 at the base rate (still ~70× under-reserved; the 30 s ceiling lives only in the schema doc text, not the registry); (b) estimates price the **base** sheet while settlement prices the request's variant (`video_in_720p` $0.9676/s vs base $0.1028/s — 4–9.4×). New registry field `adaptiveMaxDuration` + variant-selector-aware worst-case gate + billing clamp close both | High (residual of 32/35; cross-referenced) | 12 new assertions in `byop-markup.test.ts` (adaptive 30 × 0.9676 = 29.028 and 480p 30 × 0.4304 = 12.912 bounds; mean never lowers the bound; 402 at $0.01 vs resolve at $30; explicit-duration 4 s keeps its own tight bound 4 × 0.1028) + adaptive clamp case in `seedance25VideoModel.test.ts` (60 s report → 30 s bill); `byop-markup` 51/51, `test/image/` **953/953** (48 files), route e2e 314/314, `tsc` clean | `solution31-video-persecond-preflight-worstcase` | fork [#44](https://github.com/NamanSoni78/pollinationsai/pull/44) |

### Collision handling (2026-11-18)

Sessions 6–7 (rounds 10–11, running concurrently with this job) registered issues 24–35 while this session's fixes were being built, including the x402 revocation (issue 30 / PR #35) and the per-second preflight (issues 32/35 / PRs #37/#40) root causes this session also verified. Per the round-10/11 coordination convention: the earlier-filed reports own the issue numbers; this session's findings 38/39 are filed as **companion cross-reference reports** (the issue-35 pattern) documenting the additional root causes/paths the merged fixes leave open (issue 38: audit-row preservation + `delete-user`; issue 39: adaptive output length + variant-aware rates). Branch names keep their `solution30/31` prefixes (checked unique on `ls-remote` before push — session 7's round-11 branches `solution30-gpt62-astra-image-token-billing` / `solution31-per-second-preflight-reservation` were already up); all prior branches untouched. Maintainers can take either of each mutually-exclusive pair: #35 vs #43, and #37/#40 vs #44 (issue 39's adaptive bound can also be folded into either).

**Merge note:** PR #42 and session 7's PR #39 both regenerate `enter.pollinations.ai/test/__snapshots__/effective-prices.snapshot.test.ts.snap` (different rows: #39 adds the astra `promptImageTokens` sheets, #42 fixes the `:aws` multiplier rows). The file will conflict textually if both merge; re-running `vitest run test/effective-prices.snapshot.test.ts -u` after merging either resolves it deterministically.

### Candidates rejected this round (recorded, not submitted)

- **Consent-endpoint CSRF (original tracker #87)** — impact has shrunk below the gate: Better Auth session cookies default to SameSite=Lax, every key-management route is Bearer-only (the dashboard's `sess_` mint), and every CSRF-reachable field of `POST /api/oauth/code`/`/api/device/approve` is attacker-known data with no path to a victim secret (CORS `origin:"*"` without credentials blocks response reads; PKCE + single-use code + exact-match redirect binding verified on both OAuth twins). Defense-in-depth `Origin` check on the consent endpoints recorded as a hardening item (the sibling `product-analytics.ts:32` has one).
- **E2B never-expiring keys (original #95)** — no issuance/rotation/expiry code exists in-repo to patch (`E2B_API_KEY` is a static sops-encrypted ops credential consumed only by `routes/e2b.ts:163-166`); rotation is an E2B-dashboard + sops + `wrangler secret` procedure. (Session 6 filed the separate `e2b-sandbox-login-never-expires` angle as issue 33.)
- **MCP audio `source` fetch without deadline** — already fixed on the fork by issue 21's branch (`SOURCE_FETCH_TIMEOUT_MS = 30_000` applied with `AbortSignal.timeout` in `fetchPublicAudio`); upstream-pending, not re-filed.
- **`canGrantKeysByLink` enforced frontend-only; unauthenticated `POST /account/agents/:id/sync`; `PATCH /keys/:id` `redirectUris` on secret keys; non-constant-time admin export compare; `GET /device/info` status disclosure; Stripe checkout top-level link; `preparePurchase` double-failure orphan** — all traced and found unexploitable or below the gate (delegation chain blocks the redirect-grant path; sync is throttled+pinned; no consumer accepts a non-`pk_` client_id; SHA-256 hex compare is no timing oracle; Crockford codes behind the edge limiter; victim pays their own cart; compensating-delete failure requires simultaneous D1 faults).
- **Video preflight as a *wallet-overdraft* bug independent of issues 32/35** — rejected as duplicate root cause; the wallet ladder's debit-into-negative is documented intended semantics ("completed work is never free"), and the knowable-bound half is now covered by issues 32/35/39.
- **Round-2's `/v1/messages` query-string finding re-check** — still not a bug (`?key=` authenticates; the subagent report was wrong about the auth chain, as verified live in round 2).
- **Stem audio `conditioning_ref`/`song_id` cross-user reuse; GIF/input bounds; Gemini embeddings fan-out; `mediaResponses` streaming envelope; elevenlabs music re-upload; fal 3-D queue poll** — audited clean this round (details in the session's rejected-candidates log): opaque unguessable ids returned only to the storing user; frame/duration/char/seed/batch bounds all enforced; per-hop revalidation present; fal polls execute inside the coordinator's 300 s zone timeout.

### Sync

- `fork/main`: fast-forwarded `aca5490` → `6538ea2` and pushed at session start; a concurrent session then advanced it `6538ea2` → `5bdb823` (verified present via `ls-remote`; this session's four solution branches are based on `6538ea2` — one commit behind, no overlap with `5bdb823`'s files except the noted snapshot regen).
- `issues_mds`: rebased onto `31e3ed7` (round 11 addendum) before appending issues 36–39 and this round; pushed additively, no history rewrite, no branch deletions (`ls-remote` checked before every push).
- Upstream PR creation re-verified this round: `403 Resource not accessible by personal access token` (attempted first, per the job spec); fork PRs #41–#44 are the live review surface until an upstream-scoped token is supplied.

## Round 13 — session 9 (cron job 535549): error-completion integrity sweep + community clamp direction (2026-11-18)

Baseline: upstream `a7aed04e24` (fork/main fast-forwarded and pushed; concurrent sessions later advanced it to `b4d7ebcb` — the three intervening commits (Azure content moderation restore, MAI Image 2.7 Flash, quest-categories cleanup) diff-audited with no overlap with this round's fix sites). Method: five parallel read-only subagent audits — (A) the finish_reason-error invariant's coverage after #19584/#19796/#19778, (B) the GPT-6.2 Bedrock commit blast radius, (C) text billing integrity/usage trust, (D) enter authz/x402/quest re-sweep, (E) apps/CI/packages/frontend — then main-agent verification: every accepted finding was reproduced by isolated unit/worker tests against real modules **before** the fix was written (red→green), matching the upstream test pattern for its own error-completion fixes. Issues renumbered 40–44 (34–39 were registered by concurrent sessions 6–8 while this session's fixes were being built; branch names keep their solution34–38 prefixes — the round-12 convention).

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 40 | The text cache stored HTTP-200 **error completions** as immutable TTL-refreshing HITs: the write guard only recognized SSE protocol errors — JSON bodies always cached, nested `choices[].finish_reason:"error"` never scanned (the chat contract's own 200-pass-through shape). Cache hits skip auth/rate limits/billing; SDK/CLI/MCP error-rejecting callers replay the same cached failure forever | High | 6 new cases in `test/text-cache-finish-error.test.ts` (JSON/SSE-nested/Responses-failed → HIT pre-fix, reproduced; normal + max_tokens-truncated controls still cached) | `solution34-text-cache-finish-error-gate` | fork [#45](https://github.com/NamanSoni78/pollinationsai/pull/45) |
| 41 | `/v1/messages` translated `finish_reason=error` into a normal `end_turn` turn (non-stream `stop_reason`, stream `message_stop` without any error event; nested `choice.error` dropped): Claude Code/Anthropic SDK consumers get half-finished work as complete with **no protocol field carrying the failure**; compounds issue 40 (the inner chat completion is the cached entry) | High | 5 new cases in `test/text/messages-finish-error.test.ts` incl. a full worker-level `POST /v1/messages` route case (200 `stop_reason:"end_turn"` with partial content pre-fix, reproduced) | `solution35-messages-finish-error-stop-reason` | fork [#46](https://github.com/NamanSoni78/pollinationsai/pull/46) |
| 42 | The plain-text content routes (`POST /text`, `GET /text/:prompt`) served error completions as unmarked 200 text/plain (the marker is destroyed — no error channel in the protocol); anonymous-tier surface, and the same 200 body becomes the cache entry | Medium-High | 3 worker-level cases in `test/text/content-error-completions.test.ts` (200 "partial answer" pre-fix, reproduced; chat JSON marker contract control unchanged); full `test/text/` 958/958 | `solution36-text-route-error-completions-502` | fork [#47](https://github.com/NamanSoni78/pollinationsai/pull/47) |
| 43 | Managed prompt-agent runs billed errored completions as success: `@ai-sdk/openai-compatible@3.0.30` maps raw `finish_reason:"error"` → `"other"` and `openAIFinishReason` maps `"other"` → `"stop"`, so the run resolved with partial output and `strictAgentUsage` charged the failed step's tokens (the missing consumer of #19399/#19584/#19796) | Medium | 3 new cases in `test/agent-model-finish-error.test.ts` on the real provider + `ai` package (non-stream/stream error completions resolve pre-fix, reproduced); one-line mapping probe `openAIFinishReason("other")==="stop"` | `solution37-agent-model-finish-error-gate` | fork [#48](https://github.com/NamanSoni78/pollinationsai/pull/48) |
| 44 | The implausible-usage clamp **zero-bills honestly-reported over-ceiling generations** — caller-forcible free service: no server-side max on `max_tokens` (250,001 honored → ~$12.5 of generation free at the $50/1M registration max) and 32 MiB prompts carry ≫2M tokens while the advertised community context ceiling (10M) is 5× the billing ceiling (2M); publisher pays 100% of compute, platform keeps none of its cut | High | 6 new cases in `test/community-proxy-request-gates.test.ts` on the real capability check + community fixture (completion budget 200,001/250,001 accepted pre-fix across all three key spellings, reproduced; prompt 2.25M tokens accepted pre-fix); billing side pinned by the repo's own `usage_invalid` suite; `trackResponse` probe `{100, 250000}` → `isBilledUsage:false` | `solution38-community-usage-clamp-bill-min` | fork [#49](https://github.com/NamanSoni78/pollinationsai/pull/49) |

### Audited clean this round (no gate-passing finding)

- **GPT-6.2 Astra/Sol + Bedrock fallback (6538ea2721)** — pricing single-source and snapshot-consistent (issue 37's multiplier gap was the one hole, found concurrently by session 8); paidOnly/auth gating, ARN construction, credential handling, response-completeness validation (requireResponses/ChatStreamUsage wraps the stream post-fallback), billedUsage-on-error and fallback trigger classification all verified clean. The `us.` vs `global.` inference-profile naming is an availability-only concern (deploy-region bound).
- **Text billing integrity re-sweep at HEAD** — usage zod-clamps on all five text legs; earnings side uses the same clamped copy; disconnect-billing survives tee/waitUntil; settle idempotency (one charge per generation, coordinator fails closed); quest/referral/BYOP scopes funnel through the same clamp. 0 accepted beyond issue 44.
- **enter authz/x402/quest re-sweep** — promo-code count-then-insert race is the in-code documented event-sized trade-off (per-user replay still blocked by idempotency key); agent-create name-collision inert by STATIC_ENTRIES-first registry resolution; PATCH key pk_-fields inert (pk_ never authenticates); OAuth/device consent parking is the documented RFC trust model. x402 purchase replay/amount/idempotency re-verified green (14/14). 0 accepted.
- **apps/CI/packages/frontend re-sweep** — 48 workflows enumerated: auto-fix allowlist solid, pull_request_target workflows check out base, workflow_run artifacts self-originated; polli HTTP tool enforcement executor-side at HEAD (issue 5's fix present); news pipeline publish scope bounded; CLI credentials 0600; run-cost display server-fed; no key in localStorage anywhere in apps (sessionStorage only). Below-gate hardening recorded: repo-triage-new-issues comment template, mcp-publisher mutable-pin, `flux/verify-vast.sh`/`data-sync` token-in-argv (runner-local ps visibility).

### Merge-status correction for maintainers (verified this round)

Three previously "fixed" issues' branches are still **unmerged** at upstream HEAD, so the vulnerable code is what deploys: #11 polli scraper SSRF (`apps/polli/src/integrations/web_scraper.py` — `scrape_url`/`fetch_discord_attachment` still fetch any URL; fix only on fork `solution11-polli-scraper-ssrf-guard`), #15 EXIF UserComment disclosure (uncapped `JSON.stringify(safeParams)` still embeds input URLs; fix only on fork), #33 e2b sandbox login expiry (fix only on fork). This round's five PRs (#45–#49) add to the pending review queue.

### Sync

- `fork/main` fast-forwarded `a7aed04e24` → `b4d7ebcb5b` (three upstream commits, none overlapping this round's fix sites) and pushed.
- `issues_mds` appends this round additively on top of session 8's round-12 head (`5f6e7de`); issues 40–44, branches `solution34–38-*` (names checked unique on `ls-remote` before push), no existing branch touched or force-pushed.
- Upstream PR creation re-verified this round: `403 Resource not accessible by personal access token` — fork PRs #45–#49 are the live review surface until an upstream-scoped token is supplied.

## Round 14 — session 10: new-model rate-sheet audit of b4d7ebcb5b..8dd9e0ed (2026-11-18)

Baseline: upstream `8dd9e0eded` (`fork/main` fast-forwarded `a38014db9d` → `8dd9e0ed` and pushed). Method: four parallel read-only subagent audits over the ~36 commits since round 13's audited baseline — (A) new text-model registry entries and their fallback chains, (B) new media models incl. the ZONOS3 GPU service, (C) the server-side image-inlining transform and community fetch paths, (D) packages (CLI public-catalog estimate, MCP error passthrough, pollen→dollars sweep) plus the enter quests-rework diffs — then main-agent verification of the one accepted candidate (registry-level, red→green against the real modules); every other candidate was traced to an existing control, an already-covered issue, or below-gate.

| # | Finding | Severity | Verification | Fix branch | PR |
|---|---|---|---|---|---|
| 45 | `qwen/qwen4-max:vercel` bills image input at $0: the route inherits image input and mirrors the primary's other four rates but omits `promptImageTokens`, and `convertUsage` zero-fills unrated usage lines while the gateway reports split image tokens — the primary's own follow-up fix added the $1.5/M image rate but only on the primary (same mechanism as issue 34, new model/route) | High | 2 new cases in `test/text/qwen4max-vercel-image-token-billing.test.ts` (red pre-fix, reproduced: 2000 image tokens contributed exactly $0.00 of a $0.00495 charge; route-sheet key missing); green post-fix; `static-provider-fallbacks`+`modelResolver` 262/262; `effective-prices` snapshot regenerated; `tsc` clean | `solution45-qwen4max-vercel-image-token-billing` | fork [#50](https://github.com/NamanSoni78/pollinationsai/pull/50) |

### Audited clean this round (no gate-passing finding)

- **New text models** — Qwen 4 Max primary, Hy4 Flash, DeepSeek V4.1 Flash Azure (quest access is the commit's stated intent, mirrors the established sibling), Mistral Large 3 Bedrock fallback, Liquid d1.2 SystemOne: priceMultiplier inheritance correct on every new route (pinned by committed `static-provider-fallbacks` cases); SystemOne client rejects usage-less answers rather than billing zero. Below-gate lead recorded: `tencent/hy4-flash` advertises image input with no `promptImageTokens` rate on any route — bites only if the gateway reports split image tokens for it (unverified, not filed); `liquid/d1.2` omits `promptCachedTokens` (cents-scale if reported).
- **ZONOS3-Mini speech** — billed per UTF-8 input byte at $5/1M with a 10k-char cap ($0.05/request max), `paidOnly` with double gating, model-list bypass closed; GPU service is loopback-only behind the Cloudflare Tunnel VPC binding; body/text/concurrency capped; no user input reaches the ffmpeg argv. **MAI Image 2.7** — provider-grounded usage billing, no resolution cost-variants possible. **Seedance 2.0 width/height** — billing-neutral ratio mapping (single 720p per-second rate). **flux 2 flex `paidOnly→false`** — a stated-capacity product decision, widens quest-tier spend only.
- **Image inlining (cdde268c15)** — pre-existing transform widened to more Azure models: IP-literal/IPv6/redirect-to-internal blocking in `validateUserMediaUrl`, 20 MB multi-image byte budget, 8-image count cap, `image/*` content-type enforced; single-request peak ~74 MB. The known fetch-without-deadline is the pending issue-20 fix's site (`a7017e2ccb`). Below-gate lead: `mediaToBedrock` has no fetch-count cap for `video_url` parts.
- **Community 300 s deadline (2ed51176a8)** — threaded through chat/responses/managed-agent paths incl. fallback re-entry; the headers-then-trickle residual is the covered community-timeout class.
- **CLI public-catalog estimate (e4a35ebda5)** — catalog and settlement share `getPriceDefinitionForModel` over the same publisher-controlled sheet (no divergence possible); publisher usage-only fields print "unknown", never an understated figure. **MCP 404/5xx passthrough (d2294d1978)** — non-empty-string gateway messages only, JSON-encoded as tool results; no new exposure class. **Pollen→dollars sweep** — display formatters only, zero billing arithmetic touched. **Quests rework** — `repeatable` plumbing with per-event reward ids (`github:merged_pr:N`); no authz or claim-path change. **.github / operations / apps diffs** — wording, pinned-revision setup scripts, game data; no trigger/secret/checkout changes.

### Sync

- `fork/main`: fast-forwarded `a38014db9d` → `8dd9e0ed` and pushed; all 45 solution branches and `work*` branches untouched (`ls-remote` clean).
- `issues_mds`: this round appended additively on round 13's head (`ce79aeca`); issue 45 and branch `solution45-qwen4max-vercel-image-token-billing` (checked unique before push); no history rewrite.
- Upstream PR creation re-verified this round: `403 Resource not accessible by personal access token` (attempted first, per the job spec); fork PR [#50](https://github.com/NamanSoni78/pollinationsai/pull/50) is the live review surface until an upstream-scoped token is supplied.

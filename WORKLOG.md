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

# FINDINGS — validated registry (round 3)

| ID | Title | Severity | Status | Evidence |
|---|---|---|---|---|
| R3-009 | Discord OAuth state replay → account takeover | Critical | Fixed — fork PR #12 | issue9 (integration test reproduced ATO) |
| R3-010 | Community self-reported usage unbounded billing (4.5e17 pollen/response) | High | Fixed — fork PR #13 | issue10 (unit test on unpatched path) |
| R3-011 | polli web_scrape/fetch_file SSRF from credentialed container | High | Fixed — fork PR #14 | issue11 (mocked-aiohttp PoC) |
| R3-012 | JSON upload path isolate OOM (parallel session) | High | Fixed — fork PR #15 | issue12 (live probe) |
| R3-013 | agent-run-token upload gate bypass (parallel session) | Medium | Fixed — fork PR #16 | issue13 (isolated test) |
| R3-014 | User-media redirect hops skip the URL policy (SSRF) | High | Fixed — fork PR #17 | issue14 (live control + unit tests) |
| R3-015 | EXIF UserComment public content channel + input URL disclosure | High | Fixed — fork PR #18 | issue15 (live PoC, own key) |
| R3-016 | /3d/ unvalidated URL forwarding to providers (SSRF by proxy) | Medium | Fixed — fork PR #19 | issue16 (schema-level tests) |
| R3-022 | Community text-proxy unbounded response buffering (isolate OOM) | High | Fixed — fork PR #26 | issue22 (code-path trace + 6 isolated unit tests) |
| R3-023 | Stripe refunds/lost chargebacks never reverse credited Pollen | High | Fixed — fork PR #27 | issue23 (4 integration tests; resolves R3-D1 below) |

## Verified design-gap findings (no code PR — policy decision required)

### R3-D1: Refunds and chargebacks never revoke granted Pollen

**Severity:** High (financial integrity) · **Verified:** read-only code analysis (2026-11-18, `bbccf2f5`)

`enter.pollinations.ai/src/routes/stripe-webhooks.ts:841-865`: `refund.created` / `refund.updated` / `refund.failed` only log and ship the event to Tinybird (analytics). `charge.dispute.created` falls to the unhandled `default` case. Pollen credited on `checkout.session.completed` (idempotent via `stripe_checkout_credits` PK) is never subtracted on any payment reversal — repo-wide grep finds no clawback path; the economics dashboard only *reports* fraud losses.

Partially mitigated by: (a) the hourly fraud ban (`utils/stripe-fraud-score.ts`) — but one "fraudulent" dispute scores 0.39 < the 0.75 ban threshold, and non-fraudulent dispute reasons score 0 forever; (b) 3DS is requested only for first purchases or packs < $10 (`stripe.ts:385-390`).

Why no PR: a correct clawback needs product decisions this audit can't make unilaterally — deduct unspent balance only, or carry into debt (the deduction ladder's documented design)? reverse the quest rewards keyed to the purchase (`account-setup.ts:116-135` top-up tiers)? what about ops-initiated reversals already applied manually? Recommend the maintainers decide the policy; the evidence above is complete for that discussion. Verification method if patched: simulate `refund.created` against a test D1 and assert balance/credit-row changes.

**Update (2026-11-18, round 9 — session 5):** implemented and test-pinned as **issue 23 / fork PR #27**. The policy decision is made there: debit into negative balance (the platform's documented generation-overdraft semantics), quest rewards deliberately untouched, manual/ops reversals unaffected. The verification prescribed above — simulate refund events against a test D1 and assert balance changes — is exactly the integration suite on the branch. R3-D1 can be considered closed pending review of PR #27.

## Dedup registry (known root causes, do NOT resubmit)

- issues 1–8 from rounds 1–2 (see SECURITY_AUDIT.md)
- issues 9–16 above (rounds 3–5, both sessions)
- issues 17–21 (rounds 7–8, sessions 3–4) and issues 22–23 (round 9, session 5)

## Round 15 (session 11, 2026-11-18)

Registry additions: issues 49–50–51 (mistral-large-3 vision unbilled, zonos GPU backend token, zonos speech deadlines; renumbered from 46–48 after concurrent sessions 10–11 registered 45–48) — full evidence in the round-15 WORKLOG section and `issues/issue49-51-*.md`.

## Verified design-gap findings (no code PR — policy decision required)

### R15-D1: Referral rewards self-dealable with any second payment instrument

**Severity:** Medium (financial integrity) · **Verified:** read-only code analysis (2026-11-18, `a38014db9d`)

`enter.pollinations.ai/src/services/quests/groups/referrals.ts:46-55`: the anti-self-referral guard is a `NOT EXISTS` over **Stripe card fingerprints only** (friend ↔ referrer attempt join). A fresh attacker-controlled referrer account has no card fingerprint, so the anti-join is vacuously true; the "friend" account then satisfies the `pollenBoughtSql > $2` floor (`github-contributions.ts:689-697` — Stripe checkouts, paid auto top-ups, and Polar) with any second instrument, and the referrer is credited the $2 `invite_friends` reward while the friend keeps the purchased balance: ≈$4.01 of value for $2.01 spent per cycle, bounded only by payment fees and OAuth account creation. The code comment ("a user who paid with a card the referrer has used is the referrer's own second account") shows the threat was considered — instrument diversity defeats the check.

Why no PR: the fix is a product decision — raise `MIN_POLLEN_BOUGHT` above the reward, add a referrer-side hold/velocity cap, or correlate device/IP signals; each changes legitimate-referral economics and needs maintainers' call. Verification path if patched: the `test/quests.test.ts` integration harness with a `polar_checkout_credits` fixture (the same shape as the existing fingerprint tests).

**Update (2026-11-18):** recorded during round 15's quest-logic sweep (subagent C); no in-range commit changed the referral logic — pre-existing, promoted from the below-gate pool because the ~2× multiplier per cycle is mechanical rather than speculative.

## Dedup registry refresh

- issues 1–8 (rounds 1–2), 9–23 (rounds 3–9), 24–39 (rounds 10–12), 40–44 (round 13), 45–48 (round 14, sessions 10–11: qwen4max vercel; fleet-wide vision-input billing; fallback cost sheets; community text error redaction), 49–51 (round 15, session 12) — one root cause = one finding; see WORKLOG round sections. Issue 49 is the mistral-scoped companion of issue 46 per the round-11/12 convention.

## Below-gate observations (round 15, for the record)

- zonos byte-unit preflight estimate prices **one byte** (no `priceUnits.quantity`) — $0.000005 reserved vs ≤$0.05 actual, bounded to one request's delta per account by the settle floor.
- zonos settlement reads usage headers at ~header arrival for binary bodies — a destroyed mid-stream response still bills the full input text (≤$0.05, user-fairness).
- zonos has no output-duration bound (10k chars ≈ 10-17 min audio per slot) — capacity note; the round-15 watchdog (issue 48) caps it at 20 min.
- `tencent/hy4-flash` and `liquid/d1.2` missing image/cached rates on non-splitting routes (also flagged by session 10's round 14); `mediaToBedrock` has no fetch-count cap for `video_url` parts.

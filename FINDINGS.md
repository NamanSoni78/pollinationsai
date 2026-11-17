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

## Verified design-gap findings (no code PR — policy decision required)

### R3-D1: Refunds and chargebacks never revoke granted Pollen

**Severity:** High (financial integrity) · **Verified:** read-only code analysis (2026-11-18, `bbccf2f5`)

`enter.pollinations.ai/src/routes/stripe-webhooks.ts:841-865`: `refund.created` / `refund.updated` / `refund.failed` only log and ship the event to Tinybird (analytics). `charge.dispute.created` falls to the unhandled `default` case. Pollen credited on `checkout.session.completed` (idempotent via `stripe_checkout_credits` PK) is never subtracted on any payment reversal — repo-wide grep finds no clawback path; the economics dashboard only *reports* fraud losses.

Partially mitigated by: (a) the hourly fraud ban (`utils/stripe-fraud-score.ts`) — but one "fraudulent" dispute scores 0.39 < the 0.75 ban threshold, and non-fraudulent dispute reasons score 0 forever; (b) 3DS is requested only for first purchases or packs < $10 (`stripe.ts:385-390`).

Why no PR: a correct clawback needs product decisions this audit can't make unilaterally — deduct unspent balance only, or carry into debt (the deduction ladder's documented design)? reverse the quest rewards keyed to the purchase (`account-setup.ts:116-135` top-up tiers)? what about ops-initiated reversals already applied manually? Recommend the maintainers decide the policy; the evidence above is complete for that discussion. Verification method if patched: simulate `refund.created` against a test D1 and assert balance/credit-row changes.

## Dedup registry (known root causes, do NOT resubmit)

- issues 1–8 from rounds 1–2 (see SECURITY_AUDIT.md)
- issues 9–16 above (rounds 3–5, both sessions)

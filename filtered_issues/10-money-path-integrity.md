# F-10 — Money-path ledger integrity: refunds never claw back, quest payouts re-arm (High)

**Consolidates:** issues [#23](../issues/issue23-stripe-refunds-never-reverse-pollen.md) (Stripe refunds/lost chargebacks never reverse credited Pollen) and [#116](../issues/issue116-quest-pr-payout-rearm.md) (quest-bounty PR payouts re-arm on body edit) — 2 issues, one surface: **the USD↔Pollen ledger has no negative feedback — money can enter twice or leave zero times.**

**Status on upstream `main` @ `4e662050` — re-verified by code inspection 2026-11-19:** `stripe-webhooks.ts:841-865` still handles `refund.created/updated/failed` as log + Tinybird analytics only (no `pack_balance` write anywhere in the refund path); the quest payout path still records quest payments only under `github:issue:N` (the `github:merged_pr:N` id appears in the *check* list but is never added to the *earned* set when a quest pays — the re-arm window stays open).

**Fix PRs:** [#27](https://github.com/NamanSoni78/pollinationsai/pull/27), [#131](https://github.com/NamanSoni78/pollinationsai/pull/131).

---

## What this chain can do, end to end

**Refund fraud (issue 23) — repeatable per purchase, no maintainer involvement:**
```
buy $100 pack  ->  100 Pollen credited (checkout.session.completed)
spend the Pollen (generations, keys, transfers)
request a Stripe refund / force a lost chargeback
  -> USD returns to the attacker
  -> Pollen stays; spent Pollen stays; credited Pollen silently diverges from collected USD
```
Every `pack_balance` write in the repo is a *credit* — repo-wide there is no reversal path. `charge.dispute.*` falls to the unhandled `default`. The fraud-ban tooling only bans access; it never claws back. Partially mitigated by the hourly fraud score (one "fraudulent" dispute scores 0.39 < the 0.75 ban threshold; non-fraudulent reasons score 0 forever) and 3DS only for first purchases / packs < $10.

**Quest payout re-arm (issue 116) — one merged PR pays K+1 times:**
```
open quests 9600@$10, 9601@$25, 9602@$10 (descending rewards)
merge PR 9951 closing 9601  ->  pays $25 (recorded ONLY under github:issue:9601)
edit the PR body (post-payout, post-merge) to close 9602 instead
  -> ids checked = [github:merged_pr:9951, github:issue:9602]
  -> earned has github:issue:9601 only  ->  PAYS AGAIN
strip the reference entirely  ->  the default merged-PR card pays $5 more
```
Payment multiplicity is fully attacker-controlled (GitHub derives closing references from the PR body, which the author can always edit); amounts are maintainer-bounded. **2026-11-19 code check:** upstream's `ids` list includes `github:merged_pr:N` (from #19983, 2026-11-17) but the quest-payment branch still records only the quest's id — the marker never enters the earned set, so the re-arm window is open exactly as reported.

## Proof

**issue 23 — integration suite over the signed webhook route (real D1/migrations, mocked Stripe API), contract pinned on the fix branch:**
- full refund debits exactly once; duplicate webhook replay idempotent by refund id
- partials scale + cumulative clamp; pending refund reverses nothing
- lost dispute reverses; won dispute keeps the credit
- and the gap established on unpatched HEAD: **none of these events touch `pack_balance` at all**
- 105/105 + 58/58 suites green; migration `0083`
- The policy decision the original design-gap note (R3-D1) requested is implemented in the PR: debit into negative balance (the platform's documented overdraft semantics), quest rewards deliberately untouched, ops-initiated reversals unaffected.

**issue 116 — unit red/green on the existing Miniflare + GitHub-mock harness (PR state mutated the way a body edit would):**
```
seed quests 9600@10 / 9601@25 / 9602@10; PR 9951 pays 25
mock body-edit (closingIssues [] -> [9602])
  unpatched main: re-pays at each step           (RED)
  with fix: pre-claimed github:merged_pr:9951 marker -> no new row, ever
```

## Members & fixes

| Issue | One-line | Verification | Fork PR |
|---|---|---|---|
| 23 | Stripe refunds and lost chargebacks never reverse credited Pollen | Integration (4 tests; unpatched gap established) | [#27](https://github.com/NamanSoni78/pollinationsai/pull/27) |
| 116 | Quest PR payouts re-arm by editing the merged PR's closing references | Unit red/green (body-edit simulated) | [#131](https://github.com/NamanSoni78/pollinationsai/pull/131) |

## Merge guidance

1. **#27** implements a policy (debit-into-negative on refund/dispute) that was explicitly deferred to maintainers — the PR is the decision; review the semantics, not just the code.
2. **#131** ships a one-row pre-claim marker plus a documented residual (PRs merged *before* deploy can re-arm once more without a D1 backfill — the PR names it).
3. Related but separate: the overdraft/settle-floor questions live in **F-05**; the sandbox/x402 credential axes in **F-09**.

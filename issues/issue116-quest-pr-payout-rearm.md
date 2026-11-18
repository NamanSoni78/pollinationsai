# Issue 116 — quest-bounty PR re-arm: editing a merged PR's closing references re-qualifies it for repeated payouts

- **Severity:** High (money-path idempotency break: a single merged PR can be paid K+1 times — every amount stays maintainer-bounded by the reward-N whitelist, but the multiplicity is fully attacker-controlled by the PR author, post-payout, no maintainer involvement)
- **Affected:** `enter.pollinations.ai/src/services/quests/groups/github-contributions.ts` `prProposals` (unpatched `:775-808`): the payment for a quest-closing PR is recorded **only under the quest's id** (`github:issue:N` via `toIssueQuestDefinition`), never under the PR's own id — upstream `pollinations/pollinations` main @ `459b7c41c5` (fix branch rebased to `30a8939fd`, file-disjoint).
- **Fix branch:** `solution116-quest-pr-payout-durability` — fork PR [#131](https://github.com/NamanSoni78/pollinationsai/pull/131)
- **Dedup:** no filed issue touches the PR-payment idempotency axis — rounds 30-34 verified the quest pipeline's label gating, amount whitelist, per-user identity keys, transactional claims and the three dedup layers, but the post-payout *reference-mutation* direction was never filed (the in-code comment at `:779-780` shows the authors considered post-payout mutation only in the "currently maps to an id the account earned" direction). Issues 23/103/105 are different enter surfaces; the promo/quest-check/device-approve races are the recorded below-gate set.

## Root cause

GitHub derives a PR's `closingIssuesReferences` from the closing keywords in the PR body ("Fixes #N"), and **the author can edit their own merged PR's body after the payout**. The earned-guard builds its `ids` from the PR's *current* closing references:

1. PR 9951 closes quest 9400 (bounty 50) → pays under `github:issue:9400`; `github:merged_pr:9951` is never recorded.
2. The author strips the closing link from the PR body. Next check: `ids = [github:merged_pr:9951]` — neither id is in the earned set (9400 *is*, but it is no longer in `ids`) → the PR re-qualifies as unpaid and pays the **next-highest remaining bounty** it still closes, or the **default $5**.
3. One body edit per payment: a PR closing K quests can pay K+1 times (50 + 25 + 15 + 5 instead of 50), violating the code's own documented invariant ("never a sum").

Variant: a PR that only closed an **already-earned** quest (pays nothing today — the guard suppresses the whole PR) re-arms to the default $5 the same way. Quest checks are throttled to 1/min per user — no barrier.

## Safe repro (isolated, red on unpatched main)

`test/quests.test.ts` (new test, existing Miniflare + GitHub-mock harness): seed quests 9600@10 / 9601@25 / 9602@10; merged PR 9951 closes [9600, 9601] (pays 9601@25) and PR 9952 closes [9600] (pays 9600@10). Then mutate the mock's PR state the way a body edit would (`closingIssues = []`, then `[9602]`, and the same for 9952) and re-check: **on unpatched main the PR re-pays at each step** (RED); with the fix, no new row ever appears. A final direct `claimReward` call on a marker row asserts `claimed: false` (markers can never credit). Deterministic offline — live probes **$0**.

## Fix

When a PR pays under a quest's id — or is blocked by one — also record a **pre-claimed 1-Pollen marker row** under its own id `github:merged_pr:N` in the same transactional `recordRewards` batch (`RecordRewardInput.preClaimed`, new; `claimReward` already short-circuits on `claimedAt !== null` before any balance credit):

- the marker's `quest_id` puts the PR's own id **permanently** in the earned set, so the PR can never re-qualify — immune to closing-reference edits;
- its idempotency key (`rewardKey(github:merged_pr:N, user)`) makes the marker itself exactly-once;
- `preClaimed` means it can never be claimed for pollen (asserted directly).

Payments themselves are unchanged — still quest-keyed, so the same-run two-PRs-one-quest dedup and the author-once-per-quest rule keep working (pinned by the untouched existing suites). **Residual (documented):** PRs paid before this deploys have no marker and remain re-armable exactly once more; a D1 backfill correlating historical quest payments to PR numbers can close that window.

## Tests

New red/green test (re-arm, peel to an unpaid quest, second-PR re-arm, marker-unclaimable); quests suite **58/58** (57 pre-existing unchanged); reward siblings (quest-grants, promo-codes, integration/rewards, referral) **32/32**; `tsc --noEmit` unchanged (193 pre-existing frontend errors on main, none in touched files).

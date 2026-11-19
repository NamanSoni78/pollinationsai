# filtered_issues — the consolidated, verified bug registry

**What this is:** the 134 raw findings in [`issues/`](../issues/) (AI-agent audit rounds 1–45, issues 1–133 plus a second #49 companion) consolidated into **13 maintainer-ready reports** — duplicates and siblings merged, related bugs chained to show their combined danger, false/overstated claims corrected or dropped, and every report carrying its end-to-end proof plus links to the fix PRs (fork PRs #1–#149).

**Why:** the raw set is too large and too mixed for review (the maintainers' own feedback). This folder is the filtered view: fewer items, higher quality, each one proven and actionable.

## Method (no false positives)

1. **Deep re-read of all 131 issue files** (5 parallel passes) extracting per-issue: root cause, verification type, proof strength, PR, family relations.
2. **Verification gate for this consolidation** — every claim was classified by its evidence: **LIVE PROBE** (commands + real production responses) > **INTEGRATION TEST** (real D1/workers, unpatched behavior shown) > **UNIT RED/GREEN** (red on unpatched main, green on fix) > **CODE-PATH ONLY** (not accepted as standalone proof; only kept where the same mechanism is execution-proven elsewhere in the family, and labeled as such).
3. **Re-verification on current upstream `main` @ `4e662050` (2026-11-19):** code inspection of every flagship claim (cache-before-auth, EXIF writer, refund webhook, x402 FK, settle floor, composio billing gate, MCP headers, community clamp scope, quest payout idempotency, media JSON path) plus **fresh live probes with the bounty key** (cache keyless replay, EXIF canary, vision billing on three providers, quests-standings timing, upstreamHost disclosure). Bugs already fixed upstream are marked; overstated claims are corrected (see below).
4. **Chaining:** related-but-individually-small bugs are combined into reports that demonstrate what they can do *together*.

## The 13 reports

| # | Report | Severity | Members | Still live @ `4e662050`? |
|---|---|---|---|---|
| F-01 | [Generation cache is public, identity-blind, permanent — and poisonable](01-generation-cache-public-content.md) | **Critical** | 1, 40, 71, 15 | **Yes — re-proven live 2026-11-19** |
| F-02 | [Platform-key spend abuse: MCP apps + Discord bots](02-mcp-platform-key-abuse.md) | **Critical** | 58, 17, 7, 6, 5, 118, 119, 18, 27 | Yes (code-verified) |
| F-03 | [Community-publisher attack chain](03-community-publisher-attack-chain.md) | **Critical** | 10, 26, 44, 22, 77, 93, 106, 107, 8, 48, 57, 78 (+4 subsumed) | Yes (clamp + disclosure verified) |
| F-04 | [Settlement never trusts the provider's receipt (fleet revenue leak)](04-settlement-revenue-leak.md) | High | 2, 3, 25, 53, 60, 66, 72, 81, 82, 88, 90, 91, 92, 95, 96, 99, 104, 113, 120, 123, 124, 130, 131 (+126 cross) | Yes (code-verified) |
| F-05 | [The overdraft engine: under-reservation + floorless settle](05-overdraft-engine.md) | High | 31, 32, 35, 36, 39, 64, 73, 61, 29 | Yes (no floor — code-verified) |
| F-06 | [Registry rate-sheet integrity (vision $0, cache rates, promos, dead pins)](06-registry-rate-sheet-integrity.md) | High | 34, 37, 45, 46, 47, 49-mistral, 49-vercel, 52, 62, 70, 80, 122, 128, 129, 132 | Yes (41 unpriced split routes — recounted 2026-11-19; mistral-large-4 fixed on fork PR #148) |
| F-07 | [Cross-tenant resource exhaustion: memory, time, rate](07-resource-exhaustion.md) | High | 12, 20, 51, 54, 55, 56, 65, 67, 68, 74, 75, 76, 79, 84, 85, 86, 87, 94, 97, 98, 100, 101, 103, 105, 108, 109, 110, 114, 115, 117, 121, 125, 133 | Yes (standings re-probed live 2026-11-19; zod amplification measured 2026-11-20) |
| F-08 | [The SSRF policy chain: one validator, five ways around it](08-ssrf-url-policy-chain.md) | High | 11, 14, 16, 21, 127 | Yes |
| F-09 | [Account takeover possible, credential containment broken](09-credential-containment.md) | **Critical** | 9, 30, 38, 33, 13 | Yes (trustedProviders + FK verified) |
| F-10 | [Money-path ledger integrity: refunds never reverse, payouts re-arm](10-money-path-integrity.md) | High | 23, 116 | Yes (both re-verified in code 2026-11-19) |
| F-11 | [Secrets in URLs/DOM/logs + privileged agents with live tokens](11-secrets-and-privileged-agents.md) | High | 24, 19, 69, 102, 50 | Yes |
| F-12 | [Provider errors served as success (protocol/stream integrity)](12-error-completion-stream-integrity.md) | High | 41, 42, 43, 59, 126 | Yes |
| F-13 | [Appendix: verified low-priority fixes](13-low-priority-verified-fixes.md) | Low-Med | 28, 83, 89, 111, 112 | Yes |

**134 raw findings → 13 reports** (round 43; rounds 44–45 re-verified on `4f3585e97`: every flagship still live, three new members registered — issue 131 → F-04 (PR #146), issue 132 → F-06 (PR #148, renumbered after a same-round index collision), issue 133 → F-07 (PR #149, the zod validation-issue amplification found by the round-45 dependency-CVE sweep)). Every raw issue maps to exactly one report below (cross-listed members are marked).

## Full mapping (issue → report)

| Issue | Report | | Issue | Report | | Issue | Report | | Issue | Report |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | F-01 | | 34 | F-06 | | 67 | F-07 | | 100 | F-07 |
| 2 | F-04 | | 35 | F-05 | | 68 | F-07 | | 101 | F-07 |
| 3 | F-04 | | 36 | F-05 | | 69 | F-11 | | 102 | F-11 |
| 4 | F-03 (subsumed by 22) | | 37 | F-06 | | 70 | F-06 | | 103 | F-07 |
| 5 | F-02 | | 38 | F-09 | | 71 | F-01 | | 104 | F-04 |
| 6 | F-02 | | 39 | F-05 | | 72 | F-04 | | 105 | F-04 |
| 7 | F-02 | | 40 | F-01 | | 73 | F-05 | | 106 | F-03 |
| 8 | F-03 | | 41 | F-12 | | 74 | F-07 | | 107 | F-03 |
| 9 | F-09 | | 42 | F-12 | | 75 | F-07 | | 108 | F-07 |
| 10 | F-03 | | 43 | F-12 | | 76 | F-07 | | 109 | F-07 |
| 11 | F-08 | | 44 | F-03 | | 77 | F-03 | | 110 | F-07 |
| 12 | F-07 | | 45 | F-06 | | 78 | F-03 | | 111 | F-13 |
| 13 | F-09 | | 46 | F-06 | | 79 | F-07 | | 112 | F-13 |
| 14 | F-08 | | 47 | F-06 | | 80 | F-06 | | 113 | F-04 |
| 15 | F-01 | | 48 | F-03 | | 81 | F-04 | | 114 | F-07 |
| 16 | F-08 | | 49-mistral | F-06 | | 82 | F-04 | | 115 | F-07 |
| 17 | F-02 | | 49-vercel | F-06 | | 83 | F-13 | | 116 | F-10 |
| 18 | F-02 | | 50 | F-11 | | 84 | F-07 | | 117 | F-07 |
| 19 | F-11 | | 51 | F-07 | | 85 | F-07 | | 118 | F-02 |
| 20 | F-07 | | 52 | F-06 | | 86 | F-07 | | 119 | F-02 |
| 21 | F-08 (+F-07) | | 53 | F-04 | | 87 | F-07 | | 120 | F-04 |
| 22 | F-03 | | 54 | F-07 | | 88 | F-04 | | 121 | F-07 |
| 23 | F-10 | | 55 | F-07 | | 89 | F-13 | | 122 | F-06 |
| 24 | F-11 | | 56 | F-07 | | 90 | F-04 | | 123 | F-04 |
| 25 | F-04 | | 57 | F-03 | | 91 | F-04 | | 124 | F-04 |
| 26 | F-03 | | 58 | F-02 | | 92 | F-04 | | 125 | F-07 |
| 27 | F-02 | | 59 | F-12 | | 93 | F-03 | | 126 | F-12 (+F-04) |
| 28 | F-13 | | 60 | F-04 | | 94 | F-07 | | 127 | F-08 |
| 29 | F-05 | | 61 | F-05 | | 95 | F-04 | | 128 | F-06 |
| 30 | F-09 | | 62 | F-06 | | 96 | F-04 | | 129 | F-06 |
| 31 | F-05 | | 63 | **excluded** (see below) | | 97 | F-07 | | 130 | F-04 |
| 32 | F-05 | | 64 | F-05 | | 98 | F-07 | | 132 | F-06 |
| 33 | F-09 | | 65 | F-07 | | 99 | F-04 | | | |
| 34 | F-06 | | 66 | F-04 | | 100 | F-07 | | | |
| | | | | | | | | 131 | F-04 |
| | | | | | | | | 133 | F-07 |

## Corrections & exclusions applied (the false-positive filter)

1. **Issue 63 (cache-write failure bills then 503) — EXCLUDED.** The only registry entry with *no executed proof at all* (code trace + an unexecuted repro recipe; no branch, no red/green). It stays in `issues/` as a recorded design question (refund-on-delivery-failure vs serve-despite-failure is a product decision).
2. **Vision "$0 live" claims corrected (issues 46 / 49-mistral).** Fresh live probes on 2026-11-19 show `kimi-k3` (Bedrock), `gpt-5.6-sol` (Azure) and `muse-spark-open` (Fireworks) **fold** image tokens into `prompt_tokens` and bill them at the text rate — no undercharge on those routes (the audit's own 49-vercel correction, now extended by re-probe). The $0 billing is real exactly on **split-reporting routes** (Vercel/OpenRouter/DeepInfra/Fireworks gateways): live-proven on kimi-k3.1-pro at audit time; **18 such routes still lack image rates** on current upstream (fresh programmatic scan). The registry math bug itself is unit-proven red for any split usage. F-06 carries the corrected exposure list.
3. **Issue 4 (community text timeout) — subsumed** into F-03 via issue 22 / PR #26 (deadline + cap in one fix); no separate report.
4. **Honest verification labels kept:** issue 5 (static analysis only), issue 19 (static, preconditions disclosed), issue 69 (green-on-fix tests, no red), issue 121 (fully mocked), issue 127 (validator-level, live control not executed), issue 44 (free-generation leg assumes a proxy honoring max_tokens), issue 100/105-family red proofs (413-absence rather than a demonstrated kill — mechanism inherited from the live-probed siblings). None of these is presented as stronger than it is.
5. **`moonshotai/kimi-k3.1-pro`** (the live-proven $0-vision instance) now carries an image rate upstream — removed from the live-exposure list in F-06.

## Fix-PR index (fork `NamanSoni78/pollinationsai`)

- **All 134 issues have fix PRs except issue 63** (excluded, no PR). PR numbers are offset from issue numbers (see each report's member table for the exact mapping; also `WORKLOG.md` rounds 1–45).
- **Merged on the fork (2026-11-17):** PRs **#2, #3, #4, #5, #6** (issues 2–6) — later superseded on fork/main by the standard re-sync to upstream; the PR diffs remain the review surface. (#7–#9 merged unrelated work branches.)
- **Withdrawn as documented duplicates:** #20 (superseded by #21), #29 (superseded by #26 — issue 22's cap family), #112 (superseded by #107), #124 (superseded by #122).
- **Orphan PR (no issue md):** #60 — `fix(bots): gate Telegram group members by cooldown…` (solution52-telegram-spend-gate). Thematically adjacent to F-02's bot-spend family; listed here so it is not lost.
- Upstream PR creation was re-verified as blocked for this token (`403 Resource not accessible by personal access token`) — fork PRs are the review surface, per the standing workflow.

## Suggested review order for maintainers

1. **F-01** (cache — re-proven live today; PR #1 is the keystone)
2. **F-09** (ATO + revocation; PR #12 is the reproduced account takeover)
3. **F-02** (free RCE under the platform key — PRs #67/#21)
4. **F-03** (community chain — PRs #13/#30 first)
5. **F-04** (revenue leak — PR #108 first, then the sweeps)
6. Time-critical singles inside the families: **PR #144** (minimax-m2.7 hard outage) and **F-07's PR #117** (standings D1 scan); **F-06's PR #143** (flux-3-max stale quote rates — settlement is receipt-protected per the round-44 correction, so this is now accuracy, not revenue).

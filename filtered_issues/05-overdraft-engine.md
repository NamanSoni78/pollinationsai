# F-05 — The overdraft engine: preflight under-reserves, settle has no floor — a $0.01 account extracts up to $65 of provider spend per request (High)

**Consolidates:** issues [#31](../issues/issue31-api-key-settle-no-floor.md) (floorless settle), [#32](../issues/issue32-per-second-request-estimate-under-reservation.md) + [#35](../issues/issue35-per-second-preflight-duration-plumbing.md) + [#39](../issues/issue39-per-second-adaptive-and-variant-bound-gaps.md) (per-second under-reservation — one vulnerability, three PRs), [#36](../issues/issue36-stem-separation-mean-gate-under-reservation.md) (stem-separation mean gate), [#64](../issues/issue64-music-ingestion-exact-funds-gate.md) (music ingestion pays provider pre-gate), [#73](../issues/issue73-permegapixel-preflight-worst-case.md) (per-megapixel under-reservation), [#61](../issues/issue61-coordinator-stranded-reservation.md) (stranded reservations — the caller-harm inverse), [#29](../issues/issue29-fallback-dimension-policy-gap.md) (fallback dimension subsidy) — 9 issues, one theme: **the preflight/estimate/settle pipeline admits requests the balance cannot cover, then either settles unbounded negative (platform absorbs) or strands the reservation (caller loses).**

**Status on upstream `main` @ `4e662050`:** `atomicAdjustApiKeyBalance` still applies `pollen_balance - amount` with **no floor** (re-verified 2026-11-19, `shared/billing/deduction.ts:139-157`); estimate still prices one unit (one second / one megapixel / the mean).

**Fix PRs:** [#36](https://github.com/NamanSoni78/pollinationsai/pull/36), [#37](https://github.com/NamanSoni78/pollinationsai/pull/37) / [#40](https://github.com/NamanSoni78/pollinationsai/pull/40) (alternatives), [#44](https://github.com/NamanSoni78/pollinationsai/pull/44), [#41](https://github.com/NamanSoni78/pollinationsai/pull/41), [#76](https://github.com/NamanSoni78/pollinationsai/pull/76), [#85](https://github.com/NamanSoni78/pollinationsai/pull/85), [#74](https://github.com/NamanSoni78/pollinationsai/pull/74), [#33](https://github.com/NamanSoni78/pollinationsai/pull/33).

---

## What this chain can do, end to end

**The exploit account: 0.01 pollen.** Because preflight estimates price *one unit* (one second of a 15 s render; one megapixel of a 9-MP render; the historical mean; or exactly $0 when Tinybird is cold), a nearly-empty account or finite-budget key is admitted for requests whose real settlement is 15–70× larger — and because settle has no floor, the balance simply goes negative and stays there:

| Route family | Admission estimate | Real settlement | Under-reservation |
|---|---|---|---|
| per-second video (seedance-2.0, `0.18/s`, 15 s) | $0.18 (1 s) or $0 (Tinybird cold) | $2.70 | 15–30× |
| seedance-2.5 adaptive reference edit | $0 (estimate `null`) | **$29.03** | 70× |
| per-megapixel FLUX.2 (8 refs + 4.19 MP) | $0.01125 (1 MP) | ≈$0.42 | ~30× |
| stem separation (mean gate) | $0.41 mean or $0 cold | **$65.5** (13,107 s × $0.005) | 160× |
| ElevenLabs music ingestion (20 MB ref) | $0.0025 cold | **$13.11** | 5,000× |

Each is a fresh account/key per overdrawn request ("one overdraft render per account"), bounded only by account creation. The `questPollenOnly` tier and `flux.2-flex` (non-paidOnly) expose the quest budget to the same absorption.

**The inverse failure harms paying callers (issue 61):** the coordinator alarm persists `started:true` *before* executing while the D1 reserve is a real deduction with no ledger row, TTL, or sweeper — an isolate death mid-generation (likelier while the F-07 OOM class is live) strands the caller's reservation **forever**. Red on unpatched: reservation 1.25 committed (5 → 3.75), re-delivered alarm fail-closes, balance stays 3.75. Control: releasing without a record would mint funds — the fix releases only recorded reservations.

**And the platform subsidizes fallback dimensions (issue 29):** unbounded caller width/height flow to per-area-billed fallbacks (fal z-image: 4096² = 17 billable MP at a flat $0.004 quote ≈ 21× loss) whenever the primary pool 503s — documented real 2-day z-image outage put all traffic on that fallback.

## Proof (strongest evidence)

**Issue 31 — the floorless settle, unit red/green with control (real production functions + real D1):**

```
key balance 0.01, estimate 0 (Tinybird cold) → settle 2.7
  unpatched: balance −2.69, ok:true (silent)
  control:  the RESERVE path rejects the same amounts (guard asymmetry)
  budget 1.0: single request settles to −28.10
  with fix:  positive adjustments clamp at 0
```

**Issue 36 — stem separation arithmetic on the real registry:** 13,107 s (50 MB @ 32 kbps) × $0.005/s ≈ 65.5 pollen; a caller with `packBalance: 0.01` passes `checkBalance` on the Tinybird mean ($0.4112) or $0 cold; fix gates on the exact decoded-seconds charge pre-dispatch.

**Issue 64 — music ingestion (9/13 red on unpatched main):** 646 s reference inside the 20 MB cap dispatched with a $1.00 wallet on main; post-fix **402 before any `api.elevenlabs.io` request** (`calls.length === 0`). A 3,600,000 ms `composition_plan` chunk bypassing the 3–300 s contract → 400 post-fix.

**Issue 39 — 12 red assertions on unpatched main:** `getDefinedRequestEstimate(seedance-2.5) === null`; $0 estimate admits `packBalance: 0.01` for a worst case of $29.03; post-fix the gate 402s at $0.01 and a 60 s model-picked report clamps to a 30 s bill.

**Issue 73 — 9/9 red:** `getEstimatedPrice({...requestedMegapixels: 4.19, referenceImageCount: 8})` returns the one-megapixel price on main; $0.02 balance admitted for ≈$0.42.

**Issue 35 — end-to-end admission test (red on unpatched):** $0.50 wallet/key → old estimate admits both 5 s and 15 s requests; with the duration-precise fix, 402 for both; $1.50 serves 5 s, refuses 15 s.

**Issue 61 — stranded reservation (red on unpatched):** `expected 3.75 to be 5` — the deducted reservation is never released.

**Issue 29 — unit red/green + mocked-fetch capture:** `ImageParamsSchema.parse({width:4096,height:4096})` succeeds; unpatched z-image fal route posts 4096²; post-fix 422 pre-fetch / clamp.

## The chain

```
$0.01 account / finite-budget key
        │
        ▼
preflight prices ONE unit (1 s / 1 MP / mean / $0-cold)      (32/35/36/39/64/73)
        │  estimate << real cost  → admitted
        ▼
provider renders and bills the platform                        (up to $65.5/request)
        │
        ▼
settle applies full delta, NO floor                            (31)
        │
        ├── balance goes negative, debt never reconciled       (platform absorbs; repeatable per account)
        └── OR isolate dies mid-generation → reservation stranded forever (61, caller loses)
fallback leg: unbounded dimensions at per-area rates           (29, platform subsidizes ~21×)
```

## Members & fixes

| Issue | One-line | Verification | Fork PR |
|---|---|---|---|
| 31 | Settle has no floor — finite budgets go unbounded negative | Unit red/green + control | [#36](https://github.com/NamanSoni78/pollinationsai/pull/36) |
| 32 | Per-second estimates price one second (3–30× under; $0 when cold) | Unit red/green (pure-function PoC) | [#37](https://github.com/NamanSoni78/pollinationsai/pull/37) |
| 35 | Same vulnerability, duration-precise fix + eligibility-gate root cause | Unit red/green incl. end-to-end 402 | [#40](https://github.com/NamanSoni78/pollinationsai/pull/40) |
| 39 | Residual: adaptive duration (`duration:-1` → 30 s) + cost-variant ratios (up to 70×/$29.03) | 12 red assertions | [#44](https://github.com/NamanSoni78/pollinationsai/pull/44) |
| 36 | Stem separation admits on the mean, bills 13,107 s ($65.5) | Unit (real registry + gate) | [#41](https://github.com/NamanSoni78/pollinationsai/pull/41) |
| 64 | Music ingestion pays ElevenLabs before any exact-charge gate ($13.11) | 9/13 red | [#76](https://github.com/NamanSoni78/pollinationsai/pull/76) |
| 73 | Per-megapixel preflight prices one MP (~30× under) | 9/9 red | [#85](https://github.com/NamanSoni78/pollinationsai/pull/85) |
| 61 | Interrupted coordinator alarm strands the reservation forever | Unit red/green + control | [#74](https://github.com/NamanSoni78/pollinationsai/pull/74) |
| 29 | Unbounded dimensions to per-area fallbacks under a flat quote (~21× subsidy) | Unit red/green | [#33](https://github.com/NamanSoni78/pollinationsai/pull/33) |

## Merge guidance

1. **#36 (floor) is the keystone** — it bounds every under-reservation leg's damage; merge first.
2. **#37 vs #40 are declared mutually-exclusive alternatives** for the per-second family (upper-bound vs duration-precise); **#44 folds into either**. Maintainer picks one; the issue mds document the trade-off (#40 over-reserves some requests, #37 admits above-average renders).
3. **#41, #76, #85** are the same exact-charge-gate convention on three distinct route families — independent merges.
4. **#74 (stranded reservations)** composes with all of the above and pairs naturally with the F-07 OOM family (isolate deaths are its trigger).
5. **#33** is a policy split fix (pool-side dimension policing vs fallback billing) — small, independent.

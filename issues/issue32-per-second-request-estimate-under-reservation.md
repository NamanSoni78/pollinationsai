# Issue: pre-flight estimates under-reserve per-second models by 3–30×

**Severity:** High (billing integrity)
**Status:** Confirmed by pure-function PoC on the real registry (2026-11-18, `549feee95b`)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/37 (branch `solution18-request-estimate-upper-bound`)

## Summary

The pre-flight reservation for API keys is computed from `getEstimatedPrice` (gen `model-stats.ts`), and for per-second-billed models it systematically under-reserves:

- `getDefinedRequestEstimate` uses `price[field] × (priceUnits?.[field]?.quantity ?? 1)` — for a per-second field that is literally one second of a render whose duration is only known at completion (0.97/s reserved while a 30s render bills 29.1);
- the Tinybird path uses the per-request average (a 15s render billed 2.7 was admitted on a 0.9 average), and a Tinybird-cold model (no rows) reserves zero while the full bill still settles.

RESERVE is a real hold (guarded by `pollen_balance >= amount`) released on error; SETTLE applies `±(billed − reserved)`. Combined with the settle path having no floor (issue 31), the under-reservation turned into unbounded negative balance.

## Root cause

The estimator treats a per-second rate as a per-request price and a historical average as a per-request bound, when the request's true bound is `rate × maxDuration`.

## PoC (real production functions + real registry model `bytedance/seedance-2.0`, 0.18/s, maxDuration 15)

- flat-rate per-second config (0.97/s, maxDuration 30): estimate 0.97, max possible bill 29.1 — under-reservation 30×; a 9 MiB-budget key reserves 0.97 against a 29.1 bill;
- Tinybird average 0.9 → admitted on 0.9 while a 15s request bills 2.7; Tinybird cold → estimate exactly 0: admitted holding nothing.

## Impact

Requests are admitted that a finite key budget cannot cover in the worst case; every above-average request under-reserves, and cold models reserve nothing at all.

## Fix

New `getPerSecondUpperBound(definition) = rate × maxDuration` for any model priced by the second (video or audio seconds) with a usable maximum duration; `getEstimatedPrice` returns that worst case for per-second models (the Tinybird average can only understate or be poisoned); `getDefinedRequestEstimate`'s per-second fields use `maxDuration` as the multiplier. Token-priced models keep today's behavior exactly. `test/request-estimate-upper-bound.test.ts` (new, 6 tests) pins the bound, the average no longer under-reserving, the cold-zero case, and unchanged token behavior; `byop-markup.test.ts` 41/41 green.

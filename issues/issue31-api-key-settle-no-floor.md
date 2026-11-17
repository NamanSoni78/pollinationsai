# Issue: API-key budget settles have no floor — finite budgets go unbounded negative

**Severity:** High (billing integrity)
**Status:** Confirmed by real-function PoC against unpatched `549feee95b` (2026-11-18)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/36 (branch `solution16-api-key-settle-floor`)

## Summary

The finite API-key budget (`apikey.pollen_balance`) is guarded on the reserve path — `atomicReserveApiKeyBalance` refuses amounts beyond the remaining balance. The settle path has no such floor: `atomicAdjustApiKeyBalance` (`shared/billing/deduction.ts`) applies the full `billed − reserved` adjustment and accepts any resulting balance, including unbounded negative. The reserve function's own docstring calls it a "finite API-key budget" — the settle path bypasses the finiteness.

## Root cause

The only affordability check in the key-budget lifecycle happens at reserve time, against an under-sized estimate; nothing downstream clamps the settle.

## PoC (real production functions, real SQLite/D1)

- key with `pollen_balance = 0.01`, estimate 0 (Tinybird cold) → admitted holding nothing → settle 2.7 → balance **−2.69**, `ok: true`, silent;
- key with budget 1.0, 1-second estimate (0.97) reserved, 30s @ 0.97/s billed → settle 28.13 → balance **−28.10** in a single request;
- control: the reserve path rejects the same unaffordable amounts (guard asymmetry demonstrated).

## Impact

A finite-budget key consumes provider resources far beyond its budget; the overspend persists as silent negative ledger. The key then cannot reserve new requests (402), but the debt is never reconciled against anything.

## Fix

Positive adjustments in `atomicAdjustApiKeyBalance` clamp the resulting balance at zero (`MAX(0, ROUND(...))`); releases stay unclamped. A final bill beyond the remaining budget ends at 0 — the platform absorbs the difference — matching the guarantee the reserve path already makes. `test/billing-apikey-settle-floor.test.ts` (new, 4 tests) pins the reserve guard, both under-reservation variants and the release path; `billing-deduction.test.ts`'s "settles post-execution usage without a preflight reservation" is updated to the new contract (budget 2, bill 3 → balance 0). 148 tests green.

# Issue: x402 prepaid keys are unrevokable — the only revoke path 500s on a foreign key

**Severity:** High
**Status:** Confirmed by real-worker + real-D1 PoC against unpatched `549feee95b` (2026-11-18)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/35 (branch `solution15-x402-key-revocation-fix`)

## Summary

Every paid x402 purchase leaves a permanent `x402_key_purchase` row referencing the issued `apikey` row (`drizzle/0066_x402_key_purchases.sql` — `key_id TEXT NOT NULL REFERENCES apikey(id)` with no `ON DELETE CASCADE`). The only revocation path for such a key (`DELETE /api/account/keys/:id`) deletes the `apikey` row, which D1 rejects with a FOREIGN KEY violation; because that error is not an `HTTPException`, it falls to `app.onError` → raw 500. There is no alternative kill switch: `UpdateKeySchema` has no `enabled` field, better-auth's native `/api/auth/api-key/*` endpoints are 405-blocked, and admin routes have no key operations. The same FKs also block deleting the holding user, so unrevokable keys accumulate monotonically.

## Root cause

A purchase-ledger row referencing the key with no cascade, and a delete handler that removes the key row first.

## PoC (real worker + real migrations, only upstreams mocked)

`DELETE /api/account/keys/:id` → 500 `INTERNAL_ERROR`; key row intact, `enabled`, funded; `GET /api/account/key` with the leaked raw key → 200 `valid: true`, budget intact. x402 keys are sold anonymously — the credential class most likely to leak and least likely to be rotated by an owner. The existing `x402-keys.test.ts` has zero revoke coverage, which is why this survives upstream.

## Impact

A leaked x402 key remains a funded, valid generation credential forever; the operator's only containment action fails deterministically.

## Fix

The delete handler removes the key's `x402_key_purchase` rows before deleting the `apikey` row. `test/integration/x402-key-revocation.test.ts` (new): real sign-in → real key creation → purchase row written exactly as `preparePurchase` does → key funded → DELETE 200 → `apikey` row and purchase rows gone → the leaked raw key now gets 401. A schema-level `ON DELETE CASCADE` rebuild would additionally unblock holding-user deletion; the code-side fix unblocks the security-relevant path with a minimal diff.

# Issue 38 — x402 key revocation, schema-level rebuild: companion verification and alternative fix (cross-reference to issue 30)

- **Severity:** High (payment-credential revocation — same vulnerability as issue 30)
- **Affected:** `enter.pollinations.ai/drizzle/0066_x402_key_purchases.sql:1-9`, `enter.pollinations.ai/src/routes/account.ts:2358-2409`, `enter.pollinations.ai/src/services/x402-key-purchases.ts` — upstream `pollinations/pollinations` main @ `6538ea2721`
- **Status:** Verified against the real D1 + real migrations harness: `DELETE /api/account/keys/:id` on a credited prepaid key returns **500** on the unpatched schema (reproduced this session), 200 after the fix
- **Fix branch:** `solution30-x402-key-revocation-fk` — **PR:** [#43](https://github.com/NamanSoni78/pollinationsai/pull/43)
- **Relationship:** The same vulnerability was registered by session 6 as **issue 30** (fix PR [#35](https://github.com/NamanSoni78/pollinationsai/pull/35), branch `solution15-x402-key-revocation-fix`, code-side deletion of purchase rows before the key delete). This companion is retained because the independent verification reproduced the identical 500 and this branch delivers the schema-level variant issue 30's own report recommends, which covers two paths PR #35 leaves broken.

## Root cause (shared with issue 30)

`x402_key_purchase.key_id TEXT NOT NULL REFERENCES apikey(id)` with no `ON DELETE` action (SQLite `NO ACTION`); `DELETE /api/account/keys/:id` hard-deletes the `apikey` row → D1 FK violation → `DrizzleQueryError` → `app.onError` → **500**. Every prepaid key since migration 0066 ($0.01–$10,000 of paid USDC credit each, never-expiring) is unrevocable through every documented path.

## What this variant additionally fixes (beyond PR #35's security path)

1. **The purchase audit row and its `encrypted_key` survive revocation.** `PAYMENT_USED` directs buyers who lost a charged key to *"contact hello@pollinations.ai with the transaction"* — support's recovery path for a revoked key is the stored `encrypted_key`. PR #35 deletes the purchase rows, removing that recovery record; `ON DELETE SET NULL` preserves it with the apikey link cleared.
2. **`delete-user` for the holding account is unblocked.** Better Auth's apikey cascade (`ON DELETE cascade` from `user`) still trips on the x402 rows under the code-side fix; `user_id ... ON DELETE cascade` closes it.

Revocation semantics are identical on both variants: deleting the apikey row removes the key-scoped `pollen_balance` (spending stops immediately) while the holding wallet keeps its credited amount.

## PoC (non-destructive, isolated integration test over the real migration stack)

New `describe("revocation")` in `test/integration/x402-keys.test.ts`: `preparePurchase` + `creditPurchase` → `DELETE /api/account/keys/:id` → **500 pre-fix** (FK constraint; reproduced before writing the migration), **200 post-fix**; the revoked key gets 401 on `/api/account/key`; the purchase row survives with `key_id` null and non-empty `encrypted_key`; repeat DELETE → 404. `x402-keys` + `account-keys` 49/49.

## Fix

Migration `0083_x402_key_purchase_on_delete.sql` rebuilds the table (mirroring `0072_sandbox-keep-owner.sql`'s rebuild pattern — SQLite cannot drop `NOT NULL` in place) with `key_id ... ON DELETE SET NULL` and `user_id ... ON DELETE cascade`; `Purchase.key_id` becomes `string | null` (all consumers null-safe: only `getPurchase` existence checks and the credit-time equality check read it). Maintainers can take either PR #35 or #43; the two are mutually exclusive fixes for the same constraint.

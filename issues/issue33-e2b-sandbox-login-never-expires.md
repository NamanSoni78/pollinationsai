# Issue: the polli login written into every E2B sandbox never expires

**Severity:** Medium
**Status:** Confirmed by real-route PoC against unpatched `549feee95b` (2026-11-18)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/38 (branch `solution19-e2b-sandbox-key-expiry`)

## Summary

`logIn()` (gen `e2b.ts`) mints the in-sandbox polli credential for every sandbox created from a Pollinations template: a secret key through enter's key API, written into the box at `/home/user/.pollinations/credentials(.staging).json`. The request it sends never carries an expiry, so the credential living inside an ephemeral, by-design arbitrary-code environment outlives the sandbox forever. The repo's own comments concede that every process in the box can read the login.

## Root cause

The key-creation request omits `expiresIn`, so better-auth stores `expires_at = NULL` and `isUsable` (`shared/auth/api-key.ts`) never time-rejects it: `!(expiresAt && expiresAt <= now)`.

## PoC (real route + real auth middleware + real D1; E2B control API, envd and enter binding stubbed)

The gen→enter request body has no `expiresIn`/`expiresAt`; replayed through enter's real key-creation stack (real `createApiKeyForUser` → real better-auth → real D1) the resulting row is `expires_at: NULL`; `findUsableApiKey` never retires it while a 1s control key is rejected after 1.2s. The container dies in ≤ 24 h (`MAX_RUN_MS`); the credential does not — it survives in snapshots, leaked envd file listings, or a compromised image, keeping its `profile`/`usage`/`machines` permissions.

## Impact

A permanent secret key with account permissions is materialized into every Pollinations-template sandbox, readable by any process in the box, and keeps spending until manually noticed and revoked.

## Fix

`logIn` now takes a `keyExpiresIn` and sends it as `expiresIn` (seconds): with a keep, the remaining keep window (≥ 60 s) — the login dies no later than the lease it was created under; without a keep, E2B's own run cap (`MAX_RUN_MS / 1000` = 86 400 s). `test/e2b-sandbox-key-expiry.test.ts` (new) drives the real route and asserts the captured body carries `expiresIn: 86400`, the credentials file is still written, the replayed key row gets a future `expires_at`, and a 1s-expiry key is rejected after 1.2s. The existing e2b suite's login expectation is updated to the new contract; 31 tests green.

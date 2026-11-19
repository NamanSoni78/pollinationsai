# F-09 — Account takeover is possible and credential containment is broken: once a key leaks, it cannot be killed (Critical)

**Consolidates:** issues [#9](../issues/issue9-discord-callback-oauth-state-replay.md) (Discord OAuth state replay → ATO), [#30](../issues/issue30-x402-prepaid-key-revocation-fk.md) + [#38](../issues/issue38-x402-revocation-schema-rebuild-companion.md) (x402 prepaid keys unrevokable — one bug, two fixes), [#33](../issues/issue33-e2b-sandbox-login-never-expires.md) (sandbox keys never expire), [#13](../issues/issue13-media-agent-run-token-upload.md) (`ag_` token upload bypass) — 5 issues, one kill chain: **take the account over (or phish/leak any key), then discover that every containment mechanism fails — revocation 500s, sandbox keys never expire, agent-run tokens keep privileges their design says they shouldn't have.**

**Status on upstream `main` @ `4e662050` — re-verified by code inspection 2026-11-19:** `trustedProviders: discordConfig ? ["discord"] : []` still present (`enter.pollinations.ai/src/auth.ts:462`); the x402 FK is still `key_id TEXT NOT NULL REFERENCES apikey(id)` with **no `ON DELETE`** (`drizzle/0066_x402_key_purchases.sql`); the sandbox key-creation request still omits `expiresIn`.

**Fix PRs:** [#12](https://github.com/NamanSoni78/pollinationsai/pull/12), [#35](https://github.com/NamanSoni78/pollinationsai/pull/35) / [#43](https://github.com/NamanSoni78/pollinationsai/pull/43) (alternatives), [#38](https://github.com/NamanSoni78/pollinationsai/pull/38), [#16](https://github.com/NamanSoni78/pollinationsai/pull/16).

---

## The kill chain, end to end

```
1. ATO (issue 9): attacker puts a victim email on a Discord profile (unverified is fine —
   trustedProviders trusts it on the callback path), replays a GitHub sign-in `state`
   on /api/auth/callback/discord  →  session minted, attacker Discord linked to the
   victim's account  →  persistent backdoor (survives sign-out)
        │
        ▼
2. keys are materialized everywhere (generation keys, x402 prepaid keys with up to
   $10,000 USDC credit, a permanent secret key inside every E2B sandbox, ag_ tokens
   handed to untrusted generated code)
        │
        ▼
3. containment fails on every axis:
   ├── x402 key DELETE → 500 FK violation (the only revoke path; no enabled=false,
   │   no admin kill switch)                       (issues 30/38)
   ├── sandbox key: expires_at NULL → isUsable never time-rejects — a permanent
   │   profile/usage/machines-scoped secret readable by any process in the box
   │                                              (issue 33)
   └── ag_ token (designed for untrusted code) still uploads 400 MiB files and
       publishes into public galleries under the owner's identity, while DELETE
       already refuses it                          (issue 13)
```

## Proof (strongest evidence)

**issue 9 — integration test reproducing the ATO on unpatched `bbccf2f5`** (mocked providers, own test D1, real better-auth):

```
GitHub sign-in `state` replayed on /api/auth/callback/discord
with attacker Discord account (victim email, verified: false)
  -> 302, session minted: true, Discord account linked to victim userId
  >>> VULNERABLE: session cookie minted for the victim
post-fix: no cookie, no account row; 62 + 16 auth tests green
```
Root cause: provider-agnostic Better Auth `state` + no PKCE on Discord + the app's `trustedProviders: ["discord"]` trusting an unverified email on the implicit-link callback path. (Still unfixed upstream — code re-verified 2026-11-19.)

**issues 30/38 — real-D1 integration tests, deterministic 500 on unpatched `549feee`:**

```
DELETE /api/account/keys/:id  (funded x402 key)
  unpatched: 500 INTERNAL_ERROR — key row intact, enabled, funded
  GET /api/account/key with the raw key: 200 valid:true, budget intact
  with fix (either PR): DELETE 200 → rows gone → raw key 401
```
Every prepaid key since migration 0066 ($0.01–$10,000 paid USDC, never-expiring) is unrevokable through every documented path; the holding user cannot even delete their account. The two PRs are declared mutually-exclusive alternatives: #35 (delete purchase rows first) vs #43 (schema-level rebuild — preserves the `encrypted_key` support-recovery record and unblocks delete-user).

**issue 33 — integration test through the real route + real D1:** the gen→enter key-creation body carries no `expiresIn` → `expires_at: NULL`; a 1-second control key is rejected after 1.2 s while the sandbox key never retires; fix asserts the captured body `expiresIn: 86400` (24 h, matching the box).

**issue 13 — unit red/green:** `POST /upload` with an `ag_` stub returns 200 on unpatched main (policy: 403 — the DELETE route already has exactly this guard); fix mirrors it.

## Members & fixes

| Issue | One-line | Verification | Fork PR |
|---|---|---|---|
| 9 | Discord OAuth state replay + unverified-email trust → full account takeover | Integration test (verbatim ATO) | [#12](https://github.com/NamanSoni78/pollinationsai/pull/12) |
| 30 | x402 prepaid keys unrevokable — DELETE 500s on the FK | Integration (real D1, 500 reproduced) | [#35](https://github.com/NamanSoni78/pollinationsai/pull/35) |
| 38 | Same bug, schema-level rebuild (preserves recovery record) | Integration (real migrations) | [#43](https://github.com/NamanSoni78/pollinationsai/pull/43) |
| 33 | E2B sandbox login never expires (permanent key in an ephemeral box) | Integration (real route + D1) | [#38](https://github.com/NamanSoni78/pollinationsai/pull/38) |
| 13 | `ag_` tokens bypass the sk_-only upload gate (400 MiB + public galleries) | Unit red/green | [#16](https://github.com/NamanSoni78/pollinationsai/pull/16) |

## Merge guidance

1. **#12 is the most urgent single PR in the registry** — a reproduced, persistent account takeover. It is also the only member that removes the *entry* step of the chain rather than a containment failure.
2. **#35 vs #43:** maintainers pick one (the issue mds document the trade-off; #43 covers more paths — user deletion, support recovery).
3. **#38 (sandbox expiry)** and **#16 (ag_ upload)** are small, independent containment hardenings — safe to take immediately.
4. Product note worth deciding with this set: an `enabled=false` soft-disable for keys (mentioned by 30/38 as absent) would give ops a containment lever that today literally does not exist.

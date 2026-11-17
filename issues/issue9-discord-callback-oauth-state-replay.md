# Issue: OAuth state replay on the Discord callback links an attacker-controlled Discord account to any account and mints a session for it (full account takeover)

**Severity:** Critical
**Status:** Confirmed by integration test (2026-11-18, reproduced against unpatched `bbccf2f5`)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/12 (branch `solution9-discord-callback-state-replay`)

## Summary

Discord is a *connect-only* provider on enter.pollinations.ai: `src/auth.ts` blocks `POST /api/auth/sign-in/social` for Discord, and Discord is listed in `account.accountLinking.trustedProviders` so users whose Discord email is unverified can still connect Discord explicitly (`/link-social`).

Better Auth's OAuth `state` is **not bound to the provider that minted it** (`dist/state.mjs` — the state payload has `callbackURL`, `codeVerifier`, `link`, … but no provider id), and the Discord provider does not use PKCE (`@better-auth/core` `social-providers/discord.mjs` — `validateAuthorizationCode({code, redirectURI})` ignores `codeVerifier`). The callback takes the provider from the URL path (`callback.mjs`: `getAwaitableValue(c.context.socialProviders, { value: c.params.id })`).

So a state minted by **any** provider's sign-in flow can be replayed on `/api/auth/callback/discord`. The app's only Discord guard matches `authContext.path === "/sign-in/social"` and never runs on the callback. With Discord trusted, Better Auth's implicit-link check (`link-account.mjs`) skips the `emailVerified` requirement, so `handleOAuthUserInfo` links the attacker's Discord account to **whichever local user owns the email on the (unverified) Discord profile** and `createSession`s as that user.

Attack: register a Discord account carrying the victim's email (unverified), initiate a public GitHub/Google sign-in (copy the `state`), craft `https://discord.com/api/oauth2/authorize?...redirect_uri=.../api/auth/callback/discord&state=<copied>`, approve with the attacker Discord, and the callback returns a session cookie **for the victim's account** and links the attacker's Discord to it — paid Pollen balance, API keys (`POST /api/session-token` → `POST /api/account/keys`), PII, quest rewards, and a persistent Discord backdoor.

## Root cause

Composition of two gaps:

1. **Provider-agnostic OAuth state + no PKCE on Discord** (Better Auth 1.6.30): the state minted for one provider's flow validates on any provider's callback.
2. **App-level guard only on the initiation path**: the sign-in block for Discord (`src/auth.ts:209-214`) does not cover `/callback/:id`, and `trustedProviders: ["discord"]` makes the implicit-link path on the callback trust an unverified provider email.

## PoC (isolated integration test, mocked providers, own test D1 — no production access)

`enter.pollinations.ai/test/integration/discord-callback-state.test.ts` (first test), run against unpatched `origin/main` (`bbccf2f5`):

1. Fixture victim: `test@example.com`, `emailVerified: true` (GitHub account).
2. Mocked Discord profile: `email = "test@example.com"`, `verified: false` (attacker controls the Discord account `987654321`).
3. `POST /api/auth/sign-in/social {"provider":"github","callbackURL":"/"}` → take `state` + state cookie (GitHub flow never completed).
4. `GET /api/auth/callback/discord?code=discord-test-code&state=<github-state>` with that state cookie.

Observed on unpatched code (verbatim from the test run):

```
PoC callback status: 302
PoC callback Location: /
PoC session minted: true
PoC discord accounts: [ { accountId: '987654321', userId: 'ZEC9wtsCwNU04n36qXz0fUL7GhLpUnzz' } ]
PoC victim id: ZEC9wtsCwNU04n36qXz0fUL7GhLpUnzz
>>> VULNERABLE: session cookie minted for the victim
```

The attacker's Discord is linked to the victim's user id and a `better-auth.session_token` for the victim is set.

## Impact

- **Full account takeover** of any account whose email the attacker can put on a Discord profile (email need not be verified on Discord; the victim's local email *is* verified, which satisfies `requireLocalEmailVerified`).
- Persistent backdoor: after the link, replaying the same Discord flow signs in directly (account found by discord id); `sign-out` does not unlink.
- Financial: victim's paid Pollen balance spendable, new API keys mintable, quest/promo rewards claimable.

## Fix

`enter.pollinations.ai/src/auth.ts`, `hooks.before`: reject any `/callback/discord` request carrying a `code` whose state was not minted by an authenticated `/link-social` flow. The state's `verification` record (identifier = the `state` query param) only contains `link` data for those flows, so replayed sign-in states fail closed. Error-only callbacks (provider-side denials, no `code`) pass through; the legitimate connect flow — including unverified Discord emails — keeps working (pinned by the second test).

Verification after fix: replay test gets **no session cookie and no account row**; link-social test still 302 → `/account` with the Discord account linked to the signed-in user. `account-linking.test.ts` (16) + auth suites (62 across 6 files) pass; `tsc` delta zero.

## Notes

- Same root-cause class as the classic "OAuth state not bound to provider / channel" bug (CWE-359 / CWE-346 family).
- An upstream Better Auth hardening (state-provider binding, or PKCE on Discord) would also close this; the app-level guard protects the deployed service regardless of the framework timeline.

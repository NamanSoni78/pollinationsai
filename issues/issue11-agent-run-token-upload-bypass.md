# Issue 11 — Agent-run tokens (`ag_`) bypass the sk_-only restriction on media upload

- **Severity:** Medium (policy bypass; unit-test verified)
- **Affected:** `media.pollinations.ai` `POST /upload` auth gate — upstream `pollinations/pollinations` main @ `549feee9`
- **Fix branch:** `solution11-agent-run-token-upload-guard` — **PR:** #16 (https://github.com/NamanSoni78/pollinationsai/pull/16)

## Root cause

The upload route authorizes on the **reported** key type only:

```ts
if (authResult.type !== "secret") { return 403; }
```

Agent-run tokens (`ag_…`) are validated by `authenticateAgentRunToken`, which returns the **parent** key's auth result — type `"secret"` included — so an `ag_` token passes the gate. The `DELETE` route already rejects `ag_` tokens explicitly, with the in-code rationale *"they're handed to generated code, so they can't delete either"*; the upload route was missing the same guard. Consequence for any party holding a leaked `ag_` token (by design they are embedded in tool schemas and sent to untrusted generated/model code):

- upload arbitrary files (up to 400 MiB each),
- mint account-scoped custom IDs,
- publish into **public tag galleries**,

all attributed to, and rate-limited/quota'd against, the owner's account — contradicting the documented rule "Uploading media requires a secret (sk_) API key".

## Safe reproduction (isolated unit test — no live `ag_` token needed)

The test suite's `KEY_IDENTITIES` already stubs `ag_alice` as an agent-run token reporting its parent's identity (`type: "secret"`, `userId: "user_alice"`) — exactly how Enter's key check answers for `ag_` tokens in production. On unpatched `main`, `POST /upload` with `Authorization: Bearer ag_alice` returns **200**; the documented policy requires **403**.

## Fix (`{B11}`)

Mirror the DELETE guard on the upload route:

```ts
if (authResult.type !== "secret" || apiKey.startsWith(AGENT_RUN_TOKEN_PREFIX)) { return 403; }
```

## Verification

- New unit test `refuses uploads with agent run tokens` → 403 with the sk_-only error message.
- Full `media.pollinations.ai` suite: **76/76 green** on `{B11}`.

# Issue 13 — media: agent-run tokens (`ag_`) can upload, while DELETE already refuses them

| | |
|---|---|
| Severity | Medium-High (authorization inconsistency on a low-trust credential) |
| Component | `media.pollinations.ai/src/index.ts` |
| Baseline | upstream `549feee` (2026-11-17) |
| Fix | `solution11-agent-run-token-upload-guard` |
| PR | https://github.com/NamanSoni78/pollinationsai/pull/16 |

## Summary

Uploads are documented as secret-key-only because a publishable key ships inside public clients. The upload gate only checks the reported key **type**:

```ts
// index.ts:468-472
// Publishable keys ship inside public clients, so anyone holding one
// could host files on the owner's account; uploads are secret-key only.
if (authResult.type !== "secret") {
    return c.json({ error: "Uploading media requires a secret (sk_) API key" }, 403);
}
```

Agent run tokens (`ag_`) report their parent key's `secret` type, so they pass. The DELETE path in the same file already treats them as a distinct, lower-trust credential:

```ts
// index.ts:1032
auth.type !== "secret" ||
apiKey.startsWith(AGENT_RUN_TOKEN_PREFIX)
```

## Why it matters

`ag_` tokens are minted for generated/agent code, not for a human operator. With the current gap such a token can:

- create stored media on the owner's account (storage cost, 30-day retention, GET-refreshed),
- supply a custom `id` when the key is user-owned (`u_<hash>_<id>` namespace),
- publish uploads into **public galleries** via `tags`,
- but it cannot delete any of it — there is no cleanup path, so abusive material stays until expiry.

That is exactly the authority the DELETE path decided this credential must not have.

## Reproduction (isolated test)

```ts
// media.pollinations.ai/test/integration.test.ts
const { status, body } = await uploadViaForm("ag_alice"); // key type resolves to "secret"
expect(status).toBe(403);                                   // currently 200
```

The suite's stub resolves `ag_` keys with `type: "secret"` (mirroring production, where an agent token inherits its parent key), so the upload succeeds today.

## Fix

Refuse `ag_` tokens on upload exactly as DELETE does, with the same status and message:

```ts
if (authResult.type !== "secret" || apiKey.startsWith(AGENT_RUN_TOKEN_PREFIX)) {
    return c.json({ error: "Uploading media requires a secret (sk_) API key" }, 403);
}
```

## Verification

- New integration test: `ag_` upload returns 403 with the secret-key error.
- Existing `sk_` upload, custom-id, catalog and delete tests unchanged and green.
- Confirmed at `549feee`: upload lacks the `ag_` guard; DELETE keeps it.

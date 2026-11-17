# Issue: the /text content routes serve error completions as unmarked HTTP 200 plain text

**Severity:** Medium-High
**Status:** Confirmed by worker-level route tests against `a7aed04e24` (2026-11-18, bug reproduced pre-fix)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/47 (branch `solution36-text-route-error-completions-502`)

## Summary

The plain-text content routes (`POST /text`, `GET /text/:prompt`) only rejected *empty* completions — the gate whose own comment says "a blank completion must never become a cache hit". A completion with `finish_reason:"error"` and partial content passed the gate and was served as an unmarked **HTTP 200 text/plain** answer: the plain-text protocol has no error channel, so the failure marker was simply destroyed. Verified at the worker level: `GET /text/:prompt` against a mocked provider returning an error completion answered `200 "partial answer"`. The classic anonymous `GET /text/:prompt` API is the simplest, most widely integrated surface on the platform. Chat Completions keeps the marker in its JSON contract and the Responses adapter maps it to `status:"failed"`; the text routes had no equivalent gate. Each such 200 body is also the cache entry for every later caller (issue 40's axis).

## Root cause

```ts
// text/handler.ts generateChatAttempt (pre-fix) — the only completion-quality gate:
const emptyChoices = (result.choices ?? []).filter(({ message, finish_reason }) =>
    finish_reason !== "content_filter" && ... );   // rejects EMPTY completions only
// then sendTextContentResponse returns message.content as 200 text/plain — marker dropped
```

## PoC (worker-level route tests, real provider mock; pre-fix results)

`gen.pollinations.ai/test/text/content-error-completions.test.ts` (qwen custom-host chat model, real registry):

- `GET /text/<prompt>?model=<community-hosted model>` with provider returning `choices[0].finish_reason:"error"`, `content:"partial answer"` → **HTTP 200, body `partial answer`** (bug: expected 502)
- Control: normal completion → `200 "full answer"` (unchanged)
- Control: `/v1/chat/completions` with the same error completion → 200 with `finish_reason:"error"` preserved in JSON (marker contract untouched)

## Impact

Lightweight integrations (curl/SDK-simple consumers, anonymous tier) receive partial or truncated generations as real answers with no way to distinguish garbage from output.

## Fix

`generateChatAttempt` rejects choices that finished `finish_reason=error` when called for a content response (new `rejectErrorCompletion` flag threaded from `generateTextResponse`'s `contentResponse`), mirroring the blank-completion gate it already enforced: the attempt fails into the normal fallback chain and surfaces as 502 instead of a fake answer. New suite 3/3; full `test/text/` suite **958/958**; `tsc` clean.

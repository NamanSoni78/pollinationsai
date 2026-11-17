# Issue: the text cache stores HTTP-200 error completions and serves them as immutable HITs

**Severity:** High
**Status:** Confirmed by isolated unit tests on the real cache middleware against `a7aed04e24` (2026-11-18, bug reproduced pre-fix)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/45 (branch `solution34-text-cache-finish-error-gate`)

## Summary

The text cache write guard (`isStreamingErrorResponse`, gen `utils/text-cache.ts`) only recognized SSE *protocol* errors: any non-SSE content type short-circuited to "cache it", and for streams only top-level `error` keys were checked. The exact production scenario upstream fixed for the CLI/MCP consumers (#19796, #19584) — a provider that answers **HTTP 200 with `finish_reason:"error"`** mid-generation — was written verbatim into `TEXT_BUCKET` as an immutable, TTL-refreshing cache entry. Cache hits skip auth, rate limits and billing entirely (`generation-cache.ts`), so one mid-generation provider failure froze its partial/garbage answer for the same request: every later caller got `X-Cache: HIT`, and SDK/CLI/MCP callers that correctly reject `finish_reason=error` replayed the same cached failure on every retry. The dedup coordinator amplified it (concurrent identical non-stream requests all served the poisoned entry); `execute-generation.ts` recorded the 200-error as `"generated"`, not `"failed"`. Billing was not overcharged (the first MISS is unbilled via `finishReasonError`; HITs are unbilled) — this is the integrity axis, distinct from issue 1's identity axis.

## Root cause

```ts
// utils/text-cache.ts (pre-fix)
function isStreamingErrorResponse(response, body) {
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        return false;              // ← JSON bodies: always cached
    }
    ...
    return Boolean(event && typeof event === "object" && "error" in event);
                                   // ← top-level only; nested choices[0].finish_reason="error" passes
}
```

Affected legs: `/v1/chat/completions` (non-stream JSON and streams), `/v1/responses` non-stream (`status:"failed"` bodies are 200 JSON), `/text` and `GET /text/:prompt`. `shouldCache` only required `status === 200`.

## PoC (isolated unit tests on the real middleware + R2 mock; pre-fix results)

`gen.pollinations.ai/test/text-cache-finish-error.test.ts`, same harness as the existing "does not cache SSE protocol errors":

- JSON 200 chat body with `choices[0].finish_reason:"error"` → second request `X-Cache: HIT` (**bug: expected MISS**), origin hit once
- SSE stream whose terminal chunk carries `choices[0].finish_reason:"error"` (nested, no top-level `error`) → `HIT` (**bug**)
- Responses 200 body with `status:"failed"` → `HIT` (**bug**)
- Controls: normal JSON/SSE completions and a max_tokens-truncated (`status:"incomplete"`) body → still cached `HIT` (correct, matching the aca5490521 intent)

## Impact

Cross-user data-integrity poisoning of the public cache (anonymous tier included): a single provider failure per popular prompt serves garbage to every future caller indefinitely (immutable + `refreshR2ObjectTtl` keeps hits alive), and error-rejecting clients enter an infinite rejection loop. Availability+integrity class; no charge axis.

## Fix

`isErrorCompletion` mirrors the billing-side scan (`finishReasonError` in `middleware/track.ts`): reject top-level error objects, Responses failures (`isResponsesFailure`, imported single-source), and any choice finishing `finish_reason=error` — in both buffered JSON bodies and SSE data frames. New suite 6/6; `text-cache.test.ts` 20/20; `tracking-observability` + `generation-deduplication` 136/136; `tsc` clean.

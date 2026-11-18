# Issue 71 — Unbilled `content_filter` refusals are cached as immutable free HITs (companion to issue 40)

- **Severity:** High (cache poisoning class: a moderation refusal is frozen for every later caller of the same request; cache hits skip auth, rate limits and billing)
- **Affected:** `gen.pollinations.ai/src/utils/text-cache.ts:40-62` (`isStreamingErrorResponse` — the only cache-write guard) vs the billing-side classification `gen.pollinations.ai/src/middleware/track.ts:1145` (`!hasUsage && finish_reason === "content_filter"` → content-policy rejection) — upstream `pollinations/pollinations` main @ `6989f4bb64`
- **Fix branch:** `solution71-content-filter-cache-refusal` — fork PR [#83](https://github.com/NamanSoni78/pollinationsai/pull/83)
- **Relationship:** companion to issue 40 (`solution34-text-cache-finish-error-gate`, unmerged): that fix gates `finish_reason=error`; neither its code nor its tests cover `content_filter`. Round 16 recorded this residual explicitly ("a 200 `finish_reason:"content_filter"` body without usage is cached as an immutable free HIT — one-line extension recipe recorded against `test/text-cache.test.ts`"). This is that extension, delivered per the mistral-companion convention (issue 49 of issue 46).

## Root cause

The billing side treats a choice finishing with `finish_reason: "content_filter"` and no usage as a **rejection** — `finishReasonError` in `middleware/track.ts:1143-1147`:

```ts
// Filtered completions with valid usage remain billable. Without
// usage, preserve the rejection rather than report missing usage.
if (!hasUsage && finish.finish_reason === "content_filter") {
    return { status: CONTENT_POLICY_STATUS };
}
```

Azure OpenAI produces exactly this shape in production when the content filter trips mid-generation: a 200 chat completion whose choice carries `finish_reason: "content_filter"` and whose usage object is absent (the filter aborts before token accounting). The cache write path, however, only refuses SSE protocol errors (`event: error` frames and data frames with a top-level `error` key) — a 200 JSON body, or an SSE stream whose final frame carries the refusal, passes straight into `TEXT_BUCKET.put` with `Cache-Control: immutable` and a TTL refreshed on every read.

Consequences, mirroring issue 40's accepted harm profile:

1. **Frozen refusal:** the entry is immutable and TTL-refreshing, so every later caller of the same request receives the cached refusal free — retries can never recover, although content-filter decisions are nondeterministic (a borderline prompt passes on some attempts).
2. **Freeze skips the platform's own contract:** the billing side classifies the shape as a rejection; the cache side stores it as a successful completion for anonymous `GET /text/:prompt` callers without auth or rate limits.
3. **SDK/CLI/MCP replay:** callers that treat `content_filter` as an error (the same family that rejects `finish_reason=error` per #19584/#19796, issue 40's motivating reports) replay the same cached failure forever on retry.

## Safe reproduction (isolated unit test, red on unpatched main)

`gen.pollinations.ai/test/text-cache-content-filter.test.ts` (new, mirrors the issue-40 harness): a Hono app mounting the real `textCache` middleware over a stub origin that returns the refusal body; two identical POST `/v1/chat/completions` requests:

- unpatched main: second request returns `X-Cache: HIT` and the origin is hit once — **the refusal was cached** (both the JSON and the SSE variant fail this way);
- with the fix: both requests are `X-Cache: MISS`, origin hit twice;
- controls (pass on both): a `content_filter` completion **with** usage stays cacheable (billed filtered completions are legitimate — `track.ts` keeps them billable), an SSE refusal whose final frame carries `usage` stays cacheable, and a normal `stop` completion without usage stays cacheable.

## Fix

Mirror the billing-side rule exactly in a new `isUnbilledContentFilterResponse(response, body)` guard, OR-ed into the capture-stream write gate next to `isStreamingErrorResponse`:

- parse the body (JSON) or every SSE `data:` frame;
- if **any** event carries a usage object, the filtered completion is billable → cacheable (the billing side's `hasUsage` is request-scoped, so a usage frame anywhere in the stream lifts the gate — matching `include_usage` streams that report usage on a separate final frame);
- otherwise, if any choice finishes with `finish_reason === "content_filter"` → refuse the write.

The guard is a separate function at the single call site, so this branch and the issue-40 branch (`solution34`) merge independently — the union of the two covers every finish-reason the billing-side scan rejects.

## Verification

- `test/text-cache-content-filter.test.ts`: 5/5 green on the branch; the two refusal tests red on unpatched `6989f4bb64` (verified by running the identical file against main).
- Existing `test/text-cache.test.ts`: 20/20.
- `tsc --noEmit`: clean.

# Issue 92 — The text error funnel (`throwTextError`) drops client-attached `billedUsage`: every text-pipeline paid failure settles $0 before the settlement middleware can read it

- **Severity:** High (billing integrity — the companion piece that makes the paid-failure settlement family actually function end-to-end on the text pipeline; without it, issue 88's sites, issue 95's attempt settlement for the request-ending leg, and the handler's own empty-completion billing promise are all silently neutralized)
- **Affected:** `gen.pollinations.ai/src/text/errors.ts` (`throwTextError:34-58` — the route-boundary funnel every text-client error passes through via `text/handler.ts:467-468`, `responses/handler.ts:341`, `decisions/handler.ts:72`), `gen.pollinations.ai/src/text/types.ts` (`ServiceError`) — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution91-text-error-funnel-billedusage` — fork PR [#108](https://github.com/NamanSoni78/pollinationsai/pull/108)
- **Dedup:** issue 88 (PR #100) owns the Vercel two-step-search finding and fixes its `vercelSearch.ts` throw sites — but its diff contains no `errors.ts` change, so the `billedUsage` its sites attach to ServiceErrors is stripped by this funnel before `track.ts:793-798` reads it (verified by diffing `solution78-vercel-search-step1-settlement`). Issue 91's "rewrap" fix is the image-pipeline-local catch in `vercelGeminiImageModel.ts:123-141` — a different rewrap; the text funnel here is untouched by every filed branch. Round 26's "billedUsage plumbing verified clean" disposition missed this re-wrap (demonstrated red below). This report is the fix-coverage-gap companion in the issue-76/88 convention: the sites are theirs, the propagation is this branch's, zero file overlap.

## Root cause

The settlement middleware bills a failed request only from `error.billedUsage` on the request-ending error (`middleware/track.ts:793-798`). The text pipeline's route boundary re-wraps **every** client error before that read:

```ts
// text/handler.ts:467-468 (same shape in responses/decisions handlers)
} catch (thrown: unknown) {
    throwTextError(thrown as ServiceError);
}
```

`throwTextError` builds a **fresh** `UpstreamError`, copying `errorCode`, `requestUrl`, `upstreamStatus`, `responseBody`, `upstreamHeaders` — and dropping `billedUsage`. So any paid failure a text client reports (the documented convention `UpstreamError.billedUsage` exists for, and the ServiceError shape issue 88's sites attach) is silently waived:

- `text/handler.ts:199-205`'s empty-completion throw attaches `billedUsage` (`openaiUsageToUsage(result.usage)`) — the schema doc promises `output_token_limit_exceeded` usage is billed; the funnel strips it before the settlement, so that promise never lands today;
- issue 88 / PR #100's `vercelSearch.ts` sites attach `billedUsage` to ServiceErrors — stripped the same way;
- any future text client adopting the convention is neutralized identically.

## Safe reproduction (isolated, red on unpatched main)

Route-level harness mirroring the real boundary (a tracked app whose handler throws a paid ServiceError through `throwTextError`, exactly the `text/handler.ts` catch shape):

```ts
app.post("/v1/chat/completions", track("generate.text"), () => {
    try {
        throw Object.assign(new Error("...empty response..."), {
            status: 502, upstreamStatus: 502, errorCode: "empty_response",
            billedUsage: { promptTextTokens: 100000, completionTextTokens: 20000 },
        });
    } catch (thrown) { throwTextError(thrown as ServiceError); }
});
// on unpatched main: the row is isBilledUsage:false and the balance is
// unchanged — the 100K/20K paid usage never settles. RED.
```

Verified red on unpatched main before the fix was written; green with it (`test/tracking-observability.test.ts` "settles a client-paid failure only when the error funnel propagates billedUsage"). The unit suite `test/text/text-error-funnel.test.ts` pins the wrap preserving `billedUsage` and leaving ordinary errors unbilled (red on unpatched `errors.ts`, verified via stash before/after).

## Fix (`solution91-text-error-funnel-billedusage`)

- `text/errors.ts`: `throwTextError` propagates the `ServiceError`'s `billedUsage` onto the wrapped `UpstreamError` — one more option alongside the existing propagated fields.
- `text/types.ts`: `ServiceError` gains the optional `billedUsage?: Usage` (the same option `UpstreamError` carries, giving client-side attaches a typed home).

Composes with issue 88 / PR #100 and issue 95 / PR #105 with zero file overlap: their branches touch `vercelSearch.ts` and `track.ts` respectively; this one touches `errors.ts`/`types.ts`.

## Verification

- Route-level proof (above): `isBilledUsage: true`, `tokenCountPromptText: 100000`, wallet deduction equals the event's charged pollen — green with the fix.
- Full text suite 968/968, tracking-observability + funnel 123/123, `tsc --noEmit` clean. Live probes: $0 (deterministic offline).

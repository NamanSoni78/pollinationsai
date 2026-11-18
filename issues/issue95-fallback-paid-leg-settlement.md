# Issue 95 — A fallback-rescued request drops the paid leg's `billedUsage`: the settlement charges only the last attempt, so a paid provider failure bills the caller $0 whenever a fallback follows

- **Severity:** High (billing integrity — 100% of the rescued paid leg's charge per occurrence, prompt-size-amplifiable; the trigger is the production-observed empty-completion anomaly class the repo built billing for twice: #18603/#18692)
- **Affected:** `gen.pollinations.ai/src/middleware/track.ts:355-397` (the attempts loop — non-settled attempt rows are emitted `isBilledUsage: false` with no settlement) + `:475-465` (the single `handleBalanceDeduction` covers only the final settlement row) — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution86-fallback-paid-leg-settlement` — fork PR [#105](https://github.com/NamanSoni78/pollinationsai/pull/105)
- **Dedup:** the settlement-loss family's filed instances are per-client throw sites (issues 25/72/81/82/88/90/91 — media/model3d/route/vercelSearch) and issue 92 fixes the funnel that drops the request-ending error's attach. This finding is a different root cause in a different file: the **settlement loop itself** discarding the `billedUsage` the loop's own attempt errors already carry. No prior round's branch touches `track.ts`'s attempts loop (round 24's billing sweep checked the deduction ladder's atomicity and reservation releases — clean — but not the attempt-row settlement direction).

## Root cause

`generateChatAttempt` attaches the provider-reported usage to its empty-completion `UpstreamError` (`text/handler.ts:199-205`, `billedUsage: openaiUsageToUsage(result.usage)`) — the platform bills these anomalies by design (the schema doc makes the contract explicit: `shared/schemas/openai.ts` — "When an explicit limit is exhausted and every choice has no answer … Provider-reported usage, including reasoning tokens, is billed"). The fallback loop records such a failure as a **non-settled** attempt and moves on (`fallback.ts:406-415` — a 502 is retryable, so `shouldFallback` is true), and the settlement reads `error.billedUsage` only for the **request-ending** error (`track.ts:793-798`):

```ts
for (const attempt of attempts) {
    if (attempt.settled) continue;
    await emitRow({ ... responseTracking: {
        ...trackJsonErrorUsage(...),
        isBilledUsage: false,   // ← the paid leg settles $0, always
        isFinal: false, ...
```

Two loss variants:

- **Variant A (rescue):** the primary 502s with valid usage; the fallback succeeds → the final settlement bills only the fallback's usage; the primary's paid usage is emitted as an unbilled telemetry row with no deduction — the user keeps their pollen AND receives the fallback answer, the platform pays both providers.
- **Variant B (double failure):** the primary 502s paid; the fallback fails terminally without `billedUsage` → the request-ending error is the fallback's → the primary's attached `billedUsage` is discarded unread → the user pays $0 for a request on which the platform paid the primary in full.

Impact per occurrence: the entire provider cost of the rescued leg — `openai/gpt-5.5` at $5/M input / $30/M output ≈ **$1.10/request** at 100K/20K tokens, prompt-bound worst case (32 MiB body) ≈ **$20**; every fallback-enabled text route and caller model list runs this loop.

## Safe reproduction (isolated, red on unpatched main)

The `tracking-observability.test.ts` harness already models a non-settled primary + settled fallback (`createSseStreamApp`); the two new cases push the exact object `handler.ts:199-205` throws (`UpstreamError.fromProvider(502, { errorCode: "empty_response", billedUsage: { promptTextTokens: 100000, completionTextTokens: 20000 } })`):

- Variant A: **RED on unpatched main** — the primary row is `isBilledUsage: false` and the balance drops only by the fallback's 1000/500-token price;
- Variant B: **RED** — balance unchanged by the paid primary; the primary's row unbilled.
- Control: a non-paid primary failure (plain ServiceError, no `billedUsage`) rescued by a fallback stays `isBilledUsage: false` — pinned unchanged (the existing "separates a rescued stream's attempt duration" test).

## Fix (`solution86-fallback-paid-leg-settlement`)

The attempts loop settles each moved-on attempt whose error carries `billedUsage` (guarded by the implausible-proxy-usage clamp exactly like the request-ending path, priced against the attempt's own candidate sheet via `calculateUsageBilling`). The single `handleBalanceDeduction` runs on the **summed** total (the final settlement plus every billed attempt), and each billed attempt row carries its share of the charged pollen (proportional to its sheet price) with the final row taking the remainder — one atomic D1 deduction, per-attempt attribution. Non-paid failures stay free exactly as today. Community-reward attribution deliberately remains tied to the served endpoint (the conservative direction — a failed attempt mints no publisher reward).

Composes with issue 92 / PR #108 (the funnel covers the request-ending error path; this covers the attempt rows, which read the raw loop errors pre-funnel — the branches touch disjoint files).

## Verification

Two new cases (variants A/B above) — red on unpatched main, green with the fix (row billed with the paid leg's tokens; balance reflects both legs / the paid primary alone). tracking-observability 122/122 (all pre-existing cases unchanged), fallback 50/50, static-provider-fallbacks 125/125, `tsc --noEmit` clean. Live probes: $0 (deterministic offline).

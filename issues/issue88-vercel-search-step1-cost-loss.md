# Issue 88 — Vercel two-step search: the paid search step's charge is discarded whenever the formatting step fails

- **Severity:** Medium-High (billing integrity: the platform pays Vercel for the search generation — Exa tool calls at $7/1K requests on the gateway's own meter — plus the formatting generation whenever it ran, while the caller is settled $0 on every post-search failure)
- **Affected:** `gen.pollinations.ai/src/text/vercelSearch.ts` (reached from `google/gemini-2.5-flash-lite:search` and its public aliases `gemini-search`/`google-search`/`gemini-2.5-flash-lite-search`, via the hidden `:search:vercel` route whose transform injects the `exa_search` tool) — upstream `pollinations/pollinations` main @ `282ac54aeb` (2026-11-18)
- **Fix branch:** `solution78-vercel-search-step1-settlement` — fork PR [#100](https://github.com/NamanSoni78/pollinationsai/pull/100)
- **Dedup:** the settlement-loss family has filed instances for media clients (issues 25/72/81/82), grok-OR receipts (issue 53) and the model3d fleet (issue 81) — all media/model3d-only. Round 18's text-pipeline audit recorded this exact site as a below-gate near-miss ("Vercel two-step search loses step-1 provider cost when step 2 fails — same below-gate family as OpenRouter Gemini TTS 502-after-paid"); no issue owns it. This is the last unfiled member of the family.

## Root cause

Gemini 2.5 cannot combine tools with controlled JSON generation, so any non-text `response_format` request on the search route runs **two** sequential provider generations (`callVercelSearch`):

1. **Search step** (`vercelSearch.ts:62-81`): the full message list plus an injected exa-search instruction, tools enabled, `stream: false`. Its usage — **including Vercel's reported `usage.cost` provider charge, required > 0 by `requireUsage`** — is captured into `searchUsage` at line 81.
2. **Formatting step** (`:88-98`): the search answer re-sent for JSON formatting.

`requireUsage` proves the paid event: it throws unless the search completion carries a finite, non-negative `cost` — so at every later failure the provider charge is **in hand one line above the throw**. But all three post-search failure sites discarded it:

| Site | Trigger | Charge lost |
|---|---|---|
| `:83-87` | search answer empty (`content` null/blank) → 502 | step 1's full usage + cost |
| `:88-98` | formatting call fails at the provider (503/5xx — a normal operational event) | step 1's charge (step 2's own charge, if it ran, is additionally unknowable) |
| `:101` / `:115` / `:150` | formatting answer omits usage or its `cost` (`requireUsage` throws) | step 1's charge + step 2's tokens when present |

`middleware/track.ts:793-798` settles a failed request only from `error.billedUsage` — none of these throws carried it, and `trackJsonErrorUsage` cannot help (no `responseBody`, and its recovery is analytics-only anyway: only `billedUsage` triggers `handleBalanceDeduction`).

## Safe repro (isolated, red on unpatched main)

```ts
// test/text/vercelSearch.test.ts (new describe block)
const { config } = upstream([
    Response.json(completion(firstUsage)),              // search: usage.cost = 0.007018 — PAID
    Response.json({ error: { message: "Unavailable" } }, { status: 503 }), // formatting fails
]);
const error = await callVercelSearch(messages, options, config).then(() => { throw new Error("expected rejection"); }, (e) => e);
expect(error.billedUsage).toEqual(openaiUsageToUsage(firstUsage)); // RED on main: undefined
```

The empty-answer and omitted-usage variants reproduce identically (7 new cases total, all asserting `billedUsage: undefined` on unpatched main).

## Fix

Convert the search usage once (`openaiUsageToUsage` — the same converter the empty-completion precedent at `text/handler.ts:199-205` uses) and attach it at every post-search failure:

- empty search answer → the search step's converted usage;
- formatting-step provider error → same, re-thrown on the original error object (status/message/responseBody preserved; plain `Error`s are wrapped into 502 `UpstreamError`);
- formatting answer with tokens but no charge → **both steps' tokens summed** (`sumUsage`; the converter drops the dollar `cost` and bills registry rates);
- an error that already carries its own `billedUsage` → the search usage is **added on top** field-wise, never overwritten.

Pre-search failures (invalid search usage, failed search call) still settle nothing — pinned by a control test. The streaming `[DONE]`/`flush` legs are deliberately untouched: they fire mid-stream after a 200, where the platform's tracking deliberately does not bill earlier usage (pinned by `tracking-observability.test.ts:3621`) — a product decision, recorded here as the residual.

## Tests

7 new cases in `test/text/vercelSearch.test.ts` — all red on unpatched main, green with the fix; the 18 pre-existing cases unchanged (the "rejects a formatting answer without usage" case still rejects with the same message, now carrying the settlement). `generateTextPortkey` / `genericOpenAIClient` / `tracking-observability` suites 256/256 green; `tsc --noEmit` clean. No live-probe spend: the reproduction is fully isolated (the route is `paidOnly` for the formatting leg's provider; the search charge itself is proven by the code's own `requireUsage` gate).

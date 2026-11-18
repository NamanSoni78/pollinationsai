# Issue 49 — Companion coverage: the Vercel-gateway vision fleet's deferred remainder + the seventh fallback image line (`kimi-k3.1-pro-highspeed`, `muse-spark-1.2/1.3`, `hy4-flash:openrouter`)

- **Severity:** Medium (same class as issue 46 — caller-forcible free vision input on `paidOnly` models and unbilled serving-side image cost on a fallback route; narrower fleet, so companion severity)
- **Affected:** `shared/registry/text.ts` (`moonshotai/kimi-k3.1-pro-highspeed`, `meta/muse-spark-1.2`, `meta/muse-spark-1.3`) and `shared/registry/text-fallbacks.ts` (`tencent/hy4-flash:openrouter`) — upstream `pollinations/pollinations` main @ `a38014db9d` (2026-11-18)
- **Fix branch:** `solution42-vercel-vision-fleet-companion` (stacked on `solution39-vision-input-token-billing`, PR #54's branch) — **PR:** [#57](https://github.com/NamanSoni78/pollinationsai/pull/57)
- **Relationships:** companion to issue 46 (PR #54) and issue 47 (PR #55) — graduates the three Vercel-gateway models issue 46's follow-up list deferred, and adds the fallback image line issue 47's six-route sweep missed. Found independently by this session (cron 535998) before the concurrent sessions' round-14 pushes were observed; the independent implementation was used as cross-validation of theirs and vice versa.

## Summary

Issue 46 fixed seventeen primary sheets but deferred the rest of its follow-up list as "reporting shape needs a one-request confirmation per provider". Three of the deferred models sit on the **same Vercel AI Gateway** whose reporting shape issue 46 already relied on to justify `tencent/hy4-flash` (the priced siblings `meta/llama-4-scout` and `google/gemini-2.5-flash-lite` carry `promptImageTokens` on that gateway — the rates would be dead lines otherwise):

| Model | promptTextTokens | promptImageTokens (pre-fix) | paidOnly |
|---|---|---|---|
| `moonshotai/kimi-k3.1-pro-highspeed` | $4/M | **missing** | true |
| `meta/muse-spark-1.2` | $1.25/M | **missing** | true |
| `meta/muse-spark-1.3` | $1.25/M | **missing** | true |

The same deferral note missed that issue 46's own `hy4-flash` fix widened a **fallback** gap: `tencent/hy4-flash:openrouter` restates only four of the primary's five rates, so once the primary gained its image rate (#54), the OpenRouter route became the seventh "drops the primary's image line" case of issue 47's sweep (which found six).

## Verification (non-destructive)

1. **Red test on the real modules** (pre-fix, at `a38014db9d` + #54): the three models fail issue 46's own `it.each` ("bills provider-reported image input tokens") — `expected undefined to be defined` — and `calculateUsageBilling` bills 76 provider-reported image tokens at $0.00 on each; the `hy4-flash:openrouter` route fails the served-cost case (image cost line 0). Green post-fix: `vision-input-token-billing` + `static-provider-fallbacks` **150/150**, effective-prices snapshot regenerated, `tsc` clean.
2. **Live probe of the machinery (own key, 2026-11-18):** `moonshotai/kimi-k3.1-pro` — the Azure twin of the highspeed route's model, already priced — shows the platform's split end-to-end: `x-usage-prompt-image-tokens: 361`, `prompt_tokens: 463 = 102 text + 361 image`, billed at $2.3/M.
3. **Independent full-suite validation:** this session's standalone implementation of the same class (this fleet + #54's) ran the complete `gen.pollinations.ai` suite **3661/3661 green** with `tsc` clean before the stacked companion was built.
4. **Fold controls (live, same day):** `mistralai/mistral-large-3` folds image tokens into `prompt_tokens` on Azure (512px: `392 = 14 text + ~378 image`; 64px: `24 = 14 + ~10`; no details split at either size) — no split, no zero-billing on that **primary**; see the correction posted on PR #54 (the issue-46 live-verification paragraph overstates the primary gap; the `:aws` route does split and is correctly fixed). Anthropic-via-Vercel models are legitimately rate-less for the same reason.

## Fix

One rate line per entry, all at the input-text-rate convention: `kimi-k3.1-pro-highspeed` $4/M, `muse-spark-1.2`/`1.3` $1.25/M, and `hy4-flash:openrouter` at list × 1.055. Stacked on PR #54's branch so the two PRs merge sequentially with no snapshot conflict; if #57 lands first, #54's fleet commit still applies cleanly (different model entries, additive lines).

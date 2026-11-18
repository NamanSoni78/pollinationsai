# Issue 47 — Fallback cost sheets: nine routes inherit the parent's discount onto their own list rates, six drop the primary's image line, `liquid/d1.2` drops the cached line

- **Severity:** Medium (internal cost ledger and servedPrice under-report 25-71% on rescued requests; the public effective-prices snapshot documents wrong numbers; caller quotes are unaffected — `quotedBy` keeps the primary's price)
- **Affected:** `shared/registry/text-fallbacks.ts` (15 routes) and `shared/registry/text.ts` (`liquid/d1.2`) — upstream `pollinations/pollinations` main @ `a38014db9` (2026-11-18)
- **Fix branch:** `solution40-fallback-cost-sheet-completeness` — **PR:** [#55](https://github.com/NamanSoni78/pollinationsai/pull/55)
- **Relationships:** issue-37 pattern (GPT-6.2 AWS fallback multiplier, `solution33` / PR #42) new instances; the `qwen/qwen4-max:vercel` image line is concurrently fixed by issue 45 / PR #50 — this branch carries the identical one-liner plus five sibling routes, so either PR merges and the other resolves trivially. `mistral-large-3:aws`'s image rate ships with issue 46's branch (PR #54); its multiplier ships here.

## Summary

Three systematic gaps in the fallback cost sheets:

**(a) Inherited discounts.** `mergeFallbacks` (`shared/registry/merge-fallbacks.ts:74-82`) spreads `...inherited, ...overrides` — `priceMultiplier` inherits from the parent when a route doesn't set its own. Nine routes that override `cost` with **their own provider's list sheet** silently inherit the parent's Azure/promo discount and under-report `servedPrice` (served cost × multiplier) on every request they serve:

| route | inherited | servedPrice error |
|---|---|---|
| `x-ai/grok-4.20:openrouter:xai-zdr` | 0.75 (Azure) | −25% |
| `mistralai/mistral-large-3:aws` | 0.75 (Azure) | −25% |
| `moonshotai/kimi-k3.1-pro:vercel` | 0.75 (Azure) | −25% |
| `meta/llama-3.3-70b-instruct:deepinfra` | 0.75 (Azure) | −25% |
| `deepseek/deepseek-v4-flash:deepinfra` | 0.75 (Azure) | −25% |
| `nvidia/nemotron-3.5-lightning:deepinfra` | 0.75 (Azure) | −25% |
| `nvidia/nemotron-3-ultra:deepinfra` | 0.75 (Azure) | −25% |
| `deepseek/deepseek-v4.1-flash:fireworks` | 0.5 (Azure promo) | −50% |
| `deepseek/deepseek-v4.1-flash-1017:fireworks` | 0.5 (Azure promo) | −50% |

None of the nine documents a matching deal on the fallback provider — every rate comment cites the fallback provider's standard list rates. The sibling `x-ai/grok-4.3:openrouter:xai-zdr` sets `priceMultiplier: 1` on an **identical** sheet, and the maintainers' own invariant test (`static-provider-fallbacks.test.ts:676-701`) pins `priceMultiplier: 1` for the gpt `:aws` family for exactly this reason — a fallback that defines its own cost serves at that provider's real rates.

**(b) Dropped image lines.** Six routes override `cost` but drop the `promptImageTokens` line their primaries price (cost replaces wholesale — no per-field merge): `qwen/qwen4-max:vercel` ($1.5/M), `xiaomi/mimo-v2.6-flash:deepinfra` ($0.14/M), `xiaomi/mimo-v2.6-pro:deepinfra` ($0.387/M), `deepseek/deepseek-v4.1-flash:fireworks` ($0.3/M), `deepseek/deepseek-v4.1-flash-1017:fireworks` ($0.3/M), `moonshotai/kimi-k3.1-pro:vercel` ($2/M). When the route serves, the image cost vanishes from the cost ledger and servedPrice — 10k image tokens on `qwen4-max:vercel` record **$0.006 instead of $0.021 (71% of the provider cost invisible)**.

**(c) `liquid/d1.2` cached line.** The d1 sibling prices `promptCachedTokens: perMillion(0.02)` ("Liquid publishes the same $0.02/M ordinary and cached input price through Vercel"); d1.2 — added in `abb5b141e` (#19989) — omits it, although `systemOneClient.ts` parses `input_tokens_details.cached_tokens` for this route family and the decisions engine re-posts cached state by design: 100k cached state tokens bill $0.00001 instead of $0.00201 (99.5% under-billed).

## Root cause

```ts
// shared/registry/text-fallbacks.ts — grok-4.20 route (pre-fix; sibling 4.3 sets 1):
"x-ai/grok-4.20:openrouter:xai-zdr": {
    supportedParameters: …, provider: "openrouter",
    // ← no priceMultiplier → inherits the Azure primary's 0.75
    cost: { promptTextTokens: perMillion(1.25) * 1.055, … }   // OpenRouter list rates

// shared/registry/merge-fallbacks.ts:74-82 — the inheritance:
merged[routeId] = { ...inherited, ...overrides, aliases: [], hidden: true, fallbackOnly: true };
```

## PoC (isolated red test on the real modules; pre-fix results)

New `gen.pollinations.ai/test/fallback-cost-sheet-completeness.test.ts` — all 17 cases fail on unpatched `a38014db9`:

- `expected 0.75 to be 1` — all nine routes inherit the parent discount (grok-4.20, mistral-large-3:aws, kimi-k3.1-pro:vercel, the deepseek fireworks pair at 0.5, llama-3.3-70b, nemotron pair, deepseek-v4-flash);
- `expected 0.198802… to be close to 0.265069…` — a rescued grok-4.20 request (100k prompt + 1k image + 50k completion) records servedPrice at 0.75 × cost instead of cost;
- `expected undefined to be defined` — all six image-dropping routes;
- `expected 0 to be close to 0.005` — 10k image tokens served by `mistral-large-3:aws`… (that route's image rate ships with issue 46's branch; on this branch the equivalent qwen4-max case shows `expected 0.006… to be close to 0.021…`);
- `expected 0.00001… to be close to 0.00201` — d1.2 cached state under-billed.

The repo's own `expectInheritedRoute` invariant ("needs a quoted parent rate") passes for all six image routes — the primaries are priced; only the route sheets drop the line.

## Impact

`servedPrice` under-reports by 25-50% on every request the nine routes rescue, and the image/cached cost lines vanish when the other seven serve. `servedPrice` bounds community rewards and feeds margin analysis; the public effective-prices snapshot documents the wrong served prices for all 15 routes. Callers keep the primary's quote throughout (`calculateUsageBilling` rates `quotedBy` independently), so no caller overpays — this is the platform's internal ledger integrity.

## Fix

`priceMultiplier: 1` on the nine routes (they serve at their provider's list rates — same rule as the gpt `:aws` family and the grok-4.3 sibling), `promptImageTokens` at each route's own list input rate on the six image-dropping sheets, `promptCachedTokens: perMillion(0.02)` for `liquid/d1.2`. Snapshot regenerated. Post-fix: the new suite 17/17 green (9 multiplier + 1 servedPrice + 6 image + 1 d1.2), `static-provider-fallbacks` and surrounding billing suites 221+ green, `tsc --noEmit` clean.

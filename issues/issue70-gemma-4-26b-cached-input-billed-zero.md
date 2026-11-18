# Issue 70 — gemma-4-26b bills cached input tokens at $0 (missing rate-sheet line) and trails OpenRouter's published rates on the prompt line

- **Severity:** Medium (systematic undercharge on the cache-read line — the registry-parity class of issues 45/46/47/49/52/62)
- **Affected:** `shared/registry/text.ts` (`google/gemma-4-26b-a4b-it` cost sheet) — upstream `pollinations/pollinations` main @ `6989f4bb64`
- **Status:** Verified red→green by a new registry-level suite over the real extraction and billing path (3/3 red on unpatched main, 3/3 green with the fix); effective-prices snapshot regenerated (this model's rows only); `byop-markup` 41/41, `docs` 26/26, `realtime` 43/43, `model-permissions` 20/20, `index`/`e2b`/`modelResolver` 252/252 green; gen `tsc --noEmit` clean (enter `tsc` carries two pre-existing frontend errors on unpatched main)
- **Fix branch:** `solution65-gemma-4-26b-cached-rate-sheet` (branch number predates the renumber below) — **PR:** [#82](https://github.com/NamanSoni78/pollinationsai/pull/82)

## Summary

OpenRouter publishes a cache-read price for `google/gemma-4-26b-a4b-it` — `input_cache_read` = **$0.05/M tokens** (`openrouter.ai/api/v1/models`, verified 2026-11-18) — and meters cached input through `usage.prompt_tokens_details.cached_tokens`, which the worker normalizes onto the `promptCachedTokens` line (`shared/registry/usage-headers.ts` `OPENAI_CHAT_USAGE_PATHS`). The model's cost sheet carried **no rate for that line**, and the registry's `convertUsage` bills a usage type with no rate as **zero** (`shared/registry/registry.ts:266-290`, with only a console warning): every cached token on this model settled free to the caller while OpenRouter charged the platform for it. The sibling `google/gemma-4-31b-it` sheet already documents the fleet convention — "cached input uses the full input rate (2026-10-24)" — i.e. a model whose provider meters cache reads carries the line at the provider's price. The 26b sheet also trailed today's published rates on the prompt line ($0.07 vs $0.09) and the completion line ($0.34 vs $0.30).

## Root cause

```ts
// shared/registry/text.ts (pre-fix)
"google/gemma-4-26b-a4b-it": {
    cost: {
        // OpenRouter DeepInfra FP8; rates verified 2026-10-22.
        promptTextTokens: perMillion(0.07) * 1.055,   // no promptCachedTokens line
        promptImageTokens: perMillion(0.07) * 1.055,
        completionTextTokens: perMillion(0.34) * 1.055,
    },
```

The billing chain, verified end-to-end in the repro below:

1. OpenRouter's OpenAI-compatible response reports `usage.prompt_tokens_details.cached_tokens` (this is what its `input_cache_read` price applies to).
2. `openaiUsageToUsage` detects the **inclusive** convention and carves the cached subset out of the prompt headline: a 1,000,000-token prompt with 100,000 cached normalizes to `{promptTextTokens: 900_000, promptCachedTokens: 100_000}`.
3. `convertUsage` looks up `rateDefinition["promptCachedTokens"]`, finds `undefined`, and returns **0** for the line ("Missing conversion rate … billing 0 for this line").
4. The caller is charged only 900k × the text rate; the platform pays OpenRouter 900k × $0.09×1.055/M (prompt) + 100k × $0.05×1.055/M (cache read).

Numbers for that request: pre-fix collection **$0.066465** (the old $0.07×1.055 text rate, cached free) vs provider charge **$0.09073** → the platform absorbs **$0.024265 (26.8% of the true cost) per request**, growing linearly with the cached fraction. Post-fix collection = $0.09073 (exact parity, priceMultiplier 1).

## Evidence

- OpenRouter public API (machine-readable, anyone can re-run): `curl -s https://openrouter.ai/api/v1/models` → `google/gemma-4-26b-a4b-it`: `prompt` $0.09/M, `input_cache_read` **$0.05/M**, `completion` $0.30/M (fetched 2026-11-18).
- The repo's own convention that this model's cached line should exist and track the provider: the 31b sibling's comment and rate (`promptCachedTokens` priced, 2026-10-24), and every OpenAI/Anthropic-route sheet in the registry prices its cache-read line wherever the provider meters one.
- The zero-billing semantics for missing rates are explicit in `convertUsage`'s comment: "Throwing here drops the whole tracking event and creates a silent billing leak" — billing 0 is the deliberate fail-safe, which makes a *missing rate line* a silent revenue leak.

## Safe repro (isolated, non-destructive; red on unpatched `6989f4bb64`)

`gen.pollinations.ai/test/text/gemma-cached-rate.test.ts` (new, 3 tests — all three red pre-fix, green post-fix):

1. **Billing path:** `openaiUsageToUsage({prompt_tokens: 1_000_000, prompt_tokens_details: {cached_tokens: 100_000}})` → `calculateUsageBilling` on the real registry definition → asserts the cached line charges `100_000 × $0.05×1.055/1M` and the total equals the full published-rate price. Pre-fix: `cost.promptCachedTokens === 0` and the total is short by the whole cached subset plus the stale prompt-rate delta.
2. **Sheet parity:** all four cost lines equal the published OpenRouter rates ×1.055 (prompt 0.09, cached 0.05, image 0.09, completion 0.30).
3. **Fleet invariant:** every primary `google/gemma-*` sheet prices its cache-read line within (≤) its input rate — pre-fix, the 26b entry fails with "cache-read line missing or zero".

## Fix (`solution65-gemma-4-26b-cached-rate-sheet`, PR #82)

`shared/registry/text.ts`: add `promptCachedTokens: perMillion(0.05) * 1.055` (the published cache-read rate plus the 5.5% credit-purchase fee) and resync the remaining lines to today's published rates — `promptTextTokens`/`promptImageTokens` $0.07→$0.09, `completionTextTokens` $0.34→$0.30 (×1.055) — with the source URL and verification date in the comment, matching the sheet's own dated-verification convention. The `enter` effective-prices snapshot is regenerated (only this model's rows change: adds the cached line, updates the two resynced rates).

## Not fixed here (documented residual)

The `google/gemma-4-26b-a4b-it:deepinfra` fallback sheet (`shared/registry/text-fallbacks.ts`) has the **same missing-line shape** on the direct-DeepInfra route, but DeepInfra's current cache-read price for this model is not published in machine-readable form (the model page is JS-rendered; the public catalog endpoint does not list the model), so no evidence-backed rate can be pinned today. Filing a guessed rate would violate the verification gate. Follow-up path: once DeepInfra's rate is observable (page scrape of the rendered pricing, or a receipt from a live call), mirror this fix on the fallback sheet. No other `google/gemma-*` route is affected (the 31b primary and its `:deepinfra` fallback both carry a cached line).

**PR:** https://github.com/NamanSoni78/pollinationsai/pull/82 (upstream PR creation rejected `403` with this token, as every prior round — the fork PR is the review surface)

> Renumber note (2026-11-18): this report was first written as `issue65` in parallel with session 17 (cron 536173), which registered issues 65-69 (`issue65-images-b64-video-oom.md` … `issue69-dungeon-master-key-in-image-urls.md`). Renumbered to **issue 70**, content unchanged; the fix branch keeps its `solution65-*` name per the immutable-branch convention, and fork PR #82 is unchanged.

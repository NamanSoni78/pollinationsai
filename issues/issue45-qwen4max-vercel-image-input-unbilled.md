# Issue 45 — Qwen 4 Max `:vercel` fallback bills image input tokens at $0 (route sheet omits the `promptImageTokens` rate its primary defines)

- **Severity:** High (systematic under-billing on a `paidOnly` flagship model's only fallback route; the platform still pays the gateway for those tokens)
- **Affected:** `shared/registry/text-fallbacks.ts` (`qwen/qwen4-max:vercel`, introduced in `68717eba2b` / #19889) — upstream `pollinations/pollinations` main @ `8dd9e0ed`
- **Fix branch:** `solution45-qwen4max-vercel-image-token-billing` — **PR:** [#50](https://github.com/NamanSoni78/pollinationsai/pull/50)

## Root cause

The primary `qwen/qwen4-max` (Alibaba direct, `shared/registry/text.ts:4110-4138`) is `inputModalities: ["text", "image"]`, `paidOnly: true`, and — via the commit's own follow-up fix ("bill Alibaba Qwen 4 Max image input tokens") — prices `promptImageTokens: perMillion(1.5)`. The `:vercel` fallback route carries the comment "Vercel AI Gateway lists the same Alibaba rates, with no gateway fee" and mirrors the other four rates exactly, but omits the image line:

```ts
// shared/registry/text-fallbacks.ts — qwen/qwen4-max:vercel (pre-fix)
cost: {
    // ← no promptImageTokens
    promptTextTokens: perMillion(1.5),
    promptCachedTokens: perMillion(0.075),
    promptCacheWriteTokens: perMillion(1.875),
    completionTextTokens: perMillion(4.5),
},
```

`mergeFallbacks` replaces the parent's `cost` wholesale (no per-field merge), so the route's effective sheet has no image rate — provable from the committed `effective-prices` snapshot at HEAD (`qwen/qwen4-max:vercel` cost lists exactly four keys). The route inherits `inputModalities: ["text", "image"]` (not overridden), and `fallbackCompatibility` only rejects images for text-only models, so image-bearing requests route through it. Settlement then hits `convertUsage` (`shared/registry/registry.ts:266-290`), which **zero-fills any usage line with no rate in the sheet** (console.warn only — its own comment calls this the "silent billing leak" hazard), while `openaiUsageToUsage` (`shared/registry/usage-headers.ts:76`) maps `prompt_tokens_details.image_tokens` into `promptImageTokens`. Net effect: image tokens served by the Vercel route bill at **$0**.

That this is an oversight and not policy is provable in three ways from the same commit: (1) the follow-up image-rate fix was applied to the primary only, never the route; (2) the route mirrors every other rate of the primary exactly; (3) the repo already prices `promptImageTokens` on other Vercel routes (e.g. `google/gemini-2.5-flash-lite`, `text.ts:55`), so the gateway's split image-token reporting is an established billing input. Same mechanism as issue 34 (`openai/gpt-6.2-astra`, PR #39) on a new model and a new route.

## Safe repro (isolated, non-destructive)

No live call needed — the billing path is pure over the registry. New test `gen.pollinations.ai/test/text/qwen4max-vercel-image-token-billing.test.ts` against the real `TEXT_SERVICES` / `calculateUsageBilling` modules. Pre-fix run (reproduced on unpatched `8dd9e0ed`):

- `expected undefined to be defined` — the route sheet has no `promptImageTokens` while the route accepts image input;
- `expected 0.00195 to be close to 0.00495` — 2000 image tokens at the primary's $1.5/M contributed exactly **$0.00** to the served cost.

Post-fix: 2/2 green.

## Fix

One line — carry the primary's rate onto the route sheet (`promptImageTokens: perMillion(1.5)`, matching the primary's field order) — plus the regenerated `effective-prices` snapshot (the `:vercel` cost/price rows gain the key). Regression cover: `static-provider-fallbacks` + `modelResolver` 262/262, `tsc --noEmit` clean.

## Impact

Every image-bearing `qwen/qwen4-max` request served by (or failed over to) the Vercel route bills its vision input at $0 while the gateway bills the platform for it. With the default 8-image cap and a 1M-token context, a single request can carry tens of thousands of image tokens (at $1.5/M list); repeated at scale this is a systematic revenue leak on the model's only fallback route.

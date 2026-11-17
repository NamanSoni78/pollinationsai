# Issue 34 — GPT-6.2 Astra and GPT-6 Astra bill vision input tokens at $0 (missing `promptImageTokens` rate while the same route's Sol siblings define it)

- **Severity:** High (systematic under-billing on a `paidOnly` flagship model; direct platform revenue loss on every vision request)
- **Affected:** `shared/registry/text.ts` (`openai/gpt-6.2-astra` introduced in `6538ea2721` / #19981; pre-existing `openai/gpt-6-astra` from `8496ddab3f`) — upstream `pollinations/pollinations` main @ `6538ea2721`
- **Fix branch:** `solution30-gpt62-astra-image-token-billing` — **PR:** [#39](https://github.com/NamanSoni78/pollinationsai/pull/39)

## Root cause

Both Astra generations accept image input (`inputModalities: ["text", "image"]`, `maxReferenceImages: 10`) on the same Azure Responses routes (`myceli-prod-eastus`, `azureOpenAIParameters`) as their Sol siblings, but their cost sheets omit `promptImageTokens`:

```ts
// shared/registry/text.ts — openai/gpt-6.2-astra (pre-fix)
cost: {
    promptTextTokens: perMillion(8),
    promptCachedTokens: perMillion(0.4),
    promptCacheWriteTokens: perMillion(10),
    // ← no promptImageTokens
    completionTextTokens: perMillion(40),
},
```

The usage pipeline is model-agnostic: `responsesUsageToUsage` → `openaiUsageToUsage` (`shared/registry/usage-headers.ts:276-278`) detects the inclusive Azure convention (`total_tokens = input + output` → `additiveDetails <= 0` → details inclusive) and **carves `input_tokens_details.image_tokens` out of `promptTextTokens`** into `promptImageTokens`. Settlement then hits `convertUsage` (`shared/registry/registry.ts:266-290`), which **zero-fills any usage line that has no rate in the model's sheet** (console.warn only):

```ts
// shared/registry/registry.ts — convertUsage (unchanged by the fix)
const conversionRate = rateDefinition[usageTypeWithFallback as UsageType];
if (conversionRate === undefined) {
    console.warn(`[registry] Missing conversion rate: model=${model} … — billing 0 for this line`);
    return [usageType, 0];
}
```

Net effect: the image half of every vision request on these models is billed at **$0 — doubly so**: the image tokens are excluded from the text line (carve-out) and billed zero on their own line (missing rate).

That this is an oversight and not pricing policy is provable from the same commit: #19981 added `promptImageTokens: perMillion(2)` to **`openai/gpt-6.2-sol` in the same registry change** that introduced `openai/gpt-6.2-astra` without it. Every other model on this route family that reports split image tokens prices it, at exactly the input-text rate:

| Model | promptTextTokens | promptImageTokens |
|---|---|---|
| `openai/gpt-6-sol` | $2/M | $2/M |
| `openai/gpt-6.1-sol` | $2/M | $2/M |
| `openai/gpt-6.2-sol` | $2/M | $2/M |
| `x-ai/grok-4.6` | $2/M | $2/M |
| `openai/gpt-6.2-astra` | $8/M | **missing** |
| `openai/gpt-6-astra` | $10/M | **missing** |

(`x-ai/grok-4.6`'s rate carries the comment "The direct route reports image tokens separately from text tokens", and its test `generateTextPortkey.test.ts` pins real "Observed Sweden usage" with `prompt_tokens_details.image_tokens` — the Azure route demonstrably reports split image tokens in production.)

## Safe repro (isolated, non-destructive)

No live call needed — the billing path is pure over the registry. On unpatched main (runtime-verified against the real modules):

```ts
import { calculateUsageBilling } from "@shared/registry/registry.ts";
import { responsesUsageToUsage } from "@shared/registry/usage-headers.ts";
import { TEXT_SERVICES } from "@shared/registry/text.ts";

const usage = responsesUsageToUsage({
    input_tokens: 1000,
    output_tokens: 100,
    total_tokens: 1100,
    input_tokens_details: { image_tokens: 400 },   // Azure Responses shape
});
// → { promptTextTokens: 600, promptImageTokens: 400, completionTextTokens: 100 }

const billing = calculateUsageBilling({
    model: "openai/gpt-6.2-astra",
    usage,
    servedBy: TEXT_SERVICES["openai/gpt-6.2-astra"],
    quotedBy: TEXT_SERVICES["openai/gpt-6.2-astra"],
});
// console: "[registry] Missing conversion rate: model=openai/gpt-6.2-astra
//           usageType=promptImageTokens amount=400 — billing 0 for this line"
// billing.cost.promptImageTokens === 0        ← 400 image tokens billed $0
// billing.cost.promptTextTokens === 600 × $8/M ← images also excluded here
// identical input on openai/gpt-6.2-sol bills 400 × $2/M correctly
```

The same probe at 300K prompt tokens selects the `long_context` variant (tier selection is provider-usage-driven — verified) and bills the image line $0 at the long-context tier too.

## Impact

`openai/gpt-6.2-astra` is `paidOnly: true` — callers hold paid Pollen, yet image input is free to them while Azure meters those tokens as input tokens on the platform's bill. At ~1-3K tokens per image (high detail) and `maxReferenceImages: 10`, each request under-bills ~10-30K image tokens: **$0.06-$0.36 forgone per request** at $8-16/M × 0.75, trivially repeatable in a loop, on the flagship model introduced two days ago. Both `cost.totalCost` (margin telemetry) and `price.totalPrice` (user charge) omit the line, and the `:aws` fallback inherits the same defective sheet (verified in the effective-prices snapshot).

The pre-existing `openai/gpt-6-astra` (2026-09-04, `paidOnly: false`) has the identical omission at $10/$20 per million — included in the fix.

## Fix

Add the image rate at the input-text rate, mirroring the Sol/grok pattern, in both tiers (`solution30-gpt62-astra-image-token-billing`):

- `openai/gpt-6.2-astra`: `promptImageTokens: perMillion(8)` base, `perMillion(16)` long-context (>272K)
- `openai/gpt-6-astra`: `promptImageTokens: perMillion(10)` base, `perMillion(20)` long-context

Two regression tests in `gen.pollinations.ai/test/text/generateTextPortkey.test.ts` (both fail on unpatched main): the base tier bills image tokens > 0 at the input-text rate on both models with the exact Azure carve-out asserted; the long-context tier bills image tokens at the long-context rate × 0.75 multiplier with the variant selection pinned. The `effective-prices` snapshot gains the `promptImageTokens` lines for `gpt-6-astra`, `gpt-6.2-astra` and their `:aws` fallbacks (12 snapshot lines).

**PR:** https://github.com/NamanSoni78/pollinationsai/pull/39 (upstream PR rejected `403 Resource not accessible by personal access token`, consistent with rounds 1-10 — fork PR is the review surface)

## Verification

- `generateTextPortkey.test.ts` 33/33 (31 pre-existing + 2 new, red on unpatched registry)
- full gen `test/text/` directory 957/957
- enter `aliases.test.ts` (Azure multiplier policy) 481/481; `modelResolver` + `static-provider-fallbacks` 134/134
- `effective-prices.snapshot.test.ts` updated and green; `tsc --noEmit` clean

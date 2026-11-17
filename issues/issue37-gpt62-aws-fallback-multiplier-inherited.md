# Issue 37 — GPT-6.2 AWS fallback routes inherited the 0.75 Azure multiplier onto the AWS list sheet

- **Severity:** Medium (price-data integrity; ledger impact contingent)
- **Affected:** `shared/registry/text-fallbacks.ts:287-292` — upstream `pollinations/pollinations` main @ `6538ea2721` (introduced by `6538ea2` itself, "feat: add paid GPT-6.2 Astra and Sol with Bedrock fallback (#19981)")
- **Status:** CODE-VERIFIED at `6538ea2` with a failing-today assertion over the real registry (reproduced `0.75 → 1`); snapshot values verified before/after regeneration
- **Fix branch:** `solution33-gpt62-aws-fallback-multiplier` — **PR:** [#42](https://github.com/NamanSoni78/pollinationsai/pull/42)

## Summary

The commit added the two new OpenAI→AWS fallback routes without `priceMultiplier: 1` — the **only** OpenAI→AWS fallbacks (of ten) missing it. `mergeFallbacks` copies every non-overridden field from the primary, so `openai/gpt-6.2-astra:aws` and `openai/gpt-6.2-sol:aws` inherited the **0.75 Azure discount** onto routes whose own price sheet is the **AWS list rates** (the invariant `static-provider-fallbacks.test.ts:674-699` asserts for every sibling — its `it.each` list was not extended with the 6.2 pair, which is exactly how the defect slipped past the suite).

## Root cause

Registration data defect in `6538ea2`: two missing `priceMultiplier: 1` overrides. The regenerated `effective-prices.snapshot` then locked the wrong rates in: `openai/gpt-6.2-astra:aws` `promptTextTokens: 0.000006` (0.75 × 0.000008) instead of the sibling-shape `0.000008` (compare `openai/gpt-6.1-sol:aws` = cost = 1×).

## PoC (non-destructive, isolated)

```ts
const fallback = getRegistryModelDefinition("openai/gpt-6.2-astra:aws");
expect(fallback.priceMultiplier).toBe(1);              // FAILS today: 0.75
const billing = fallbackBill("openai/gpt-6.2-astra", "openai/gpt-6.2-astra:aws",
    { promptTextTokens: 272_001, completionTextTokens: 1_000 });
expect(billing.price.totalPrice)   // caller keeps the Azure quote — correct
    .toBeCloseTo((272_001 * 16e-6 + 1_000 * 60e-6) * 0.75, 12);
expect(billing.servedPrice)       // serving route's own price must be full AWS list
    .toBeCloseTo(272_001 * 16e-6 + 1_000 * 60e-6, 12); // FAILS today: 25% below
```

## Impact

Callers are **not** mis-charged (the quote is the primary's) and cost accounting is multiplier-independent. What breaks: `servedPrice` — "what the model that actually ran would have been charged … bounds the serving owner's reward" — under-reports every Bedrock-rescued 6.2 request by 25% of AWS list (a 273K-token Astra fallback ≈ $4.41 list, recorded as $3.31); the route's effective price sheet and the repo's canonical effective-prices snapshot ("reviewer sees every rate change") document 0.75× for the Bedrock routes, so every economics/margin analysis and any future reward logic keyed on route prices inherits a 25% understatement of AWS-served cost. Not attacker-triggerable — a data integrity defect shipped in the price registry itself.

## Fix

One line per model: `priceMultiplier: 1`. New `it.each` for the paid-only 6.2 pair pins the multiplier, the caller price (list × 0.75) and `servedPrice` = full list (fails pre-fix, passes after); snapshot regenerated (9 rows: both `:aws` price sheets 0.75× → 1×). `static-provider-fallbacks` + `modelResolver` 260/260, enter snapshot + `cost-variants` 73/73, `tsc` clean.

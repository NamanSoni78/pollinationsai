# Issue 122 — `qwen/qwen3.8-2.4t-a95b` prices cache reads but not cache writes: explicit context-cache writes settle at $0

- **Severity:** Medium (a missing rate-sheet line on a paidOnly text model — the issue-70 mechanism: a real provider cost dimension settles at $0; Alibaba charges 125% of the input rate for every explicit cache write on this model)
- **Affected:** `shared/registry/text.ts:4062-4072` (`qwen/qwen3.8-2.4t-a95b` cost block: `promptTextTokens: 2`, `promptCachedTokens: 0.25`, `completionTextTokens: 6` — no `promptCacheWriteTokens` line)
- **Fix branch:** `solution122-qwen38-a95b-cache-write-line` (off `upstream/main` `8fc4c21`) — fork PR [#137](https://github.com/NamanSoni78/pollinationsai/pull/137)
- **Dedup:** issue 70 filed the mechanism (gemma-4-26b missing `promptCachedTokens`); this is the cache-**write** instance on a different model — not covered by issues 1–121 (the round-38 sweep verified the four round-37 cache-**read** residuals NOT-CONFIRMED with public evidence; the write line on this sheet is a distinct, confirmed gap).

## Root cause

Alibaba Model Studio bills explicit context-cache **writes** at 125% of the standard input unit price, and cache **hits** at a per-model discounted rate (published billing rule on the Model Studio pricing page, which lists this exact model at $2/$6 for the 0–1M tier, annotated "Context cache enjoys a discount"). Every alibaba sheet that prices the cached-read line also prices the write line at 1.25× input:

| sheet | input | write |
|---|---|---|
| qwen/qwen4-max | 1.5 | 1.875 |
| qwen/qwen3.8-max | 2 | 2.5 |
| qwen/qwen3.8-max-0902 | 2 | 2.5 |
| qwen/qwen3.8-flash | 0.15 | 0.2 |
| qwen/qwen3.7-flash | 0.1 | 0.125 |

`qwen/qwen3.8-2.4t-a95b` (input $2) prices the read line at $0.25 but carries no write line, so any request whose usage reports cache-write tokens on this model settles those tokens at $0 while Alibaba bills the platform $2.50/M.

## Safe repro (deterministic offline; live probes $0)

Registry walk on unpatched `8fc4c21`: for every alibaba-provider sheet, "prices `promptCachedTokens` ⇒ must also price `promptCacheWriteTokens` at 1.25× `promptTextTokens`". Exactly one sheet violates it: this one. The new test `enter.pollinations.ai/test/alibaba-cache-write-sheets.test.ts` fails RED on main with:

```
qwen/qwen3.8-2.4t-a95b: prices cache reads at 0.25/M but has no promptCacheWriteTokens line — explicit cache writes settle at $0
```

## Fix

Add `promptCacheWriteTokens: perMillion(2.5)` (1.25 × the $2 input rate, the sibling convention) to the cost block, update the `effective-prices` snapshot (cost + price), and pin the convention with the new registry test (read-priced ⇒ write-priced at 1.25× input, ±10% for the 2-decimal rounding convention).

## Tests

- **RED on main:** 1 failed (`alibaba-cache-write-sheets.test.ts`).
- **GREEN with fix:** 1/1; `effective-prices` (snapshot regenerated), `pricing-data` 65/65, `aliases`, `service-providers`, `community-model-rate-limit` green; `tsc --noEmit` clean.

## Notes for maintainers

- The read line ($0.25 = 12.5% of input) sits above Alibaba's *general* context-cache hit rule (10% ⇒ $0.20); the per-model published rate could not be confirmed offline, so the read line is left untouched (changing it without confirmation would over-charge callers). If Alibaba's per-model doc confirms $0.20, adjust both.
- The sibling qwen3.8 family also carries `defineCostVariants` explicit-cache hit variants (e.g. qwen3.8-max at $0.17); this sheet has none. Adding one needs Alibaba's published explicit-cache hit rate for a95b — left as a follow-up, not invented here.

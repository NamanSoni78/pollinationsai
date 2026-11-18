# Issue 62 — Claude 5.5-generation cache reads priced at 5% of input instead of the documented 10% — every cache-hit token under-collected by half

- **Severity:** Medium-High (systematic undercharge on all cache traffic of three flagship models; provable in-repo with the issue-46 methodology: documented contract + sibling + same-generation-sibling evidence)
- **Affected:** `shared/registry/text.ts` (`anthropic/claude-sonnet-5.5`, `anthropic/claude-opus-5.5`, `anthropic/claude-opus-5.5:fast`), `shared/registry/text-fallbacks.ts` (`anthropic/claude-opus-5.5:fast:openrouter:anthropic-fast`) — upstream `pollinations/pollinations` main @ `52fd0a6c824`
- **Fix branch:** `solution58-claude-cache-read-rate-parity` — **PR:** [#75](https://github.com/NamanSoni78/pollinationsai/pull/75)

## Root cause

The documented Claude prompt-caching contract (APIDOCS.md prompt-caching table): *"Cache creates bill at 1.25× the input rate; hits bill at 10% of input, or 2.5% on `anthropic/claude-fable-5.1`."* Every Claude sheet in the registry prices it that way — except the 5.5-generation trio, whose **cache-read** lines carry 5% of input while their **cache-write** lines are correctly 1.25× (a decimal authoring error in the read line, mirrored by the `:fast` 2× sheet and its OpenRouter fallback):

| Route | input $/M | cached $/M (pre-fix) | ratio | expected |
|---|---|---|---|---|
| `anthropic/claude-sonnet-5.5` | 2 | 0.10 | **5%** | $0.20 (10%) |
| `anthropic/claude-opus-5.5` | 4 | 0.20 | **5%** | $0.40 (10%) |
| `anthropic/claude-opus-5.5:fast` | 8 | 0.40 | **5%** | $0.80 (2× the 10% read rate) |
| `anthropic/claude-opus-5.5:fast:openrouter:anthropic-fast` | 8×1.055 | 0.4×1.055 | **5%** | 0.8×1.055 |

The evidence that 5% is an error and not a provider change: (a) the documented contract says 10% with exactly one exemption (fable-5.1 at 2.5%); (b) every sibling prices 10% — `claude-sonnet-5` ($2→$0.20), `claude-opus-5` ($5→$0.50), `claude-fable-5` ($10→$1), `claude-haiku-4.5` ($1→$0.10); (c) **same-generation `claude-haiku-5.5` prices 10%** ($0.5→$0.05), ruling out a generation-wide provider change; (d) the fable-5.2 sheet at 2.5% shows the family exemption is deliberate where it exists, and the 5.5s are not part of it. Anthropic's usage reports cache hits as `cache_read_input_tokens` (`APIDOCS.md:418`) and the normalizer reads them (`usage-headers.ts:230-231`), so the under-priced line is live billing, not a dead line.

## Safe reproduction (isolated, registry-level)

`gen.pollinations.ai/test/text/claude-cache-read-rate.test.ts` — an invariant over the real merged registry: every `anthropic/claude-*` route with both lines prices cache reads at 10% of input except the fable-5.1/5.2 family (2.5%). **Red on unpatched HEAD**, naming exactly the six offending routes:

```
anthropic/claude-sonnet-5.5: cached 1e-7 vs input 2e-6 (ratio 0.050, expected 0.1)
anthropic/claude-sonnet-5.5:aws: … (inherits)
anthropic/claude-opus-5.5: … ; :anthropic: … ; :fast: … ; :fast:openrouter:anthropic-fast: …
```

## Fix (`solution58-claude-cache-read-rate-parity`)

Four rate lines: sonnet-5.5 `0.1→0.2`, opus-5.5 `0.2→0.4`, `:fast` `0.4→0.8`, `:fast:openrouter` `0.4→0.8` (×1.055 preserved); the `:aws`/`:anthropic` fallbacks inherit the corrected primaries. Comments state the 10%-of-input contract. Post-fix: invariant green, `byop-markup` 43/43, `effective-prices` snapshot regenerated (12 rows — the repo's rate-change review artifact), `tsc` clean.

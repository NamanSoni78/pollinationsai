# Issue 52 — Residual vision-rate gaps: 22+ routes the fleet fixes (PRs #51/#54/#57) leave unpriced, plus two dropped cached-prompt rates and the last inherited AWS discount

- **Severity:** High (companion to issues 46/49 — the concurrent fleet fixes close 17 primaries + 4 companion routes; this sweep of the **entire** merged registry found 22+ further image-capable routes still billing image input at $0, on the same zero-fill mechanism)
- **Affected:** `shared/registry/text.ts` (10 primary sheets), `shared/registry/text-fallbacks.ts` (12 route sheets + 2 cached-rate drops + 1 `priceMultiplier`) — upstream `pollinations/pollinations` main @ `52fd0a6`
- **Fix branch:** `solution46-vision-input-rate-sheet-gaps` — **PR:** [#61](https://github.com/NamanSoni78/pollinationsai/pull/61)
- **Relationships:** same defect class as issues 33/34/45/46/49. Issues 46 (PR #54), 49-mistral (PR #51) and 49-vercel-fleet (PR #57) cover the OpenAI gpt-5.x family, midijourney, kimi-k3/hy4-flash/mistral-large-3/llama-4-maverick primaries and the kimi-highspeed/muse-spark/hy4:openrouter companions. This report is the **platform-wide residual**: routes none of those branches touch. Merge either this PR or the union of theirs per route — every overlap (hy4-flash, kimi-k3, kimi-k3.1-pro-highspeed, muse-spark-1.2/1.3, mistral-large-3, llama-4-maverick) is an identical one-line rate, so conflicts resolve trivially or by re-running the effective-prices snapshot.

## Root cause

Identical to issue 46's (documented there in full): a sheet declaring `inputModalities: ["text", "image"]` with no `promptImageTokens` rate; the serving provider reports `prompt_tokens_details.image_tokens`; `openaiUsageToUsage` subtracts it from `promptTextTokens`; `convertUsage` zero-fills the unrated line — image input bills at **exactly $0** while the platform pays the provider. Provider split-reporting is pinned in-repo for every provider involved (Azure Grok / AWS Bedrock in `generateTextPortkey.test.ts`, DeepInfra Kimi K2.6 in `static-provider-fallbacks.test.ts:430-449`, Vercel AI Gateway via issue 45's live verification, OpenRouter/Novita/Fireworks via their priced sibling sheets — `mistral-small-4:openrouter`, `mimo-v2.6` novita, `glm-5.3-flash` fireworks).

Verified programmatically against the real merged registry (`mergeFallbacks(TEXT_SERVICES, TEXT_FALLBACKS)`) at `52fd0a6` — **after** subtracting the routes carried by PRs #51/#54/#57, the residual:

| # | Route (provider) | Missing line | Rate added (= own text rate) |
|---|---|---|---|
| 1 | `moonshotai/kimi-k3:deepinfra` + `:fireworks` | `promptImageTokens` | $2.85/M / $3/M (kimi-k2.6:deepinfra prices image = text) |
| 2 | `moonshotai/kimi-k3.1-pro:vercel` | `promptImageTokens` | $2/M (azure parent prices image = text) |
| 3 | `nvidia/nemotron-3.5-super-vl` (deepinfra primary) + `:openrouter:together` | `promptImageTokens` | $0.15/M (×1.055) |
| 4 | `qwen/qwen3-vl-30b-a3b-instruct` (deepinfra primary) + `:openrouter:deepinfra` | `promptImageTokens` | $0.15/M (×1.055) — qwen3-vl-235b sibling prices image = text |
| 5 | `xiaomi/mimo-v2.6-flash:deepinfra` + `mimo-v2.6-pro:deepinfra` | `promptImageTokens` (dropped from novita parents that price it) | $0.14/M / $0.387/M |
| 6 | `xiaomi/mimo-v2.5` (openrouter primary) | `promptImageTokens` | $0.14/M ×1.055 |
| 7 | `minimax/minimax-m3` (fireworks primary) + `:deepinfra` | `promptImageTokens` | $0.3/M / $0.28/M (maxReferenceImages 30 — the fleet's densest vision budget) |
| 8 | `minimax/minimax-m3.1-flash` (fireworks primary) | `promptImageTokens` | $0.15/M |
| 9 | `meta/muse-spark-open` (fireworks primary) + `muse-spark-open:vercel:baseten` | `promptImageTokens` | $1.25/M (muse-wonder siblings price image = text) |
| 10 | `stepfun/step-5-preview` (openrouter primary) + `:vercel` | `promptImageTokens` | $1/M ×1.055 / $1/M |
| 11 | `stepfun/step-3.7-flash` (novita primary) + `:vercel` | `promptImageTokens` | $0.2/M |
| 12 | `mistralai/mistral-small-3.2` (openrouter primary) + `:deepinfra` | `promptImageTokens` | $0.075/M ×1.055 / $0.075/M (mistral-small-4 sibling prices image = text) |
| 13 | `cohere/command-a-plus` (openrouter primary) | `promptImageTokens` | $0.3/M ×1.055 |
| 14 | `nex-agi/nex-n2.5-mini` + `nex-n2.5-pro` (openrouter primaries) | `promptImageTokens` | $0.025/M / $0.075/M ×1.055 |
| 15 | `deepseek/deepseek-v4.1-flash:fireworks` + `deepseek-v4.1-flash-1017:fireworks` | `promptImageTokens` (dropped from azure parents that price it at $0.3/M) | $0.3/M |
| 16 | `qwen/qwen3-coder-30b-a3b-instruct:aws` | `promptCachedTokens` (dropped; Bedrock reports `cached_tokens`, pinned by `generateTextPortkey.test.ts:395-446`) | $0.15/M (own text rate, conservative floor) |
| 17 | `google/gemma-4-31b-it:deepinfra` | `promptCachedTokens` (dropped; DeepInfra reports cache hits — mimo/glm/kimi sheets) | $0.2/M (own text rate) |
| 18 | `mistralai/mistral-large-3:aws` | `priceMultiplier: 1` — **issue-37 recurrence**: the only AWS route still inheriting the Azure 0.75 discount onto the Bedrock list sheet (all 9 sibling AWS routes pin 1). Not covered by PR #51 (which adds the route's image rate only) | — |

Overlapping routes also carried by this PR (identical one-line rates, listed for merge-ordering only): `tencent/hy4-flash` + `:openrouter`, `moonshotai/kimi-k3` primary, `moonshotai/kimi-k3.1-pro-highspeed`, `meta/muse-spark-1.2` + `muse-spark-1.3`, `mistralai/mistral-large-3` primary, `meta/llama-4-maverick`.

**Deliberately excluded:** the Anthropic Claude family and `mistralai/mistral-large-3:aws`'s image rate (both documented fold-in — "Bedrock US Standard reports image input in the prompt total"); `qwen/qwen4-max:vercel` (PR #50); the gpt-5.x/midijourney fleet (PR #54). The generic route test still only checks route-keys ⊆ parent-keys (`expectInheritedRoute`), never the reverse — the blind spot that let rows 5/15/16/17 slip past CI (same gap issue 47's report documents for fallback sheets).

## Safe repro (isolated, non-destructive)

New `gen.pollinations.ai/test/text/vision-input-rate-sheet.test.ts` (71 assertions) over the real `TEXT_SERVICES` / `calculateUsageBilling` modules. Pre-fix run on unpatched `52fd0a6` (reproduced): **73/73 red** — every route's image/cached line undefined, and the billing cases show 2000 reported image tokens contributing exactly **$0.00** to the served cost. Post-fix: **71/71 green** (two cases removed from the red set when `mistral-large-3:aws` was excluded per its documented fold-in).

## Fix

37 one-line rate additions (each `promptImageTokens: perMillion(<own text rate>)`, the sibling convention; openrouter routes ×1.055 credit fee where their text rate carries it) + `priceMultiplier: 1` on `mistralai/mistral-large-3:aws` + regenerated `effective-prices` snapshot (74 new rate rows). No worker code changes. Regression cover: `test/text/` **1037/1037**, `static-provider-fallbacks` + `fallback` **175/175**, `docs` + `model-catalog` **26/26**, `tsc --noEmit` clean.

## Impact

Every image-bearing request on the residual routes bills its vision input at $0 while the platform pays the provider. Densiest lines: minimax-m3 (30 reference images at $0.3/M), kimi-k3:deepinfra (10 images at $2.85/M), step-5-preview (1M context at $1/M). With the concurrent PRs, this closes the class platform-wide; the PR also suggests the structural CI guard (extend `expectInheritedRoute` so a route cost override must keep every parent key the parent prices) that would have caught rows 5/15/16/17 and issue 45's route at review time.

# F-06 — The rate registry has drifted from provider reality: vision input at $0, wrong cache rates, expired promos, dead endpoint pins (High)

**Consolidates:** issues [#34](../issues/issue34-gpt62-astra-vision-input-unbilled.md), [#45](../issues/issue45-qwen4max-vercel-image-input-unbilled.md), [#46](../issues/issue46-vision-input-token-billing-fleet.md) (fleet-wide vision $0), [#47](../issues/issue47-fallback-cost-sheet-completeness.md) (fallback multipliers/dropped lines), [#49-mistral](../issues/issue49-mistral-large3-vision-input-unbilled.md), [#49-vercel](../issues/issue49-vercel-vision-fleet-companion.md), [#52](../issues/issue52-vision-input-rate-sheet-residual-fleet.md) (the superset sweep), [#37](../issues/issue37-gpt62-aws-fallback-multiplier-inherited.md), [#62](../issues/issue62-claude-55-cache-read-rate.md) (Claude 5.5 cache-read at 5% not 10%), [#70](../issues/issue70-gemma-4-26b-cached-input-billed-zero.md) (gemma cached input $0), [#80](../issues/issue80-openrouter-endpoint-price-drift.md) (OR endpoint drift), [#122](../issues/issue122-qwen38-a95b-cache-write.md) (qwen3.8 cache-write $0), [#128](../issues/issue128-flux3max-fal-promo-expiry.md) (expired promo 2–4× under-billing), [#129](../issues/issue129-or-endpoint-pin-drift.md) (dead endpoint pins = hard outage), [#132](../issues/issue132-mistral-large4-vision-input-rate.md) (mistral-large-4 vision $0 — the fleet member missed by every sweep) — 15 issues, one mechanism: **`convertUsage` bills any usage line with no rate as $0 (a console.warn only), `mergeFallbacks` inherits parent discounts onto list-rate sheets and drops cost lines, and nothing re-syncs sheets when providers re-price, run promos, or delist endpoints.**

**Status on upstream `main` @ `4f3585e97` — re-verified 2026-11-19 (round 44):** a fresh programmatic scan of the merged registry finds **41 split-reporting routes still missing `promptImageTokens`** (the 18 enumerated below + the issue-52 residual rows + the issue-46 follow-up set; none fixed upstream, none re-priced), plus one newly-registered member: `mistralai/mistral-large-4` (+ its `:vercel` fallback) — missed by issues 46/49/52 and the PR-#61 superset, fixed on fork PR [#148](https://github.com/NamanSoni78/pollinationsai/pull/148). Claude-5.5 cache-read, gemma cached input, qwen3.8 cache-write, and the dead minimax-m2.7/qwen3-coder-next endpoint pins are all still uncorrected upstream (fix PRs unmerged). Note: the 2026-11-19 description-rewrite commit shifted every `shared/registry/*.ts` line number — citations in this report predate it.

**Fix PRs:** [#39](https://github.com/NamanSoni78/pollinationsai/pull/39), [#50](https://github.com/NamanSoni78/pollinationsai/pull/50), [#54](https://github.com/NamanSoni78/pollinationsai/pull/54), [#51](https://github.com/NamanSoni78/pollinationsai/pull/51), [#57](https://github.com/NamanSoni78/pollinationsai/pull/57), [#61](https://github.com/NamanSoni78/pollinationsai/pull/61), [#55](https://github.com/NamanSoni78/pollinationsai/pull/55), [#42](https://github.com/NamanSoni78/pollinationsai/pull/42), [#75](https://github.com/NamanSoni78/pollinationsai/pull/75), [#82](https://github.com/NamanSoni78/pollinationsai/pull/82), [#94](https://github.com/NamanSoni78/pollinationsai/pull/94), [#137](https://github.com/NamanSoni78/pollinationsai/pull/137), [#143](https://github.com/NamanSoni78/pollinationsai/pull/143), [#144](https://github.com/NamanSoni78/pollinationsai/pull/144), [#148](https://github.com/NamanSoni78/pollinationsai/pull/148).

---

## What this chain can do, end to end

1. **Callers get vision input for free on split-reporting routes while the platform pays the provider.** Live-proven at audit time on `moonshotai/kimi-k3.1-pro` (Vercel gateway: `x-usage-prompt-image-tokens: 361`, `463 = 102 text + 361 image`, image line billed $0 — that model has since been rated upstream). Today, 18 split-provider routes are still unpriced (kimi-k3.1-pro-highspeed, muse-spark-1.2/1.3, hy4-flash, mimo-v2.5, glm-5.3-flashx, nex-agi pair, nemotron, qwen3-vl, step-5, cohere, mistral-small-3.2, minimax-m3 pair, muse-spark-open, nemotron, claude-opus-5.5:fast...) — and the round-44 recount added `mistral-large-4` (+`:vercel`) as the member every sweep missed (issue 132): a paidOnly flagship, added 2026-10-06, text rates re-verified 2026-11-11 with the image line still absent, while its own sibling mistral-small-4 prices image = text rate.
2. **Cache economics are mispriced at both ends.** Claude 5.5-generation cache reads bill at 5% of input instead of the documented 10% (halved cache-hit revenue on three flagship models — issue 62); gemma-4-26b bills cached input at $0 while OpenRouter charges the platform $0.05/M (26.8% absorption per request — issue 70); qwen3.8-2.4t-a95b prices cache *reads* but not cache *writes* ($2.50/M settles $0 — issue 122).
3. **Promos and pins go stale.** flux-3-max still quotes the 75%-off fal promo that ended 2026-11-07 in the registry (0.0425/0.0725 vs the live "$0.085/second … List $0.17, this rate ends November 21") — at current HEAD the stale lines drift quotes and preflight estimates only (settlement is receipt-based; see the round-44 correction below) (issue 128). minimax-m2.7 is pinned `only: ["novita/fp8"], allow_fallbacks: false` against a **delisted** endpoint → every request on a listed paidOnly model fails (hard outage); qwen3-coder-next's streamlake fallback pin is equally dead (issue 129 — live OpenRouter endpoints API fetched).
4. **Fallback routes inherit the parent's discount onto their own list rates** (9 routes at 0.75/0.5 — `servedPrice` under-reports 25–50%, which bounds community rewards and feeds margin analysis) and drop the parent's image/cached lines wholesale (6 routes; issue 47, with issue 37 the first two instances).

## Corrections applied during this consolidation (no false positives)

- **The mistral-large-3 and kimi-k3 *primary* "live $0-vision" claims (issues 46/49-mistral) were overstated** — first corrected by issue 49-vercel's same-day fold-control, and re-confirmed by fresh live probes on 2026-11-19: on `kimi-k3` (Bedrock), `gpt-5.6-sol` (Azure) and `muse-spark-open` (Fireworks), image tokens are **folded into `prompt_tokens` and billed at the text rate** (probe deltas matched text-rate math to 8 decimal places, e.g. gpt-5.6-sol: 328 prompt × $4/M × 0.75 + 38 × $20/M × 0.75 = $0.00155400 = observed). **No undercharge on those routes.**
- The bug is real exactly where the usage **splits** `image_tokens` out (Vercel gateway, OpenRouter, DeepInfra, Fireworks split-reporting routes) — live-proven on kimi-k3.1-pro at audit time; the registry math is unit-proven red for any split usage (missing rate → $0 with only a console.warn).
- `moonshotai/kimi-k3.1-pro` now carries an image rate upstream — dropped from the live-exposure list; the other 18 split-provider routes remain.
- **Correction (round 44, 2026-11-19): flux-3-max settlement is receipt-based at current HEAD** — the fal family (`fluxMaxVideoModel.ts:126-198` → `x-fal-billable-units` → `calculateUsageBilling` `providerBilling` override in `registry.ts:537-546` + `track.ts:1526-1543`) now settles from the live provider receipt at `falUnitPrice()`, and a missing receipt hard-fails (502 "no billable units") rather than billing the stale registry rate. The stale 0.0425/0.0725 lines therefore drift the **public quote (/models, docs) and per-second preflight estimates only** — the issue-32/36 estimate class — not the customer's settlement. Issue 128's cutover tests remain valid for the quote/preflight path; the "2×/4× customer under-billing" framing is retired. Same receipt mechanism covers heygen/mirelo/sonilo/minimax-h3-max/z-image-turbo/gpt-image-2.6:fal.

## Proof (strongest evidence)

**Live, 2026-11-18 (issue 49-vercel, own key):** kimi-k3.1-pro image request → `x-usage-prompt-image-tokens: 361`, total `463 = 102 text + 361 image`, image contribution billed $0 (then); priced sibling billed $2.3/M — the split machinery is real and billed when a rate exists.

**Live, 2026-11-19 (this pass, fold-controls):** gpt-5.6-sol image request (model *describes* the image) → `prompt_tokens: 328, image_tokens: 0`, delta `0.00155400` = text-rate math exactly (images folded, billed) — see Corrections above.

**Live public-API probes:** OpenRouter endpoints API (issue 80: mimo-v2.5 input billed at 35% of list / output 14% / images $0, ≤ **$2.09/request** under-billed; `web_search: "0.014"` on every Google endpoint — the main search model's web_search bills at 47% of true charge); issue 129 re-verified live 2026-11-19 (no novita row for minimax, no streamlake row for qwen); fal pricing page (issue 128).

**Unit red/green on unpatched main:** issue 52's 71-assertion sweep — **73/73 red** (every residual route's image/cached line undefined; 2000 image tokens contributing exactly $0.00); issue 46's 17-model fleet (all red; live mistral/kimi legs superseded by the corrections above); issue 62's invariant test (six offending routes, `cached 1e-7 vs input 2e-6 (ratio 0.050, expected 0.1)`); issue 70's parity test ($0.066465 collected vs $0.09073 charged = 26.8% absorbed); issue 128's cutover tests with fake timers.

## The chain

```
provider re-prices / runs a promo / delists an endpoint / gains a capability
        │  (no re-sync tooling; CI checks route-keys ⊆ parent-keys, never the reverse)
        ▼
registry sheet missing / wrong / stale
        ├── missing promptImageTokens      → split-reported image tokens settle $0     (34/45/46/49/52 — 18 routes still open)
        ├── missing promptCached/Write     → cache reads/writes settle $0 or half      (62/70/122)
        ├── expired promo still pinned     → flux-3-max 2×→4× under-bill from Nov 21   (128)
        ├── dead endpoint pin              → minimax-m2.7 hard outage; latent +29–50% misprice (129)
        ├── OR endpoint drift              → ≤$2.09/request under-bill; web_search 47% (80)
        └── mergeFallbacks inheritance     → 0.75/0.5 discounts onto list sheets; dropped lines (37/47)
```

## Members & fixes

| Issue | One-line | Verification | Fork PR |
|---|---|---|---|
| 34 | GPT-6.2/6 Astra omit `promptImageTokens` (first instance of the class) | Runtime probe + unit red | [#39](https://github.com/NamanSoni78/pollinationsai/pull/39) |
| 45 | qwen4-max `:vercel` fallback drops the image line | Unit red/green | [#50](https://github.com/NamanSoni78/pollinationsai/pull/50) |
| 46 | Fleet: 17 primary sheets + 8 long-context variants omit the image rate | Unit red (17) + live (superseded on 2 routes by corrections) | [#54](https://github.com/NamanSoni78/pollinationsai/pull/54) |
| 49-mistral | mistral-large-3 vision after the Azure inlining commit | Unit red (primary-side impact corrected — see above) | [#51](https://github.com/NamanSoni78/pollinationsai/pull/51) |
| 49-vercel | Vercel fleet remainder + 7th dropped fallback image line; posted the 46/49-mistral correction | Unit red + **live split probe** + fold-controls | [#57](https://github.com/NamanSoni78/pollinationsai/pull/57) |
| 52 | **The superset sweep**: 22+ residual routes + CI guard proposal | 73/73 red | [#61](https://github.com/NamanSoni78/pollinationsai/pull/61) |
| 37 | First two inherited-multiplier instances (gpt-6.2 AWS fallbacks) | Unit red/green | [#42](https://github.com/NamanSoni78/pollinationsai/pull/42) |
| 47 | Fallback completeness: 9 inherited discounts + 6 dropped image lines + d1.2 cached | 17/17 red | [#55](https://github.com/NamanSoni78/pollinationsai/pull/55) |
| 62 | Claude 5.5 cache-read at 5% vs documented 10% | Invariant test red (6 routes) | [#75](https://github.com/NamanSoni78/pollinationsai/pull/75) |
| 70 | gemma-4-26b cached input $0 (26.8% platform absorption) | Unit red + public OR API | [#82](https://github.com/NamanSoni78/pollinationsai/pull/82) |
| 80 | OpenRouter endpoint price drift (5 sheets, ≤$2.09/req; web_search 47%) | **Live** OR API + 5 tests | [#94](https://github.com/NamanSoni78/pollinationsai/pull/94) |
| 122 | qwen3.8-2.4t-a95b cache-write $0 (read priced, write missing) | Registry-walk red | [#137](https://github.com/NamanSoni78/pollinationsai/pull/137) |
| 128 | flux-3-max expired promo (2× now, 4× from 2026-11-21) | **Live** pricing page + cutover tests | [#143](https://github.com/NamanSoni78/pollinationsai/pull/143) |
| 129 | Dead OR pins: minimax-m2.7 full outage + qwen3-coder-next dead fallback | **Live** endpoints API + tests | [#144](https://github.com/NamanSoni78/pollinationsai/pull/144) |
| 132 | mistral-large-4 (+`:vercel`) vision $0 — missed by every sweep above (round 44) | Unit red/green 4→5/5, offline | [#148](https://github.com/NamanSoni78/pollinationsai/pull/148) |

## Merge guidance

1. **#61 (issue 52) is the superset** for the vision family — it stacks on #54/#57 and its one-liners overlap #39/#50/#51 by design (merge-ordering only). Take it (or fold its list into a single maintainer-authored PR).
2. **Ship the structural guard**: `expectInheritedRoute` reverse-check (rates ⊆ parent rates when a route overrides cost) + the parity invariants of #75/#82/#137 — ends the class instead of the next drift finding.
3. **#143 (flux-3-max) remains worth taking** — settlement is receipt-protected (see the round-44 correction above), so the stale rates now cost quote/preflight accuracy, not settlement revenue; still a docs-facing wrong number after 2026-11-21.
4. **#144** restores a listed paidOnly model from hard outage (minimax-m2.7) — also time-critical.
5. Overlapping one-liners across #42/#47/#50/#54: any merge order works; the later PRs rebase trivially (documented in the issue mds).

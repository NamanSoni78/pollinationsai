# Issue 80 — Five OpenRouter registry sheets drifted from the endpoint prices that serve them (up to $2.09/request under-billing; web_search at half price on the main search model)

- **Severity:** High (systematic under-billing with a per-request $ bound; the proven registry-parity class of issues 34/37/45/46/47/49/52/53/62/70)
- **Affected:** `shared/registry/text.ts` — `xiaomi/mimo-v2.5` (`:3258-3262`), `xiaomi/mimo-v2.5-pro` (`:3282-3287`), `moonshotai/kimi-k2.7-code` (`:2753-2762`), `deepseek/deepseek-v4-pro` (`:1609-1617`), `google/gemini-2.5-flash-lite:search` (`:1808-1812`); `shared/registry/text-fallbacks.ts:1073-1080` (`google/gemini-4-carbon:openrouter:ai-studio`); route pins `gen.pollinations.ai/src/text/configs/modelConfigs.ts:560-567` — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution74-openrouter-endpoint-price-sync` — **PR:** [#94](https://github.com/NamanSoni78/pollinationsai/pull/94)

## Root cause

OpenRouter publishes **endpoint-level** pricing (`openrouter.ai/api/v1/models/<id>/endpoints`), and the platform pins specific endpoints — but five sheets were never re-synced when those endpoints re-priced or were delisted. All evidence below was fetched from the public API on 2026-11-18 (no auth required, non-destructive):

| model | registry sheet (per 1M, ×1.055 fee included) | the endpoint that actually serves the pinned route | under-bill |
|---|---|---|---|
| `xiaomi/mimo-v2.5` (paidOnly) | prompt **0.14** / cached **0.0028** / completion **0.28**, **no `promptImageTokens` line** although the model takes image inputs (`maxReferenceImages: 10`) | the only live endpoint is `venice/fp8`: prompt **$0.40** / cache-read **$0.08** / completion **$2.00**, one prompt rate for every input modality | input billed at 35% of list, output at 14%, cache at 3.5%, image inputs $0 — up to **$2.09** on one 1M-in/1M-out request |
| `xiaomi/mimo-v2.5-pro` (paidOnly) | **0.435 / 0.0036 / 0.87** (comment: "OpenRouter Xiaomi FP8 endpoint, verified 2026-08-22") | the Xiaomi FP8 endpoint is **delisted**; the only live endpoint is `digitalocean`: **$0.48 / $0.096 / $1.80** | completion at roughly half price — up to **$1.03** per request |
| `moonshotai/kimi-k2.7-code` (paidOnly) | **0.6 / 0.16 / 3.5** (+ cache-write and image lines at 0.6), comment "verified 2026-11-11" | the pinned `inceptron/int4` endpoint re-priced: **$0.8125 / $0.17 / $3.75** | ≈ **$0.49** per 1M-in/1M-out request |
| `deepseek/deepseek-v4-pro` (paidOnly) | prompt **1.122** / cached 0.1122 / completion 3.366, comment "Alibaba peak rates (00:00–14:00 UTC, 2026-09-23)… halves them the rest of the day" | the pinned `alibaba/fp8` endpoint (config `only:["alibaba"]`, `ignore:["alibaba/us-east-1"]`) now publishes **$1.416 / $0.118 / $2.832** — and no current Alibaba endpoint halves off-peak any more (us-east-1 variant: 1.56/0.13/3.12) | prompt under-billed **$0.31/M** — ≈ **$0.31** on a single 1M-token prompt (completion over-billed $0.569/M in the reverse direction — the sheet was stale both ways) |
| `google/gemini-2.5-flash-lite:search` + the `gemini-4-carbon:openrouter:ai-studio` fallback | web_search **$7 / 1K requests** | every routed Google AI Studio endpoint bills web_search **$0.014 per request ($14 / 1K)** — while every other Gemini sheet in the registry already uses 14×1.055 | **47% of every web-search charge**, systemic on the platform's main search model (aliases `gemini-search`, `gemini-search-fast`, `gemini-search-large`, …); an agent turn with 20 grounded searches ≈ $0.13 lost |

Additionally, the `xiaomi/fp8` route pins for both mimo models are **dead** (delisted; `createPinnedOpenRouterConfig` uses `allow_fallbacks: false`), so the pinned routes cannot match any provider — the re-costed sheets describe the only endpoints that can serve these models, and the pins are repinned to them (`venice/fp8`, `digitalocean`).

## Safe reproduction (non-destructive)

1. **Provider evidence (fetched):** `curl https://openrouter.ai/api/v1/models/<model>/endpoints` for each row above returns exactly the endpoint set and prices quoted (single Venice row for mimo-v2.5; single DigitalOcean row for mimo-v2.5-pro; Inceptron `0.0000008125/0.00000017/0.00000375` for kimi; `alibaba/fp8` `0.000001416/0.000000118/0.000002832` with the us-east-1 variant excluded by the pin's ignore list; `web_search: "0.014"` on every Google AI Studio endpoint for both gemini models).
2. **Red on unpatched main:** `npx vitest run test/text/openrouter-endpoint-price-sync.test.ts` — 5 tests FAIL against the pre-fix sheets (e.g. `expected 0.0000011837099… to be close to 0.0000014938799…` for deepseek prompt; `expected 0.007385 to be close to 0.01477` for the search unit cost). Green with the fix.

## Fix (`solution74-openrouter-endpoint-price-sync`)

All five sheets synced to the published endpoint rates (×1.055 credit fee as before), stale comments rewritten with the endpoint tags and verification date; the two dead mimo pins repinned to the only live endpoints; the gemini-4-carbon fallback search line joins the 14×1.055 consensus the other Gemini sheets already use.

## Verification

Parity suite 5/5 red-on-main → green; modelResolver pin suite and the StreamLake DeepSeek quote updated to the repinned routes; the enter effective-prices snapshot regenerated (only the five affected models' rows change); `tsc --noEmit` clean; 267/267 across the touched suites.

## Residuals recorded (below gate)

- `z-ai/glm-5.2`: pinned `z-ai/fp8` endpoint delisted; current default (Wafer) completion $6.8/M vs registry $4.4/M — unpinnable without the endpoint's own published price.
- `stepfun/step-3.5-flash`: slug delisted from OpenRouter (successor step-3.7-flash $0.20/$0.04/$1.15); only fileable if OR silently redirects.
- `qwen/qwen3.7-plus` / `qwen3.7-max`: OR publishes `input_cache_write` ($0.40/M; $1.84375/M list); registry has no cache-write line — needs usage-mapping confirmation.
- `gemini-2.5-flash-lite:search`: OR's endpoint charges `input_audio_cache` $0.03/M vs the sheet's $0.01/M cache-read line — matters only if audio tokens register cache hits.
- `gemini-4-carbon:ai-studio`: cache-write billed at the prompt rate ($2/M) while the endpoint publishes $0.1875/M — caller-overcharge margin, reverse direction, product decision.
- StreamLake-pinned entries (`qwen3-coder-next`, kimi/deepseek fallbacks) not endpoint-level verified this round; several unverifiable slugs (inception/mercury-2/2.5/3, respan/span-01-lite, kev-4b, laguna-s-2.1, flux-3-image, seedream-5.0-flash, recraft-v4.1-vector, happyhorse-1.1) listed as availability risks.

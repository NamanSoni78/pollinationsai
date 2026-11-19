# Issue 129 — dead OpenRouter endpoint pins: `minimax-m2.7` novita (full outage of a listed paid model) + `qwen3-coder-next` streamlake fallback; both sheets stale

- **Severity:** High (a listed paid model fails on every request; the fallback leg of the coding route can never rescue) / Medium for the stale-sheet latent mispricing (+28.6-36% over-bill if repinned without re-costing; input +50% / cache-read −49% for the qwen fallback)
- **Affected:** `shared/registry/text.ts:3681-3689` (minimax-m2.7 sheet), `gen.pollinations.ai/src/text/configs/modelConfigs.ts:574-577` (novita pin), `shared/registry/text-fallbacks.ts:1295-1310` (qwen streamlake sheet), `modelConfigs.ts:1118-1121` (streamlake pin) — upstream `pollinations/pollinations` main @ `8fc4c212a4`
- **Fix branch:** `solution129-or-endpoint-pin-refresh` — fork PR [#144](https://github.com/NamanSoni78/pollinationsai/pull/144)
- **Dedup:** issue 80 (the OpenRouter endpoint parity bundle) explicitly deferred "StreamLake-pinned entries (`qwen3-coder-next`, kimi/deepseek fallbacks) not endpoint-level verified this round" — this issue settles that residual. minimax-m2.7 is not in issue 80's affected list. Live re-verification of issue 80's own rows: mimo-v2.5/-pro dead pins and deepseek-v4-pro primary still live upstream (fork PR #94 still unmerged); no re-file.

## Root cause (endpoint-level evidence fetched live 2026-11-19 from `openrouter.ai/api/v1/models/<model>/endpoints`)

1. **`minimax/minimax-m2.7`** — the route is pinned `createPinnedOpenRouterConfig("minimax/minimax-m2.7", "novita/fp8")` → `only: ["novita/fp8"], allow_fallbacks: false`. That endpoint is **delisted**: the endpoints API returns only `gmicloud/fp8` ($0.21/$0.042/$0.84 per 1M, live) and `groq` ($0.60/$1.80, status −2 offline). Every request for this listed paid model (aliases `minimax-m2p7`, `minimax-m2.5`, `minimax-m2p5`, `minimax-m2.7`; `paidOnly: true`) therefore fails to match any provider. The sheet still carries the Novita rates (0.27/0.054/1.08 ×1.055) — repinning to gmicloud without re-costing would **over-bill every leg 28.6% (input) / 35.7% (cache) / 28.6% (output)**.
2. **`qwen/qwen3-coder-next:openrouter:streamlake`** (the coding fallback route, `availableModels.ts:499-502`) — pinned `only: ["streamlake"], allow_fallbacks: false`. The endpoints API returns only **`parasail/bf16`** ($0.12/$0.07/$0.80 per 1M). No streamlake endpoint exists → the fallback can never rescue a failed primary. The stale sheet (0.18/0.036/0.9 ×1.055) mis-prices input +50%, cache-read −49%, output +12.5% vs the live endpoint.

**Settling the deferred StreamLake residual (verified today):** `deepseek/deepseek-v4-pro-0813` @ `streamlake` (the route the config actually pins) is **live at exact parity** ($0.66/$0.022/$1.98 = the sheet); `moonshotai/kimi-k2.7-code` @ `streamlake` is **live at exact parity** ($0.7125/$0.1425/$3.0); the non-0813 `deepseek/deepseek-v4-pro` slug's streamlake endpoint ($0.898/$0.075/$1.796) is a different model listing that the platform does not route to — no drift. Only the qwen streamlake route is dead.

## Safe reproduction (non-destructive, public evidence + offline tests)

1. `curl https://openrouter.ai/api/v1/models/minimax/minimax-m2.7/endpoints` → no `novita/*` row; `curl .../qwen/qwen3-coder-next/endpoints` → no `streamlake` row;
2. `gen.pollinations.ai/test/text/openrouter-endpoint-pin-refresh.test.ts` — 2 tests **red on unpatched `8fc4c21`** (the sheets carry the stale rates).

## Fix (`solution129-or-endpoint-pin-refresh`)

- minimax-m2.7: repin to `gmicloud/fp8` (the only live endpoint) and re-cost the sheet to $0.21/$0.042/$0.84 ×1.055 (comment carries the endpoint tag + date);
- qwen streamlake fallback: repin to `parasail/bf16` and re-cost to $0.12/$0.07/$0.80 ×1.055 (the rates the primary sheet already carries). Route names are internal fallback keys (registry + availableModels + resolver match on them), so they are unchanged.

## Verification

2 registry tests red-on-main → green; pin/resolver/fallback suites 265 green; `model-registry` + `fallback` + `service-providers` 67 green; `modelResolver.test.ts` minimax pin row and `static-provider-fallbacks.test.ts` qwen row updated to the live tags; enter `pricing-data` minimax test re-pinned to the GMICloud rates; the enter effective-prices snapshot regenerated (exactly the two affected rows); `tsc --noEmit` clean.

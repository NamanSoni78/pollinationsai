# Issue 112 — `reasoning_effort:"max"` reaches providers unmapped (400s on mandatory models) or silently downgrades (Claude/Gemini), and six same-deployment siblings are missing the #19789 remaps

- **Severity:** Medium-High (user-visible correctness on documented enum values across ~30 routes including `paidOnly` tiers: hard 400s on one family, silent reasoning downgrades on two others, and the exact reject-class #19789 exists to fix left live on six sibling deployments)
- **Affected:** `gen.pollinations.ai/src/text/transforms/createReasoningEffortTransform.ts` (the `mandatory` branch, `:44-56` — handles `none`/`minimal`/`xhigh` but passes `"max"` through), `createClaudeThinkingTransform.ts` (`EFFORT_TO_BUDGET`/`EFFORT_TO_OUTPUT_EFFORT`, `:23-40` — no `max` key → the `medium` default fallbacks), `createGeminiThinkingTransform.ts` (`EFFORT_TO_BUDGET`, `:13-19` — same hole), and `availableModels.ts` (six entries). Upstream main `47573fa60b`, one commit after the #19789 sweep itself.
- **Fix branch:** `solution108-effort-max-coverage` (branch number predates the round-35 renumber; maps to this issue) — **PR:** fork [#127](https://github.com/NamanSoni78/pollinationsai/pull/127) (upstream PR creation remains 403-blocked by the token's `pull_requests:read` scope).

## Root cause

The public `reasoning_effort` enum grew `"max"` (f82845b4c4, Aug 2026), but only the #19789 remap tables learned it — and only for twelve providers:

1. **Hard 400 — mandatory capability.** `createReasoningEffortTransform("mandatory")` drops `none`, maps `minimal→low`, `xhigh→high`, and passes `max` through raw. Its own consumer comment says the model "accepts low/medium/high" (`availableModels.ts:1392`, minimax-m2.7) — so `reasoning_effort:"max"` is a settled caller-visible 400 on a documented enum value (no fallback: caller-error class).
2. **Silent downgrade — Claude thinking.** `EFFORT_TO_BUDGET` has `xhigh: 8192` but no `max`, and the transform falls back to `EFFORT_TO_BUDGET.medium` (`:88`) — `max` buys a **2048-token** budget, below even `high`'s 4096 and a quarter of `xhigh`'s 8192, on the budget-mode Haiku 4.5 routes. Adaptive mode (`:78`) falls back to `"medium"` while `xhigh` maps to `"high"` — the caller asks for maximum reasoning and receives medium, on ~20 Claude routes.
3. **Silent downgrade — Gemini 2.5.** `EFFORT_TO_BUDGET` (`:13-19`) maps `max` to the `medium` default **4096** while `xhigh`/`high` buy 8192.
4. **Six same-deployment siblings the sweep missed** (each shares the exact Azure resource + api-version of a route #19789 remapped):
   - `openai/gpt-5.4` and `openai/gpt-5-nano` — myceli-prod-eastus, `api-version=2024-12-01-preview`, same as the remapped `gpt-5.4-nano`/`-mini` (`modelConfigs.ts:291/:343/:328/:306`) — `max` forwarded raw.
   - `openai/gpt-6-sol`, `gpt-6.2-astra`, `gpt-6.2-sol` — myceli-prod-eastus, `api-version=2025-04-01-preview`, same as the remapped `gpt-6-astra`/`gpt-6.1-sol` (`modelConfigs.ts:407/:419/:425/:431` vs `:404/:413`) — `none` forwarded raw. `gpt-6.2-*` are `paidOnly` → paid-tier failures.
   - `pollinations/midijourney` — config `gpt-5.4-mini-chat` is the **identical deployment URL** as the remapped `openai/gpt-5.4-mini` (`modelConfigs.ts:349` vs `:343`) — `max` forwarded raw while `midijourney-large` was remapped.
   - The upstream commit's own message scopes the reject class to "GPT-5.x, GPT-6 Sol/Astra, gpt-oss-20b, Grok and Kimi K2.6" — these are all in-family.
   - Deliberately **not** touched: `gpt-6-luna`/`gpt-5.6-*` (no in-repo evidence those families reject any level), every `:aws`/`:openai`/`:openrouter`/`:deepinfra` variant (different hosts, unproven), and `openai/gpt-5-nano:openai` (api.openai.com).

## Safe reproduction (non-destructive)

`gen.pollinations.ai/test/text/transforms/` — red on unpatched main (`47573fa60b`), green on the branch (all deterministic offline):

- `createReasoningEffortTransform.test.ts`: new `normalizes max to high (mandatory models top out at high)` and 7 new rows in the `#19784` it.each table — **8 failing** on main: `mandatory` passes `max` raw; `openai/gpt-5.4`, `openai/gpt-5-nano`, `pollinations/midijourney` forward `max` unmapped; `openai/gpt-6-sol`, `gpt-6.2-astra`, `gpt-6.2-sol` forward `none` unmapped; `minimax-m2.7` receives `max`.
- `createClaudeThinkingTransform.test.ts`: budget-mode `max` → **2048** (the medium default) instead of the 8192 `xhigh` buys; adaptive-mode `max` → `"medium"` instead of `"high"` — **2 failing** on main.
- `createGeminiThinkingTransform.test.ts`: `max` → **4096** instead of 8192 — 1 failing on main.
- `parameterProcessor.test.ts`: the per-model accepted-levels table extended with the six newly remapped models (the same follow-up the upstream commit made for its own twelve).

## Fix (`solution108-effort-max-coverage`)

- `mandatory`: `max → high` (the level the class tops out at, mirroring `xhigh`).
- Claude: `EFFORT_TO_BUDGET.max = 8192`, `EFFORT_TO_OUTPUT_EFFORT.max = "high"` (same targets as `xhigh` — the established top of each ladder).
- Gemini 2.5: `EFFORT_TO_BUDGET.max = 8192`.
- Six sibling entries in `availableModels.ts` gain the remap their same-deployment siblings already have: `gpt-5.4` / `gpt-5-nano` / `midijourney` + `effortMaxToXhigh`; `gpt-6-sol` / `gpt-6.2-astra` / `gpt-6.2-sol` + `effortNoneToLow` — with source comments citing the deployment evidence.

Verification: the three transform suites 107/107 green (11+ red on unpatched main); the wider neighborhood (all `test/text/transforms/`, `responses.test.ts`, `generateTextPortkey.test.ts`, `model-registry.test.ts`, `responsesAdaptedChat`, `responsesChatAdapter`, `static-provider-fallbacks`) 452/452 green; `tsc --noEmit` clean.

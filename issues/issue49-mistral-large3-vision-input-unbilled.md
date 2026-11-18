# Issue: Mistral Large 3 serves image input at $0 after the Azure inlining commit (free-tier vision unbilled)

**Severity:** High
**Status:** Confirmed by isolated unit test on the real `openaiUsageToUsage` + `calculateUsageBilling` modules against `a38014db9d` (2026-11-18, red→green)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/51 (branch `solution39-mistral-large3-image-token-billing`)

## Summary

`cdde268c1` ("fix(text): inline remote images for Azure models that cannot fetch them", in the b4d7ebcb→a38014db window) set `requiresBase64ImageUrls: true` on the Azure `mistralai/mistral-large-3` deployment (`gen.pollinations.ai/src/text/configs/modelConfigs.ts:1204-1211`), turning a text-only route into a live **vision** route on a `paidOnly: false` (free-tier) model. Azure chat/completions reports image input as an inclusive `prompt_tokens_details.image_tokens` detail, and `openaiUsageToUsage` (`shared/registry/usage-headers.ts:243,276-278`) carves those tokens out of `promptTextTokens` onto the `promptImageTokens` line — a line the Mistral cost sheet (`shared/registry/text.ts:3920-3924`) never defined, because before the inlining every image request on this deployment failed at fetch time. `convertUsage` zero-fills rate-less lines (`shared/registry/registry.ts:280-285`), so **every image token on this model has billed at $0 since the inlining landed**.

Every sibling Foundry vision deployment prices this line: grok-4.20 (both) / grok-4.3 / grok-4.6 (`text.ts:1653-1658,1681,1711` — 1.25-2.0/M), kimi-k2.6 (`:2730`), kimi-k3.1-pro (`:2791`, with the explicit "Azure reports image input separately" comment), deepseek-v4.1-flash (`:1473` — whose own flag commit `b9ae41148` added the image rate *in the same commit*, the repo's convention for exactly this change).

## Root cause

```ts
// text.ts:3920-3924 (pre-fix) — image modality declared (:3932), no image rate:
cost: {
    promptTextTokens: perMillion(0.5),
    promptCachedTokens: perMillion(0.05),
    completionTextTokens: perMillion(1.5),
    // promptImageTokens missing → convertUsage zero-fills the line
},
```

## PoC (isolated test on the real modules; pre-fix results)

New case in `gen.pollinations.ai/test/text/generateTextPortkey.test.ts` (the astra-lineage pattern, chat-convention variant):

- `openaiUsageToUsage({prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: {image_tokens: 400}})` → `{promptTextTokens: 600, promptImageTokens: 400, completionTextTokens: 100}` (inclusive carve-out, pinned)
- `calculateUsageBilling` on `mistralai/mistral-large-3`: **`billing.cost.promptImageTokens` is `undefined` pre-fix (reproduced: 1 failed | 31 passed)** — 400 image tokens contributed exactly $0.00

## Impact

Free-tier (and tier-balance) vision requests on a frontier model bill their image input at $0: the platform pays Azure for the image tokens (the deployment is on the same myceli-prod-eastus resource as the grok/kimi/deepseek lineage, which report split image tokens), the caller's tier balance is never debited for them, and spend accounting under-reports every vision request. Same mechanism and impact shape as issue 34 (gpt-6.2-astra pair); this instance is broader in that the model is `paidOnly: false`.

## Fix

`promptImageTokens: perMillion(0.5)` on the mistral-large-3 cost sheet (the Mistral input convention — image tokens at the input-text rate, mirroring kimi/deepseek), with a comment documenting the inlining + inclusive-detail pipeline. Effective-prices snapshot regenerated (cost 5e-7 / price 3.75e-7 after the 0.75 multiplier). Verification: new case red→green; `generateTextPortkey.test.ts` 32/32; full `test/text/` **967/967**; `tsc --noEmit` clean.

## Coordination

Concurrent session 11 registered the same root cause **fleet-wide** as issue 46 / PR #54 (`solution39-vision-input-token-billing` — 17 models including `mistralai/mistral-large-3` at the same 0.5/M rate, live-verified on production with the bounty key) with the fallback sheets as issue 47 / PR #55. Per the round-11/12 mutually-exclusive-pair convention both PRs are preserved with cross-references: this branch is the minimal scoped fix for the evidenced lineage; maintainers can take either (the registry hunks overlap — resolve by keeping the fleet-wide version if both merge). Session 10 independently filed the same-mechanism `qwen/qwen4-max:vercel` instance as issue 45 / PR #50.

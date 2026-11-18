# Issue 46 — Vision input billed at $0 across the text-model fleet (17 models' cost sheets omit the `promptImageTokens` rate on separately-reporting routes)

- **Severity:** High (caller-forcible free vision input; several affected models are `paidOnly: false`, i.e. Quest-funded; live-confirmed on production with the bounty key)
- **Affected:** `shared/registry/text.ts` (17 primary sheets + 8 long-context variant sheets) and `shared/registry/text-fallbacks.ts` (`mistralai/mistral-large-3:aws`) — upstream `pollinations/pollinations` main @ `a38014db9` (2026-11-18)
- **Fix branch:** `solution39-vision-input-token-billing` — **PR:** [#54](https://github.com/NamanSoni78/pollinationsai/pull/54)
- **Relationships:** same defect class as issue 34 (`openai/gpt-6.2-astra`, fixed on `solution30-gpt62-astra-image-token-billing` / PR #39, still unmerged) and issue 45 (`qwen/qwen4-max:vercel`, PR #50) — this issue is the fleet-wide instance on the **primary** routes. The `mistralai/mistral-large-3` entries are concurrently fixed by PR #51 (`solution39-mistral-large3-image-token-billing`); the lines are identical in effect — merge either, the other resolves trivially.

## Summary

Azure OpenAI-family routes, the AWS Bedrock OpenAI-compatible surface, and the Vercel AI Gateway report image input as its own usage dimension (`prompt_tokens_details.image_tokens`), and `openaiUsageToUsage` (`shared/registry/usage-headers.ts`) carves it out of `promptTextTokens`. `convertUsage` (`shared/registry/registry.ts:266-289`) **zero-bills any usage line whose sheet has no rate** — its own comment calls this the "silent billing leak" hazard. Seventeen image-capable models (`inputModalities: ["text","image"]`, `maxReferenceImages` up to 10) had no `promptImageTokens` rate:

`openai/gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5-nano`, `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6.1-terra`, `gpt-6-astra`, `moonshotai/kimi-k3`, `tencent/hy4-flash`, `mistralai/mistral-large-3` (+ its `:aws` fallback sheet), `meta/llama-4-maverick`, `pollinations/midijourney`, `pollinations/midijourney-large`.

That this is an oversight and not policy is provable from the registry itself: the already-priced siblings on the same surfaces (`grok-4.20/4.3/4.6` on Azure, `gpt-6-sol`/`gpt-6.1-sol`/`gpt-6.2-sol`/`gpt-6-luna`, `kimi-k3.1-pro` "Azure reports image input separately; both bill at the input rate", `deepseek-v4.1-flash-1017`) all price image tokens at the model's input-text rate. `cdde268c1` (#19929) newly image-enabled `Mistral-Large-3` (base64 inlining) without adding its rate. Fold-behavior models (`openai/gpt-4o-mini` "Image inputs are included in promptTextTokens by the provider", OpenRouter's qwen3.7) are correctly excluded from this list.

## Root cause

```ts
// shared/registry/text.ts — mistralai/mistral-large-3 (pre-fix; image input
// enabled by cdde268c1's requiresBase64ImageUrls transform):
inputModalities: ["text", "image"],
cost: {
    promptTextTokens: perMillion(0.5),
    promptCachedTokens: perMillion(0.05),
    completionTextTokens: perMillion(1.5),
},   // ← no promptImageTokens

// shared/registry/registry.ts:266-289 — the zero-fill:
const conversionRate = rateDefinition[usageTypeWithFallback];
if (conversionRate === undefined) {
    console.warn(`[registry] Missing conversion rate: … — billing 0 for this line`);
    return [usageType, 0];
}

// shared/registry/usage-headers.ts — the carve-out that makes the image
// tokens vanish from the text line (observed Azure shape, pinned by the
// repo's own fixtures): promptTextTokens = prompt_tokens − image_tokens
```

## PoC (isolated red test on the real modules; pre-fix results)

New `gen.pollinations.ai/test/vision-input-token-billing.test.ts` against the real `TEXT_SERVICES` / `openaiUsageToUsage` / `calculateUsageBilling` — all 17 model cases fail on unpatched `a38014db9`:

- `expected undefined to be defined` — every affected sheet lacks `promptImageTokens` while the model accepts image input;
- `expected 0 to be greater than 0` — 76 provider-reported image tokens contribute **$0.00** to the caller's price on every affected model (e.g. `gpt-5.6-sol`: billed $0.0005 for `{15 text, 76 image, 22 completion}` instead of $0.0021);
- the long-context variant case (`gpt-5.5` at >272k prompt tokens) also zero-bills the image line at the doubled input rate;
- controls green: the carve-out shape itself, and already-priced `x-ai/grok-4.20` bills image tokens > $0.

## Live verification (non-destructive, own key, production, 2026-11-18)

- `mistralai/mistral-large-3` + 1 image (`POST /v1/chat/completions`): the model **describes the image** in its answer ("The attached image shows a circular red and white logo…"), proving vision input was fetched, inlined and processed — and the balance moved by exactly the **text-only** cost `(44 prompt-text × $0.5 + 26 completion × $1.5)/1M × 0.75 = $0.00004575`. Image contribution: **$0.00000000**.
- `moonshotai/kimi-k3` + 1 image: same result — charge `(117 × $3 + 167 × $15)/1M = $0.002856` matches the text-only token math to the cent; the model's reasoning confirms it saw the image; no `x-usage-prompt-image-tokens` line appears.
- (`openai/gpt-5.6-luna` + remote-URL image: Azure silently drops the URL image on that route — `image_tokens: 0`, model does not describe it; the billing gap materializes on this family through data-URI inputs and the inlined `:aws` fallback routes, which is exactly the shape the repo's own AWS/Azure usage fixtures pin.)

## Impact

Free vision input for any caller on 17 models — up to 10 reference images ≈ 8-11k image tokens per request: ≈ **$0.024-0.033** of provider spend per request on `kimi-k3` ($3/M input, Quest-accessible), up to **$0.08-0.11** on `gpt-6-astra` ($10/M, `paidOnly: false`), none of it billed to the caller while the platform pays the provider. Repeatable at the per-user RPM limits.

## Fix

Add `promptImageTokens` at each model's input-text rate (the sibling rule) to all 17 primary sheets and their 8 `long_context` variant sheets, plus the `mistral-large-3:aws` fallback's own cost sheet (Bedrock's OpenAI-compatible surface reports the split — pinned by the AWS usage fixture in `test/text/generateTextPortkey.test.ts`; the stale comment claiming Bedrock folds image input into the prompt total is corrected). Regenerate the effective-prices snapshot. Post-fix: the new suite 21/21 green; 1,270+ regression tests across billing/model-registry/fallback/tracking suites green; `tsc --noEmit` clean. `openai/gpt-6.2-astra` stays on PR #39's branch (no duplicate lines).

## Follow-ups (not in this fix; reporting shape needs a one-request confirmation per provider)

`tencent/hy4-flash` **is included** (Vercel gateway precedent prices image tokens on sibling routes); still unpriced and unverified: the Anthropic Claude family (Bedrock/Anthropic-direct reporting shape unknown), `moonshotai/kimi-k3.1-pro-highspeed`, `meta/muse-spark-*`, `minimax-m3*`, `nex-agi/nex-n2.5-*`, `thinkingmachines/inkling-small`, `nvidia/nemotron-3.5-super-vl`, `amazon/nova-2-lite-v1`, `z-ai/glm-5.3-flashx`, `stepfun/*`, `xiaomi/mimo-v2.5`, `cohere/command-a-plus`, `mistralai/mistral-small-3.2`, `inferenceport-ai/lightning-*` — all advertise image input with no image rate; adding a rate is a no-op until the provider reports the split, but each needs its surface confirmed first.

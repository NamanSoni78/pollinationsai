# Issue: Community publishers bill callers on unbounded self-reported usage — one response can charge 4.5e17 Pollen

**Severity:** High
**Status:** Confirmed by unit test against the unpatched billing path (2026-11-18, `bbccf2f5`)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/13 (branch `solution10-community-usage-billing-cap`)

## Summary

Community proxy models bill `quantity × unit price`, where the quantity — prompt/completion tokens (text, embeddings, token-mode images), video `usage.duration` seconds, transcription `duration` seconds — is **whatever the publisher's own server reports** in its response. The registration-time safeguards cap only the *rate* side:

- `PRICE_LIMIT_BY_UNIT` (`enter.pollinations.ai/src/routes/community-endpoints/proxy-policy.ts`) caps per-token / per-second / per-image prices (`MAX_COMMUNITY_PRICE_PER_TOKEN = 50/1M`, etc.).
- The usage *quantity* validation only checks type/positivity: `isTokenCount` (`shared/registry/usage-headers.ts:351`) accepts any safe integer ≥ 0, and `CommunityVideoUsageSchema` (`shared/community-media.ts:15`) accepts any positive `duration`.
- `calculateLinearCost` → `totalPrice` (`shared/registry/registry.ts`) applies no maximum; the preflight `canCoverEstimatedCharge` gates on a statistical *estimate*, and the settle path `atomicDeductUserBalance` deliberately permits negative balances (documented debt accrual), so nothing downstream clamps the final charge either.

A publisher reporting `usage: {prompt_tokens: 9007199254740991, completion_tokens: 0, total_tokens: 9007199254740991}` settles **each caller** at `9e15 × 50/1M ≈ 4.5e17` pollen (reproduced: see PoC below), and the publisher earns 75% of the charge as a community reward (`COMMUNITY_MODEL_REWARD_RATE` via `resolveCommunityModelReward`) whenever the payer's post-deduction balance stays non-negative. The victim pool includes callers routed to the model by *another listing's fallback* (fallback eligibility caps prices, not usage-derived totals), and anyone calling a public community model.

## Root cause

Untrusted input (the publisher's self-reported usage) used as the billing quantity without a per-request upper bound, while all existing safeguards bound the other side of the multiplication (the unit price).

## PoC (isolated unit test, own test D1 — no production access)

`gen.pollinations.ai/test/community-usage-clamp.test.ts`, first test, run against unpatched `origin/main` (`bbccf2f5`):

```ts
const definition = communityModelDefinition({
    modelId: "community/attacker/proxy",
    modality: "text",
    ...communityEndpointPrices({
        promptTextPrice: 50 / 1_000_000, // the registration maximum
        completionTextPrice: 50 / 1_000_000,
    }),
});
const billing = calculateUsageBilling({
    model: "community/attacker/proxy",
    usage: { promptTextTokens: 9_007_199_254_740_991, completionTextTokens: 0 },
    servedBy: definition,
});
```

Observed on unpatched code: `billing.price.totalPrice = 450359962737049540` (~4.5e17 pollen) from a single response. After the fix: exactly **500** (10M-token ceiling × 50/1M).

The video variant (report `usage.duration: 1e9` on a 0.5 pollen/s listing) and the transcription variant (publisher-reported `duration`) flow through the same `calculateUsageBilling` choke point.

## Impact

- **Caller drain / forced debt:** any caller of a malicious community model is charged an astronomical amount; the deduction ladder carries the difference into debt.
- **Publisher profit:** 75% of the charge is credited to the publisher whenever the payer's balance stays ≥ 0 — a direct monetization path for a hostile endpoint.
- **Reach:** allowlisted publishers (~90 GitHub accounts) can register public models; victims include fallback-routed callers who never chose the endpoint.

## Fix

`shared/registry/registry.ts` — `clampCommunityUsage()`, applied inside `calculateUsageBilling` when the serving (or quoted) definition is a community model:

- token-typed usage: clamped to **10M per request per usage type**
- seconds-typed usage (`promptAudioSeconds`, `promptVideoSeconds`, `completionAudioSeconds`, `completionVideoSeconds`): clamped to **3600s per request**

The ceilings sit two orders of magnitude above the largest plausible legitimate request (request prompts capped at tens of thousands of characters, generations at tens of thousands of tokens, uploads at tens of megabytes), so only fraudulent reports are truncated. Worst single-request charge at the maximum allowed community rate becomes 500 pollen. Trusted-provider usage is never clamped (platform/provider-measured).

Verification after fix: 5 new tests in `community-usage-clamp.test.ts` (clamped magnitude, legit usage unchanged, video duration clamp, trusted-provider not clamped, community-quote clamped); regression suites `community-endpoints.test.ts` + `tracking-observability.test.ts` + `static-provider-fallbacks.test.ts` (405 tests), full `shared` suite (646), gen text/audio suites (54) all pass; `tsc` delta zero.

# Issue 36 — Stem separation bills the parsed upload duration but admits on the historical mean

- **Severity:** High (monetary integrity)
- **Affected:** `gen.pollinations.ai/src/routes/stem-separation.ts`, `gen.pollinations.ai/src/audio/stem-separation.ts` — upstream `pollinations/pollinations` main @ `6538ea2721`
- **Status:** Verified at `6538ea2` by isolated tests over the real registry + real route code (2026-11-18); reproducible pre-fix by the same suite on the unpatched gate
- **Fix branch:** `solution32-stem-separation-exact-funds-gate` — **PR:** [#41](https://github.com/NamanSoni78/pollinationsai/pull/41)

## Summary

`POST /alpha/audio/stem-separation` mounts `generationAccess` **before** the handler, so admission gates on the model-level estimate — Tinybird's historical **mean** (`avg_cost_usd`), or **exactly $0** for a model with no price history. But the bill is the **decoded upload duration** (`stemInputSeconds`, parsed from the uploaded file) times the variation's per-second rate, a number the worker computes *before* dispatching to ElevenLabs and uses directly in `buildUsageHeaders(createAudioSecondsUsage(billedSeconds))`. Nothing between the mean-based admission and the settlement ever re-checks funds on the exact charge.

## Root cause

`handleStemSeparation` parses `inputSeconds` (line 127) and sets the pricing input, then dispatches — the exact charge is known before execution but only `requireAccountFunds`-style gating (used for sandbox leases) would enforce it. The only input bound is the 50 MB file-size cap, not the billed duration: 50 MB at 32 kbps decodes to ~13,107 seconds.

## PoC (non-destructive, isolated)

1. **Settlement arithmetic (real registry):** `calculateUsageBilling("elevenlabs/stem-separation", { promptAudioSeconds: 13_107 }, { stemVariation: "six_stems_v1" }).price.totalPrice` = 13,107 × $0.005/s ≈ **65.5 pollen** per request; two-stem at $0.0025/s.
2. **Admission (real gate code, pre-fix):** a paid caller with `packBalance: 0.01` (paidOnly model, mean estimate $0.4112 or $0 with no history) passes `checkBalance` — reproduced by the same mocked-vars pattern `byop-markup.test.ts` uses — and the render is dispatched.
3. **Key budget:** the reservation is sized from the same mean (`apiKeyBudgetEstimate`), so `atomicAdjustApiKeyBalance` reconciles ~65 pollen below the reserve.

Same family as issues 32/35 (mean-based preflight under-reservation) but a distinct root site: the exact charge is computed **before** the upstream call and never gated.

## Impact

A $0.01-balance paid account extracts ~16–65 pollen of ElevenLabs provider spend per request; repeatable per request (one overdraft render per account/key before the balance gates later requests).

## Fix

Mirror the platform's own gate for charges known before execution: `requireStemFunds` runs after `stemInputSeconds`, `requireFunds` on `calculateUsageBilling(promptAudioSeconds: inputSeconds, stemVariation)` — wallet (paidOnly semantics) first, key budget before the wallet — and tops the API-key budget reservation up to the exact charge. Tests: 5 new gate cases (arithmetic incl. the 13,107 s worst case, 402 below / admission above the exact charge, key-budget-first refusal, unauthenticated skip); the 13 original route-level e2e cases unchanged and green (18/18).

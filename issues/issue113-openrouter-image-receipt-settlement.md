# Issue 113 — the OpenRouter image routes discard the gateway billing receipt: `bytedance/seedream-4.5` settles the flat 2K-era sheet rate for caller-forced 4K tiers, and both grok-imagine image routes settle flat with no receipt

- **Severity:** High (systematic under-billing on a caller-controllable resolution tier + receipt-less drift on an unpinned route, on `paidOnly` models — the platform eats the difference between the provider charge and the flat rate billed to the caller)
- **Affected:** `gen.pollinations.ai/src/image/models/openRouterImageModel.ts` — `callOpenRouterSeedreamProAPI` (handler :373-458: `use4K = Math.max(safeParams.width, safeParams.height) > 2048` at :399, settle `usage: { completionImageTokens: 1, totalTokenCount: 1 }` with no `providerBilling`, receipt `data.usage` logged as `providerUsage` and discarded), `callOpenRouterGrokImagineProAPI` (:625-706 — primary `x-ai/grok-imagine-image-quality` route, **no `provider` pin** in its requestBody so OpenRouter may route to any endpoint at any price), `callOpenRouterGrokImagineImage2API` (:695-775 — the xai-pinned fallback route); registry `shared/registry/image.ts:606-622` (`bytedance/seedream-4.5` — single flat `cost: { completionImageTokens: 0.04 * 1.055 }`, **no cost variants, no `resolutions` list, no `promptImageTokens` line** while `maxReferenceImages: 14`). Upstream main `459b7c41c` (2026-11-18 16:43 UTC).
- **Fix branch:** `solution110-openrouter-image-receipt-settlement` (branch number predates the round-36 renumber; maps to this issue) — **PR:** fork [#128](https://github.com/NamanSoni78/pollinationsai/pull/128) (upstream PR creation remains 403-blocked by the token's `pull_requests:read` scope).

## Root cause

The same file already contains the correct pattern, applied to four sibling routes: `bytedance/seedream-5.0-flash` (:494-515 — validates `data.usage.cost` fail-closed via `invalidOpenRouterImageUsage`, settles `providerBilling: { units: providerCost, unitCost: 1.055 }`), flux-2-max (:781-823, receipt plus measured output megapixels), the qwen image routes, and `bytedance/seedream-5.0-pro`'s own registry comment reads *"per 2K image; settle from gateway receipt"*. `providerBilling` overrides the usage-based sheet settlement end-to-end (`shared/registry/registry.ts:535-537` — "overridden by providerBilling; those use its units and unitCost").

Three routes in the same module never got that treatment:

1. **`bytedance/seedream-4.5`** computes `use4K` from the caller's width/height (uncapped for this model — `params.ts` documents "no scaling/limiting") and sends `resolution: "4K"` + `provider: { only: ["seed"], allow_fallbacks: false }` whenever the long edge exceeds 2048 px. It then settles a flat `completionImageTokens: 1` at the registry's `0.04 * 1.055 = $0.0422` — a rate written from the 2K price. The response's `usage.cost` receipt is logged (`logOps(..., { providerUsage: data.usage })`) and thrown away. The registry entry has no 4K cost variant and no `resolutions` list — which is also why the schema rejects `resolution=4k` and width/height is the only knob needed to reach the unpriced tier. Up to 14 `input_references` are forwarded with no `promptImageTokens` rate line either. The repo's own test file pins the tier upgrade ("uses the 4K tier above 2048px and preserves explicit aspect ratios", whose mock already returns `usage: { cost: 0.04 }` — proving the receipt is present and ignored).
2. **`x-ai/grok-imagine-image-quality`** (primary route) sends no `provider` pin at all, settles the flat sheet (`completionImageTokens: 0.05 * 1.055` + `promptImageTokens` on edits), and likewise logs `providerCost: data.usage?.cost` without using it. With no pin, OpenRouter can route the request to any endpoint at any price — exactly the drift the flash route's fail-closed receipt settlement exists to absorb.
3. **`x-ai/grok-imagine-image-2.0:openrouter`** (fallback route) mirrors the flat settle; its cost-ledger/`servedPrice` accounting also misses the real provider number.

Preflight agrees with the broken settlement (`getDefinedRequestEstimate` → flat 0.0422), so no guard fires; the caller is billed the flat rate while the provider charges the 4K/unpinned price. Every receipt above the flat rate is under-billed by exactly `receipt − flat` (issue #53 documented OpenRouter repricing by resolution; issue #80 documented the text-sheet drift of the same mechanism).

## Attack path (safe, non-destructive form)

`POST /v1/images/generations` with `{"model":"bytedance/seedream-4.5","width":4096,"height":2304,"prompt":"..."}` on a `paidOnly` model: the caller pays $0.0422 while the pinned Seed 4K endpoint charges its 4K price for every such request. The offline unit test encodes the same differential (mock receipt 0.08 at width 4096 vs flat 0.0422) without spending provider money.

## Safe reproduction (deterministic offline)

`gen.pollinations.ai/test/image/openRouterImageModel.test.ts`:

- **RED on unpatched main: 13 tests fail** — the pinned Seed-provider test (mock returns `usage.cost: 0.04`) now expects `providerBilling: { units: 0.04, unitCost: 1.055 }` and gets none; the new "settles the unpriced 4K tier from the provider receipt" test (mock `cost: 0.08`, `width: 4096`) sees `providerBilling: undefined`; the new `it.each([null, { cost: 0 }, { cost: -0.04 }, { cost: Infinity }])` invalid-receipt cases succeed flat instead of throwing `502 OpenRouter returned invalid image billing usage`; the grok quality/image-2 trackingData assertions and the new receipt-less-success rejection fail the same way.
- **GREEN with the fix: 72/72** — receipt settlement pinned for the 2K tier (0.04) and the 4K tier (0.08), fail-closed behavior pinned for all three routes, grok assertions updated to `{ units: 0.05, unitCost: 1.055 }` (their existing mock's cost).
- **Blast-radius controls:** the full `test/image/` directory 48 files / 963 tests green on the fix branch; `tsc --noEmit` clean; biome clean. Live probes: $0 (the probe class would spend real provider money on a paidOnly model; the mock-receipt differential is the maintainer-safe equivalent — the mechanism, not the dollar amount, is the finding).

## Fix (`solution110-openrouter-image-receipt-settlement`)

Mirror the flash sibling verbatim in all three handlers: read `providerCost = data.usage?.cost`, reject missing / non-finite / ≤0 receipts with `invalidOpenRouterImageUsage` (fail-closed — a receipt-less success cannot silently settle the sheet rate), and settle `providerBilling: { units: providerCost, unitCost: 1.055 }` so the actual provider charge wins over the flat sheet. The `usage` block is kept for variant/reporting parity with the flash route. The registry sheet is left unchanged — it remains the preflight/estimate source, and receipt settlement self-corrects any future per-resolution repricing without a code change (the flash design rationale).

## Dedup notes

- Issue 53 (grok VIDEO routes, `openRouterVideoModel.ts` — receipt-discard on exactly two video routes) and issue 80 (OpenRouter TEXT sheet drift) are the filed siblings of this mechanism; this is the **image-module instance set** (three routes in `openRouterImageModel.ts`), never filed. Issue 47 (`fallback-cost-sheet-completeness`) and issue 52 (`vision-input-rate-sheet-residual-fleet`) covered fallback/text vision-line drops; issues 45/46/49 the text vision-input fleet. Issue 70 (gemma cached-input zero-rate) is a registry-sheet bug, not a receipt discard.
- File-disjoint from the concurrent round-35 branches (effort remaps in `responses/client.ts` / `handler.ts` / `request.ts`, `availableModels.ts`, transforms) and from rounds 30-34's pending branches; merge conflict surface: none (the file's last upstream change predates all five upstream commits in this round's range).

## Deliberately out of scope

- Adding a priced 4K registry variant (requires the actual 4K price — unknowable offline; receipt settlement is self-correcting, which is why the flash route has no variant either).
- Pinning the grok-quality route's provider (a routing/product decision; receipt settlement makes billing correct regardless of routing).
- The estimate==flat under-reservation residual for 4K requests (the filed issue-32 family) is narrowed — settlement now reflects the real charge — but preflight still estimates the sheet rate until a 4K variant exists.
- `promptImageTokens` for seedream-4.5 references: the receipt already includes the reference-image charges; a sheet line would be display-only under receipt settlement.

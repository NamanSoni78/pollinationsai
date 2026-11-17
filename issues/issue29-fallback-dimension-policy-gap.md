# Issue 29 — Unbounded image dimensions forwarded to per-area-billed fallback providers while the caller pays the primary pool's flat quote (up to ~21× platform subsidy loss)

- **Severity:** Medium (platform money loss; sustained ~$1.5–5/min per key; precondition is a pool outage/saturation, which the ops log shows occurs in production)
- **Affected:** `gen.pollinations.ai/src/image/models/zImageFalModel.ts`, `gen.pollinations.ai/src/image/models/prunaModel.ts` (`callFluxSchnellDeepInfraAPI`) — upstream `pollinations/pollinations` main @ `30ae4da`
- **Fix branch:** `solution25-fallback-dimension-policy` — **PR:** [#33](https://github.com/NamanSoni78/pollinationsai/pull/33)

## Root cause

The image schema has **no width/height maximum** (`params.ts:36-39` — `sanitizedSideLength` is `z.int().positive().optional()`; `adjustImageSizeForModel` documents *"no scaling/limiting"*). The only layer that polices size is the self-hosted GPU pool software itself:

- the z-image workers 422 anything over `MAX_FINAL_PIXELS = 768²×4 = 2,359,296 px` (sides 256–4096) — `operations/infrastructure/gpu/zimage/server.py:95-122`
- the flux workers clamp to `MAX_PIXELS = 810,000` preserving aspect ratio — `operations/infrastructure/gpu/flux/dimensions.py:47-50`

Those checks never run when the pool itself is the failure: an empty pool throws 503 (`availableServers.ts:179-183`), queue saturation (worker `QUEUE_LIMIT=3`) throws 503 after retrying — and 503 is retryable, so the request sheds to the **per-area-billed fallback** with its **raw dimensions**:

```ts
// zImageFalModel.ts (pre-fix) — raw forwarding
image_size: { width: safeParams.width, height: safeParams.height },
```

```ts
// prunaModel.ts (pre-fix) — raw forwarding
const input: FluxSchnellInput = { prompt, width: safeParams.width, height: safeParams.height, ... };
```

The caller keeps paying the primary's flat quote (`calculateUsageBilling` keeps `price: quoted.price` on fallback), while the platform's cost is the fallback's area-based charge (`fal.zimage.output_megapixels.v1` at $0.005/unit from `falBillableUnits`; DeepInfra's reported area-scaled cost via `providerBilling`).

**Cost/price split for z-image (flat $0.004):** `2048×2048` → fal rounds to 5 MP units → **$0.025 cost vs $0.004 charged (6.25×)**; `4096×4096` → 17 units → **$0.085 vs $0.004 (~21×)**. At the normal per-key rate limit this sustains ~$1.5–5/min of loss per key.

**Precondition occurs in production:** `operations/infrastructure/gpu/GPU_INSTANCES.md` records a 2-day z-image pool outage where *"roughly two days, all Z-Image traffic ran on the Fal fallback"* — no attacker effort needed, and an attacker can additionally saturate the 3-slot worker queues to force shedding.

## Safe reproduction (isolated unit tests, no network)

1. `ImageParamsSchema.parse({ model: "tongyi-mai/z-image-turbo", width: 4096, height: 4096 })` succeeds (no max), and on unpatched main `callZImageFalAPI` posts `image_size: { width: 4096, height: 4096 }` to fal (17 billable megapixel units at the $0.004 flat quote).
2. On unpatched main `callFluxSchnellDeepInfraAPI` with `width: 4096, height: 4096` forwards the raw 16.8 MP request to DeepInfra (area-billed) at the $0.002 flat quote.

## Fix (`solution25-fallback-dimension-policy`)

The fallbacks now honor their primary pool's dimension policy, restoring the guarantee the pool 422 was designed to provide:

- **z-image fal route** — `assertWithinZImagePoolCap` rejects sides outside 256–4096 or area above 2,359,296 px with the same 422 the workers answer (terminal, unbilled, `fetch` to fal never happens). An oversized request now behaves identically whether the pool is up (422 from the worker) or down (422 from the fallback).
- **flux DeepInfra route** — `clampToFluxPoolPixelCap` scales to 810,000 px preserving aspect ratio, exactly as the flux workers do before generating.

## Verification

`zImageFalModel.test.ts` — **9/9** (4 new: 4096², 2048², undersize 100×100, and 8192×256 all rejected pre-fetch with 422 and `fetch` never called; cap-exact 1536×1536 served unchanged). `prunaModel.test.ts` — **10/10** (2 new: 4096² clamped under 810,000 px with aspect kept; sub-cap 1024×768 forwarded untouched). `fluxFallback.test.ts` regression — **18/18**. `tsc --noEmit` clean.

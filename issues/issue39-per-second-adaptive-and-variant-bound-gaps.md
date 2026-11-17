# Issue 39 — Per-second preflight: adaptive output length and cost-variant gaps the duration-precise fixes leave open (cross-reference to issues 32/35)

- **Severity:** High (billing integrity — residual of the vulnerability registered as issues 32/35)
- **Affected:** `gen.pollinations.ai/src/utils/model-stats.ts`, `gen.pollinations.ai/src/utils/generation-access.ts`, `gen.pollinations.ai/src/image/models/seedance25VideoModel.ts`, `shared/registry/image.ts` (seedance-2.5 entry) — upstream `pollinations/pollinations` main @ `6538ea2721`
- **Status:** CODE-VERIFIED with failing-today assertions over the real registry and the real gate (`byop-markup` pattern); every number below recomputed against the registry at `6538ea2`
- **Fix branch:** `solution31-video-persecond-preflight-worstcase` — **PR:** [#44](https://github.com/NamanSoni78/pollinationsai/pull/44)
- **Relationship:** Issues 32 (PR #37, upper-bound reserve) and 35 (PR #40, requested-duration-precise) registered the per-second preflight under-reservation. This companion covers **two residual root causes their fixes do not bound**; the three branches are alternative implementations of the same functions — maintainers can take either, or fold the adaptive bound into either.

## Residual 1 — model-picked output length has no request duration to thread

`bytedance/seedance-2.5` adaptive reference-video edits — `reference_videos` + `aspectRatio` unset or `adaptive`, the documented **default** (`schemas/image.ts:176-179`): *the model picks the output length (up to 30s), and each output second is billed at the video-input rate*. The request sends `duration: -1`; there is **no caller duration**, so a duration-precise fix resolves to `defaultDuration` = **4** and reserves 4 × rate while the settlement bills the model-picked seconds:

| Request (seedance-2.5, ref video) | PR #40-style reserve | Settlement | Under-factor |
|---|---|---|---|
| adaptive, 720p | 4 × $0.1028 (base) = $0.41 | up to 30 × $0.9676 = **$29.03** | **70×** |
| adaptive, 480p | 4 × $0.1028 = $0.41 | up to 30 × $0.4304 = $12.91 | 31× |
| plain 720p, 4s | 4 × $0.1028 = $0.41 | 4 × $0.2312 = $0.92 | 2.3× |

Even the upper-bound fix (PR #37) would size `maxDuration` × base rate = 4 × $0.1028 = $0.41 — the registry's `maxDuration: 4` describes the **requested** param, not the model-picked ceiling; the 30s bound lives only in the schema doc text today, so no registry-derived fix can express it.

## Residual 2 — the estimate prices the base sheet, the settlement prices the request's variant

The seedance selector (`shared/registry/image.ts:1923-1934`) bills `video_in_720p` ($0.9676/s) / `video_in_480p` ($0.4304/s) for reference-video requests and `720p` ($0.2312/s) for plain 720p — **4–9.4× the base rate** ($0.1028/s). Any estimate that does not run the request's facts through the variant selector under-reserves by the variant ratio even when the duration is exact (row 3 above).

## PoC (non-destructive, isolated)

Pre-fix (`6538ea2`), over the real registry and real `checkBalance`: `getDefinedRequestEstimate(seedance-2.5) === null` (per-second video fails `isFlatRateModel`); `getEstimatedPrice` with no Tinybird rows = **0** → a `packBalance: 0.01` caller is admitted for a request whose worst case is **29.03 pollen**; with the mean ($0.4112) it is still admitted. Settlement worst case pinned via `calculateUsageBilling` with the `hasReferenceVideo`/`resolution` pricing input = 30 × 0.9676. Post-fix: the same gate **402s** at $0.01 and resolves at $30; a 60s model-picked report is clamped to a 30s bill.

## Fix

- thread the validated query (duration, resolution, `reference_videos`, adaptive detection) into `generationAccess`/`checkBalance` after the route's zod validator;
- gate per-second video on the request's worst case: requested/default duration clamped to `maxDuration`, or the new registry field **`adaptiveMaxDuration`** when the model picks the length;
- rate it through the **same cost-variant selector the settlement runs** (base-rate fallback on selector error, mirroring `selectCostVariant`'s own error path);
- declare `adaptiveMaxDuration: 30` on seedance-2.5 and clamp the adaptive bill to the declared ceiling, so the preflight bound always holds.

Explicit-duration plain renders keep their own tight bound (4s at the selected variant rate); all 24 per-second video models are `paidOnly`, so Quest tier traffic is unaffected; the mean still applies when the duration is unbounded or request facts are absent. Tests: 12 new assertions + the adaptive clamp case; `byop-markup` 51/51, `test/image/` 953/953 (48 files), route e2e 314/314, `tsc` clean.

# Issue 83 — The 3D docs' paid-balance note contradicts the registry: the documented default flow 402s for every Quest-funded caller (first docs↔enforcement parity gate)

- **Severity:** Medium-High (documented access/billing guarantee enforced with the opposite value; doc trust on the platform's *default* 3D flow)
- **Affected:** `gen.pollinations.ai/src/docs/3d-generation.md:12-13` (+ its republished copy at `APIDOCS.md:5198-5199`, `/docs/llm.txt`, `/llms-full.txt`, and the Scalar docs) vs `shared/registry/model3d.ts` — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution77-3d-docs-quest-balance-parity` (name verified unique at push) — fork PR [#95](https://github.com/NamanSoni78/pollinationsai/pull/95)
- **Found:** the APIDOCS-parity sweep lead that twice failed on infrastructure limits in earlier rounds, completed this round by a read-only subagent and main-agent-verified (registry flags re-checked directly: `paidOnly: true` for **all** of `tripo3d/p2`, `microsoft/trellis-2`, `microsoft/trellis-2:fal`, `nvidia/asset-harvester`, `hyper3d/rodin-2.5`).

## Root cause

Upstream flipped the 3D models to paid in `d7b749c2fc` ("fix: require paid Pollen outside Azure and Fireworks", 2026-10-13) when trellis-2 moved to the paid InferencePort GPU — but the docs sentence survived (the last edit to the file, `92cdfd07f6` 2026-11-17, even re-asserted it):

> **Note:** `hyper3d/rodin-2.5` and `nvidia/asset-harvester` require the paid balance. `microsoft/trellis-2` (the default) supports `low`, `medium`, and `high` resolution and **works with the Quest balance**.

Meanwhile the code enforces the opposite: `canCoverEstimatedCharge` with `paidOnly: true` never accepts the Quest balance, `utils/refusals.ts` 402s (`INSUFFICIENT_BALANCE` / `QUEST_POLLEN_ONLY`), and `filterEntriesByPermissions` hides paidOnly models from Quest-only accounts' catalogs. So every Quest-balance caller following the documented default path (`GET /3d/…?model=microsoft%2Ftrellis-2`) hits a hard 402 while the docs promise it works — and the model silently disappears from their `/models` list. `APIDOCS.md:1993` states the opposite semantics ("`paid_only` — True when the model needs the paid balance; the Quest balance can't pay for it"), so the platform contradicts itself.

The gap survived because **none of the docs validation tooling pins prose to enforcement**: `scripts/validate-apidocs.ts` checks anchors/curl bodies, `scripts/validate-request-examples.ts` Ajv-validates examples, `test/docs.test.ts` tests docs *serving* — none compare a documented guarantee to the code that should enforce it.

## Fix

- The note now names **all** paidOnly models (adding `tripo3d/p2`, previously undocumented) and states the Quest balance cannot pay for 3D generation; `APIDOCS.md` mirrors it (byte-identical to the post-deploy regeneration the docs workflow runs — local regeneration pulls the live schema URL, so the file is patched directly)
- **The repo's first docs↔enforcement parity gate**: `test/docs-parity-3d.test.ts` — no model the docs claim is Quest-eligible may be `paidOnly`; every `paidOnly` model must be named in the paid-balance note; the billing gate refuses Quest-only balances for the default model

## Safe reproduction (isolated, red on unpatched main)

The parity tests import the markdown through the same `?raw` loading path the docs route uses and compare it to `MODEL3D_SERVICES` + `canCoverEstimatedCharge`: **2 tests fail on unpatched main** (trellis-2 claimed Quest-eligible while `paidOnly: true`; the note missing the paidOnly models), all green with the doc fix; the third test is a green control pinning the billing-gate semantics.

## Verification

- New suite 3/3 on the branch (2 red on main, above)
- `test/docs.test.ts` 26/26 unchanged; `tsc --noEmit` clean
- The registry flag itself is intentional — the fix corrects the doc, not the flag
- No live probes; $0 spend

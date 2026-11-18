# Issue 61 — An interrupted coordinator alarm strands the caller's key-budget reservation forever (no row, no TTL, no sweeper) — DO-alarm state-machine bug

- **Severity:** High (caller-funded money stranding; repeatable by any DO interruption mid-generation: deploy, eviction, isolate OOM — likelier while the issue-56 parse-OOM class is live)
- **Affected:** `gen.pollinations.ai/src/durable-objects/GenerationCoordinator.ts:217-237` (alarm marks `started: true` before executing; fail-closed branch never re-executes), `shared/billing/deduction.ts:116-133` (`atomicReserveApiKeyBalance` — a real `UPDATE apikey SET pollen_balance = pollen_balance - amount` with **no reservation row, expiry, or sweeper**) — upstream `pollinations/pollinations` main @ `52fd0a6c824`
- **Fix branch:** `solution57-coordinator-stranded-reservation-release` — **PR:** [#74](https://github.com/NamanSoni78/pollinationsai/pull/74)

## Root cause

The detached-generation lifecycle for every non-stream request (`deduplicateGeneration` → coordinator DO → alarm):

1. `alarm()` persists `started: true` **before** executing (`GenerationCoordinator.ts:217-219`).
2. `executeGeneration` runs the executor chain inline; `apiKeyBudgetReservation` reserves key budget with `atomicReserveApiKeyBalance` — a **real D1 deduction** (no ledger row, no TTL).
3. If the isolate dies during execution (deploy, eviction, OOM), the re-delivered alarm fail-closes: `stored.started → finish(unavailable("Detached generation was interrupted"))` (`:232-237`) — the executor is never re-run, and **nothing ever reconciles or releases the reservation**: no sweeper exists (`runScheduled` only refreshes catalogs/keeps sandboxes), settlement only runs if that same alarm invocation survives (`:258-260`).
4. The caller gets a 503, no billing row ever emits, and the key budget stays minus the estimate **forever** — the caller paid for nothing and cannot recover the funds.

## Safe reproduction (isolated DO-level test, the `runInDurableObject` interruption pattern)

`gen.pollinations.ai/test/generation-coordinator.test.ts` (new tests, mirroring the existing "does not execute a generation again after an alarm interruption" harness):

1. **RED on unpatched HEAD:** a real D1 apikey (`createTestApiKey({pollenBudget: 5})`) with a committed reservation (`atomicReserveApiKeyBalance(db, apiKeyId, 1.25)` → balance 3.75) + the job marked `started` + the ledger record present; the re-delivered alarm fail-closes → `expected 3.75 to be 5` — the 1.25 stays deducted forever.
2. **Control:** an interrupted alarm with **no** reservation record credits nothing (a blind release would mint funds).

## Fix (`solution57-coordinator-stranded-reservation-release`)

A `GenerationReservationLedger` threaded from the coordinator's alarm into the detached executor (`execute-generation.ts`, `generation-access.ts`, `track.ts`, `balance.ts`):

- `reserveApiKeyBudget` **records** `{apiKeyId, amount}` in DO storage right after the D1 reserve commits (the record exists ⟺ the reservation is outstanding);
- every consumer of the reservation clears the record: the executor-error release (`releaseApiKeyBudgetReservation`) and the settlement reconcile (`track.ts` after `handleBalanceDeduction`);
- the fail-closed alarm branch releases whatever record is still outstanding — **delete-first, then adjust back**, so a repeat interruption during the release can never double-credit; a failed adjust degrades to the old stranding, never to minting.

Post-fix the committed-but-unsettled reservation releases back to 5 pollen. Regression suites: coordinator 28 asserts / dedup 16 / billing-deduction 24 / tracking-observability 120 — **165/165 green**, `tsc` clean.

**Known residual (documented):** the `GENERATION_EXECUTION_ORIGIN` handoff path executes in a stateless isolate — no ledger is threaded there, so origin-leg interruptions keep the current behavior; the residual window on the local path shrinks from the whole generation (seconds-minutes) to the microseconds between the reserve commit and the record write.

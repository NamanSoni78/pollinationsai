# Issue 63 — A cache-write failure after a fully-billed generation settles the charge, then fails the request with a 503 and no refund — verified finding, fix requires a product decision (no code branch this round)

- **Severity:** Medium-High (caller pays full price and receives a 503; repeatable by any transient R2 put failure during a detached generation)
- **Affected:** `gen.pollinations.ai/src/utils/execute-generation.ts:148-158` (success leg `await cacheWrite` → catch `await settlement` → rethrow), `gen.pollinations.ai/src/durable-objects/GenerationCoordinator.ts:252-257` (alarm catch → `finish(unavailable("Detached generation failed"))`) — upstream `pollinations/pollinations` main @ `52fd0a6c824`
- **Fix branch:** none this round (design decision between two directions, below) — filed as a verified finding with the repro; the same convention as round 3's R3-D1 (refund-clawback design gap), which was later graduated to issue 23.

## Root cause (traced)

The detached-execution success leg:

```ts
if (!cacheWrite) { throw new Error("Generation completed without a cacheable result"); }
await cacheWrite;                       // ← an R2 put rejection lands here
return { result: { status: "generated" }, settlement };
} catch (error) {
await settlement;                        // ← completes the charge first
throw error;                             // ← then fails the job
}
```

The generation itself succeeded (provider paid, 200 streamed through track's billing — the charge launches on response completion), but a cache-write failure (transient R2 error, 5xx) then: (1) awaits the settlement to completion — the user's balance/key settle the **full price**; (2) rethrows → the DO alarm catch converts it to `finish(unavailable("Detached generation failed"))` → the dedup middleware replays the 503 to the original submitter and all joiners. The caller paid and received an error; there is no refund path. The generation event row records 200/MISS/billed while the caller receives 503 (the same audit found the asymmetric record-vs-delivery shape).

**Why no code branch this round:** the two correct minimal fixes are mutually exclusive and product-shaped:

1. **Refund-on-delivery-failure:** on the cacheWrite-failure path, reverse the settlement (a post-hoc reconcile of user balance + key + rewards) — needs a new refund/reconcile code path (money-moving; must be idempotent and capped).
2. **Serve-despite-failure:** treat the cache write as best-effort (log, return `generated`) — but the non-stream delivery architecture serves the submitter from the cache entry (`generation-deduplication.ts` reads `cache.adapter.get`), so with no entry the submitter still 503s (`"Generation completed without a durable cache entry"`) — a delivery-architecture change, not a two-line patch.

Both are reviewable decisions; the deterministic repro below pins the behavior for whichever is chosen.

## Safe reproduction (isolated)

The `withInlineGenerationCoordinator` harness (`test/helpers/inline-generation-coordinator.ts`, used by `test/tracking-observability.test.ts:577`): submit a generation whose `env.MEDIA.put` (or `TEXT_BUCKET.put`) is mocked to reject — mock style of `test/media-cache.test.ts` / `test/openai-image-cache.test.ts`. Assert: the response is 503 `Detached generation failed` **and** the D1 user balance / apikey pollen balance is adjusted by the full price (billed).

## Recommended fix directions (for the follow-up)

Direction 1 preserves the "completed work is never free" doctrine literally; direction 2 makes the cache genuinely best-effort (the caller already got their bytes streamed in the stream case; only non-stream delivery depends on the entry). Either way the settlement-vs-failure ordering (`await settlement` before rethrow) is the pivot to change.

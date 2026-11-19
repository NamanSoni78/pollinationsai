# Issue 132 — `mistralai/mistral-large-4` bills vision input at $0: the one fleet member missed by the issue-46/49/52 sweeps

- **Severity:** High (same mechanism as issues 46/49/52 — a `paidOnly` flagship model's advertised image input settles at $0 on both serving routes; live class proven by the issue-45 report, mechanism unit-proven by the PR-#61 red test; this instance reproduced red/green offline, live probes $0)
- **Affected:** `shared/registry/text.ts:3878-3901` (`mistralai/mistral-large-4` sheet: `inputModalities: ["text","image"]`, `paidOnly: true`, `priceMultiplier: 1`, cost = `promptTextTokens 0.7 / promptCachedTokens 0.07 / completionTextTokens 2.1` per M — **no `promptImageTokens` line**) and `shared/registry/text-fallbacks.ts:671-678` (`mistralai/mistral-large-4:vercel` — no cost override, inherits the gap). Line numbers are on upstream `main` @ `4f3585e97` (the 2026-11-19 description rewrite shifted the registry; F-06's old citations are stale by offset).
- **Fix branch:** `solution132-mistral-large4-vision-rate` (off `upstream/main` `4f3585e97`) — fork PR [#148](https://github.com/NamanSoni78/pollinationsai/pull/148) (first opened as #147 from the `solution131-*` branch name, renumbered after the concurrent session claimed issue 131 — see the WORKLOG round-44 renumber note)
- **Dedup:** the mechanism is issue 46's (fleet sweep, 17 routes), extended by issues 49-mistral/49-vercel and issue 52 (22+ residual routes); the open superset fix PR [#61](https://github.com/NamanSoni78/pollinationsai/pull/61) (`solution46-vision-input-rate-sheet-gaps`) adds 19 `promptImageTokens` lines — verified by files-patch inspection to **not** touch `mistral-large-4`. This model appears in the issue registry only in SSE-parse contexts (issues 59/12), never for its rate sheet. Registered as the missed member, same standard as issue 122 for the cache-write line.

## Root cause

`convertUsage` (`shared/registry/registry.ts:268-292`) bills any reported usage line that has no rate at **$0** (warn-only: `[registry] Missing conversion rate … billing 0 for this line`), and `openaiUsageToUsage` (`gen.pollinations.ai/src/text/usage-headers.ts`) carves split-reported image tokens out of `promptTextTokens` onto their own line. `mistralai/mistral-large-4` was added 2026-10-06 (`e5065cede`) multimodal from day one; its sheet's comment shows the text rates were re-verified against Mistral's pricing page on 2026-11-11, but the image line was never added. The sibling `mistral-small-4` — same `provider: "mistral"`, same `createMistralModelConfig` + `useMistralChatFormat` client path — prices `promptImageTokens` at its text rate (verified 2026-09-20), which is the registry's own evidence that Mistral reports the split. The `:vercel` fallback (Vercel AI Gateway — the split-reporting surface live-proven by issue 45) inherits the sheet verbatim.

**Impact:** every image-bearing request on either route bills its image tokens at $0 while the platform pays the provider. The model accepts up to 8 reference images (registry default, `imageUrlToBase64Transform.ts:11`); the test's 2000-token image payload alone is **$0.0014/request** of forgone revenue at the sibling-convention rate, repeatable at the model's per-user RPM on a `paidOnly` route.

## Safe repro (deterministic offline; live probes $0)

`npx vitest run test/text/mistral-large4-vision-rate.test.ts` on unpatched `4f3585e97` — 4 RED / 1 control-green:

```
FAIL mistralai/mistral-large-4 declares image input and prices it
     expected undefined to be defined            (cost.promptImageTokens)
FAIL mistralai/mistral-large-4:vercel declares image input and prices it
FAIL mistralai/mistral-large-4 bills split-reported image tokens at its text rate
     expected +0 to be close to 0.0014           (2000 image tokens × $0.7/M)
FAIL mistralai/mistral-large-4:vercel bills split-reported image tokens at its text rate
[registry] Missing conversion rate: model=mistralai/mistral-large-4 usageType=promptImageTokens amount=2000 — billing 0 for this line
PASS mistral-small-4 (same provider) keeps image = text rate   (control)
```

## Fix

One line — `promptImageTokens: perMillion(0.7)` (image = the text rate, the convention of every priced vision sibling on this provider) on the `mistral-large-4` sheet; the `:vercel` route inherits it. Effective-prices snapshot regenerated (2 rows: `mistral-large-4`, `mistral-large-4:vercel`, cost+price). No worker code changes.

## Tests

- **RED on unpatched main:** 4 failed / 1 passed.
- **GREEN with fix:** 5/5; `tsc --noEmit` (gen) clean; `model-registry` + `byop-markup` 55/55; full `gen.pollinations.ai/test/text/` suite **1001/1001**; `enter` effective-prices snapshot green after the 2-row update.

## Notes for maintainers

- Complementary to PR #61 (the 19-route superset): different model, different test file (`mistral-large4-vision-rate.test.ts` vs `vision-input-rate-sheet.test.ts`), no file-hunk overlap — both can merge independently.
- The round-44 recount (below) still finds **41 split-reporting routes** without image rates at `4f3585e97` — 18 enumerated in F-06 + the issue-52 residuals + the issue-46 follow-up set; this model was in none of them, which is exactly why the registry needs the priced-sibling ⇒ priced-line invariant test that PR #61's file builds.
- **Renumber note:** first registered as `issue131` in parallel with the concurrent cron-202611200024 session's Stability post-invoke settlement finding (`issue131-stability-image-post-invoke-settlement.md`, PR #146), which reached `issues_mds` first; renumbered 131 → 132 with the branch/PR re-pointed (see WORKLOG round 44). The two findings are file-disjoint.

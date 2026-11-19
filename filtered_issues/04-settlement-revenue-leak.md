# F-04 — Settlement never trusts the provider's receipt: a fleet-wide revenue leak where the platform pays and the caller settles $0 (High)

**Consolidates:** issues [#2](../issues/issue2-xai-video-post-render-unbilled.md) (xAI video post-render unbilled), [#3](../issues/issue3-assemblyai-timeout-unbilled-no-size-cap.md) (AssemblyAI timeout unbilled), [#25](../issues/issue25-fal-queue-post-paid-failures-unbilled.md) (fal-queue failures unbilled), [#53](../issues/issue53-grok-video-provider-cost-receipt.md) (grok video receipt discarded), [#60](../issues/issue60-responses-chat-usage-detail-drop.md) (chat adapter drops video/image usage lines), [#66](../issues/issue66-realtime-disconnect-inflight-response-unbilled.md) (realtime disconnect unbilled), [#72](../issues/issue72-postpaid-failure-settlement-class-sweep.md) (11-client image/video sweep), [#81](../issues/issue81-postpaid-settlement-model3d-fal-residuals.md) (model3d + fal-fallback residuals), [#82](../issues/issue82-postpaid-settlement-media-client-sweep.md) (xAI-image/DashScope/kling/minimax/sonilo/lyria), [#88](../issues/issue88-vercel-search-step1-cost-loss.md) (Vercel two-step search), [#90](../issues/issue90-route-postpaid-parse-settlement.md) (route-level parse/delivery), [#91](../issues/issue91-usage-guard-settlement-sweep.md) (usage-guard sweep), [#92](../issues/issue92-text-error-funnel-billedusage-drop.md) (text error funnel drops `billedUsage`), [#95](../issues/issue95-fallback-paid-leg-settlement.md) (fallback drops the paid leg), [#96](../issues/issue96-replicate-fleet-postpaid-settlement.md) (Replicate fleet), [#99](../issues/issue99-inferenceport-download-decode-settlement.md) (InferencePort download/decode), [#104](../issues/issue104-mai-output-leg-schedule-settle.md) (MAI output leg), [#113](../issues/issue113-openrouter-image-receipt-settlement.md) (OpenRouter image receipts), [#120](../issues/issue120-transcription-postpaid-settlement-and-deadlines.md) (transcription backends), [#123](../issues/issue123-tts-inline-json-caps.md) (TTS inline JSON), [#124](../issues/issue124-transcription-settlement-completion.md) (remaining transcription backends), [#126](../issues/issue126-vercelsearch-stream-frame-crash.md) (vercelsearch stream crash + $0 settle — stream-handling half in F-12), [#130](../issues/issue130-sonilo-result-parse-crash.md) (sonilo parse crash) — **23 issues, one root cause:**

> `middleware/track.ts` settles a failed (or rescued, or torn) request **only** from `error.billedUsage` — and dozens of throw sites across the fleet omit it *after the provider already billed the platform*. Success paths discard the provider's receipt (`providerBilling`) and re-price from the sheet. Two funnels (the text error funnel, the fallback attempts loop) drop `billedUsage` even when the thrower attached it.

**Status on upstream `main` @ `4e662050`:** the `track.ts` billedUsage-only settlement and the dropping funnels are unchanged (re-verified by code inspection 2026-11-19). PRs #2–#6 that fixed the first five instances were merged into fork/main on 2026-11-17 (fork/main has since been re-synced to upstream; review the PR diffs).

**Fix PRs:** [#34](https://github.com/NamanSoni78/pollinationsai/pull/34), [#73](https://github.com/NamanSoni78/pollinationsai/pull/73), [#89](https://github.com/NamanSoni78/pollinationsai/pull/89), [#91](https://github.com/NamanSoni78/pollinationsai/pull/91), [#100](https://github.com/NamanSoni78/pollinationsai/pull/100), [#102](https://github.com/NamanSoni78/pollinationsai/pull/102), [#105](https://github.com/NamanSoni78/pollinationsai/pull/105), [#107](https://github.com/NamanSoni78/pollinationsai/pull/107), [#108](https://github.com/NamanSoni78/pollinationsai/pull/108), [#109](https://github.com/NamanSoni78/pollinationsai/pull/109), [#113](https://github.com/NamanSoni78/pollinationsai/pull/113), [#118](https://github.com/NamanSoni78/pollinationsai/pull/118), [#128](https://github.com/NamanSoni78/pollinationsai/pull/128), [#135](https://github.com/NamanSoni78/pollinationsai/pull/135), [#138](https://github.com/NamanSoni78/pollinationsai/pull/138), [#139](https://github.com/NamanSoni78/pollinationsai/pull/139), [#141](https://github.com/NamanSoni78/pollinationsai/pull/141), [#145](https://github.com/NamanSoni78/pollinationsai/pull/145), [#62](https://github.com/NamanSoni78/pollinationsai/pull/62), [#78](https://github.com/NamanSoni78/pollinationsai/pull/78), [#84](https://github.com/NamanSoni78/pollinationsai/pull/84), plus fork-merged [#2](https://github.com/NamanSoni78/pollinationsai/pull/2), [#3](https://github.com/NamanSoni78/pollinationsai/pull/3).

---

## What this chain can do, end to end

Every generation that fails *after* the provider's paid event — or is rescued by a fallback, or torn mid-stream, or disconnected by the client — settles **$0 to the caller** while the provider bills the platform. That is a 100% revenue loss per affected request, repeatable, and in several legs attacker-amplifiable (long renders, forced disconnects, deliberate failure induction):

- **Every fallback-enabled text route** drops the rescued primary's paid leg: a rescued `openai/gpt-5.5` leg costs the platform ≈ **$1.10/request** typical, ≈ **$20** prompt-bound worst case (issue 95; trigger is the production-observed empty-completion anomaly class).
- **15 fal-queue/veo/krea/flux-max/grok-replicate sites + 17 model3d/fal-fallback sites + 14 xAI/DashScope/kling/minimax/sonilo/lyria sites + 18 Replicate-fleet sites** throw `billedUsage: undefined` after the paid event — proven red on unpatched main, per site (issues 72/81/82/96).
- **~19 usage guards** fire *after* the render is in hand, discarding every readable receipt leg ($0.007–$2.80/request; issue 91) — the MAI guard even drops the dominant output leg ($34/M) exactly when it is unreadable (issue 104).
- **Realtime disconnects bill $0 for delivered audio** — live-proven control-vs-exploit (issue 66). Organic leakage too: every tab closed mid-reply.
- **Two-step Vercel search** discards the paid search step whenever formatting fails (issue 88); its streaming twin crashes the SSE pipeline on a keep-alive frame and settles **both** paid generations $0 (issue 126).
- **Success paths re-price from the sheet and discard the provider's receipt**: grok video (up to $1.74/request under-billed, issue 53), OpenRouter image 4K tiers (issue 113).
- **The text error funnel (`throwTextError`) strips `billedUsage` from every text-pipeline paid failure** (issue 92) — silently neutralizing the fixes of 88/95 wherever they route through it. **Without PR #108, several other fixes in this family do not function end-to-end.**

## Proof (strongest evidence)

**Live, production, own key (issue 66 — realtime disconnect, 2026-11-18):**

```
CONTROL  (socket held open):   balance delta = −0.00325500   (billed)
EXPLOIT  (close after first audio delta): balance delta = +0.00000000   (audio delivered, input tokens consumed, $0)
```

**Unit red/green sweeps on unpatched main (each = N sites proven `billedUsage: undefined`):**

| Sweep | Red tests | Example trigger → leaked provider cost |
|---|---|---|
| issue 72 (fal-queue fleet) | 15/15 | wan-3.0 1080p poll 504 after render ≈ **$2.80/req** |
| issue 81 (model3d + fal-fallback) | 17/17 | fal `COMPLETED` then download failure |
| issue 82 (media clients) | 14/14 | DashScope `SUCCEEDED` + usage read, then download 500 |
| issue 96 (Replicate fleet) | 14/14 | prediction `succeeded`, then guard/download throws |
| issue 91 (usage guards) | 9/9 | OpenRouter Recraft SVG delivered, then media-type guard 502 |
| issue 90 (route layer) | 3/3 | ElevenLabs 200 non-zip → bare 502, decoded inputSeconds discarded |
| issue 120/124 (transcription) | 8+6 | Azure/xAI/Scribe/Vertex/OR-STT/whisper 200-OK schema failure |
| issue 95 (fallback loop) | 2 variants | rescued gpt-5.5 leg `isBilledUsage: false`, balance moves only by the fallback's price |
| issue 92 (funnel) | route harness | handler throws paid ServiceError with billedUsage → row `isBilledUsage: false` on main |

**Issue 25 (the original, unit PoC, exit-1 on unpatched):** five fal-queue sites — MiniMax H3 poll 504, MiniMax/Kling `COMPLETED`-without-URL (`x-fal-billable-units: 6.2` visible, unbilled), grok:fal missing duration, Sonilo missing audio — control (identical flow with output) bills normally.

**Honest labels:** issues 2 and 3 were code-path analysis at filing (transpile-only verification); the same mechanism in the same files was later unit-proven red by issues 72/81/82 — the family evidence subsumes them. Their fixes were merged on the fork on 2026-11-17.

## The chain

```
provider bills the platform (render done / job SUCCEEDED / receipt in hand)
        │
        ▼
platform throws / is rescued / is torn / client disconnects
        │
        ├── throw site omits billedUsage      (72/81/82/90/91/96/99/104/120/123/124/130 — fleet)
        ├── funnel strips it                  (92 — text error funnel)
        ├── fallback loop drops rescued legs  (95 — every fallback-enabled text route)
        ├── stream parse crash                (126/59 — tee'd tracking branch throws in waitUntil)
        ├── client-abort receipt loss         (66 — realtime, LIVE-proven)
        └── success path discards receipt     (53/113 — re-priced from sheet)
        │
        ▼
caller settles $0 — platform pays 100% of the affected request
```

## Members & fixes

| Issue | Surface | Red tests | Fork PR |
|---|---|---|---|
| 25 | fal-queue wrappers (original 5 sites) | 5 PoCs + 7 tests | [#34](https://github.com/NamanSoni78/pollinationsai/pull/34) |
| 72 | fal-queue fleet (11 clients, 15 sites) | 15/15 | [#84](https://github.com/NamanSoni78/pollinationsai/pull/84) |
| 81 | model3d + fal-fallback residuals | 17/17 | [#89](https://github.com/NamanSoni78/pollinationsai/pull/89) |
| 82 | xAI-image/DashScope/kling/minimax/sonilo/lyria | 14/14 | [#91](https://github.com/NamanSoni78/pollinationsai/pull/91) |
| 96 | Replicate fleet (12 model files) | 14/14 (+4 controls) | [#109](https://github.com/NamanSoni78/pollinationsai/pull/109) |
| 91 | usage guards (~19 guards, 10 files) | 9/9 | [#107](https://github.com/NamanSoni78/pollinationsai/pull/107) |
| 104 | MAI output leg (stacked on 91) | 3/3 | [#118](https://github.com/NamanSoni78/pollinationsai/pull/118) |
| 99 | InferencePort download + b64 decode | 3/3 | [#113](https://github.com/NamanSoni78/pollinationsai/pull/113) |
| 90 | route layer (stem-sep archive, image empty-buffer, responses schema) | 3/3 | [#102](https://github.com/NamanSoni78/pollinationsai/pull/102) |
| 88 | Vercel two-step search (paid step 1 discarded) | 7/7 | [#100](https://github.com/NamanSoni78/pollinationsai/pull/100) |
| 92 | text error funnel drops `billedUsage` (**propagation keystone**) | route+unit | [#108](https://github.com/NamanSoni78/pollinationsai/pull/108) |
| 95 | fallback attempts loop drops rescued paid legs | 2 variants | [#105](https://github.com/NamanSoni78/pollinationsai/pull/105) |
| 66 | realtime client-disconnect receipt loss | **Live** + 3 tests | [#78](https://github.com/NamanSoni78/pollinationsai/pull/78) |
| 60 | Chat-over-Responses adapter drops `promptVideoTokens`/`completionImageTokens` — same usage bills $0 via `/v1/chat/completions`, full rate via `/v1/responses` | Unit red/green (`it.each` stream+non-stream) | [#73](https://github.com/NamanSoni78/pollinationsai/pull/73) |
| 53 | grok video success-path receipt discarded (≤$1.74/req) | unit | [#62](https://github.com/NamanSoni78/pollinationsai/pull/62) |
| 113 | OpenRouter image receipts (4K tier flat-rate drift) | 13/13 | [#128](https://github.com/NamanSoni78/pollinationsai/pull/128) |
| 120 | transcription backends (Azure GPT/xAI/Scribe/MAI) + deadlines | 8/8 | [#135](https://github.com/NamanSoni78/pollinationsai/pull/135) |
| 124 | remaining transcription backends (Vertex/OR-STT/whisper) | 6/6 | [#139](https://github.com/NamanSoni78/pollinationsai/pull/139) |
| 123 | TTS inline JSON legs (MAI/Gemini/Lyria) | 11/12 | [#138](https://github.com/NamanSoni78/pollinationsai/pull/138) |
| 130 | sonilo SFX result-parse crash | 1/1 | [#145](https://github.com/NamanSoni78/pollinationsai/pull/145) |
| 126 | vercelsearch stream crash (both paid generations settle $0) | 3+3 | [#141](https://github.com/NamanSoni78/pollinationsai/pull/141) |
| 2 | xAI direct video post-render moderation (merged on fork 11-17) | code-path (subsumed by 72's class proof) | [#2](https://github.com/NamanSoni78/pollinationsai/pull/2) |
| 3 | AssemblyAI timeout unbilled (merged on fork 11-17) | code-path (subsumed) | [#3](https://github.com/NamanSoni78/pollinationsai/pull/3) |

## Merge guidance

1. **PR #108 first** (the funnel) — without it, #100's and #105's attached `billedUsage` is stripped at the route boundary. Zero file overlap with the client sweeps.
2. **Then the client/route sweeps in any order** — 84, 89, 91, 96, 99, 102, 105, 107, 109, 113, 118, 128, 135, 138, 139, 141, 145, 62, 78 are deliberately line-disjoint (each PR verified non-overlap against the others; #118 stacks on #107; #112 and #124-withdrawals document the dedup discipline).
3. **Structural option for maintainers:** rather than 19 merge decisions, consider one convention change — settle failures from any readable receipt leg (the `UpstreamError` + `billedUsage` convention the family already uses), plus fail-closed on success-path receipts (53/113 shape). The per-site PRs already implement exactly that per file.
4. Related family: PR #66 (issue 66) also adds the disconnect grace-deadline settlement — the only live-proven member; worth prioritizing for that reason.

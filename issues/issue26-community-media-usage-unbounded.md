# Issue 26 — Community publishers bill callers on unbounded self-reported usage in every non-text modality (video seconds, audio seconds, image tokens, embeddings tokens), earning 75% of the claim

- **Severity:** High (direct caller overcharge in a single request; publisher self-enrichment at 75% of the charge)
- **Affected:** `gen.pollinations.ai/src/middleware/track.ts` (`isImplausibleProxyUsage`) plus the media/embedding consumption sites — upstream `pollinations/pollinations` main @ `30ae4da`
- **Fix branch:** `solution22-community-media-usage-clamp` — **PR:** [#30](https://github.com/NamanSoni78/pollinationsai/pull/30)

## Root cause

The implausible-usage clamp shipped in #18516 (`a3c166d43a`) gates only text events, and its commit message states the gap outright: *"Agents, embeddings and media proxies are not covered."*

```ts
// gen.pollinations.ai/src/middleware/track.ts (pre-fix)
function isImplausibleProxyUsage(
    eventType: EventType,
    candidate: FallbackCandidate,
    usage: Usage,
): boolean {
    if (
        eventType !== "generate.text" ||                    // ← ONLY text
        candidate.communityEndpoint?.type !== "proxy"
    ) {
        return false;
    }
```

Every non-text community modality bills meters the **publisher's endpoint reports itself**, with no upper bound anywhere on the path:

| Modality | Self-reported meter | Consumption site |
|---|---|---|
| video (`generate.image`) | `usage.duration` — `z.number().positive().nullish()`, any finite positive value | `shared/community-media.ts:14-34` (`communityVideoSeconds`) → `gen.pollinations.ai/src/image/communityEndpoint.ts:134,149` (`completionVideoSeconds`) |
| transcription (`generate.audio`) | `usage.duration` / `usage.seconds` / top-level `duration` — any finite positive value | `shared/community-endpoints.ts:1131-1144` (`communityTranscriptionSeconds`) → `createAudioSecondsUsage` |
| speech (`generate.audio`) | seconds/characters from the endpoint response | `gen.pollinations.ai/src/audio/communityEndpoint.ts` |
| image, `tokens` pricing (`generate.image`) | OpenAI image `usage` token counts — any positive safe integer | `gen.pollinations.ai/src/image/communityEndpoint.ts:194-216` (`communityImageUsage`) |
| embeddings (`generate.embedding`) | `usage.prompt_tokens` — only `> 0` checked | `gen.pollinations.ai/src/embeddings/communityEndpoint.ts:117-133` |

Because the clamp returns `false` for every non-text event, a claim of any size flows straight into `calculateUsageBilling` and is charged to the caller. The owner's developer credit (`resolveCommunityModelReward`, `shared/billing/track-helpers.ts:142-149`) is computed from the same billing value at 75% — so an inflated claim simultaneously overcharges the caller and pays the publisher.

**Attack scenario:** an allowlisted publisher registers a public video model at the per-second price ceiling (`MAX_COMMUNITY_PRICE_PER_VIDEO_SECOND`, $0.5/s). The endpoint returns a real 1-second clip plus `{"usage":{"duration": 3600000}}`. The caller's preflight estimate for a new listing is a Tinybird average (≈ 0), so nothing warns; the caller is post-hoc charged 3,600,000 × $0.5 = **$1.8M pollen in one request**, and the owner is credited 75% of whatever the payer's balance covered. The payer's charge stands even if it drives the balance negative (the negative-balance floor is a separately documented design gap).

## Safe reproduction (isolated unit tests, no network)

In `gen.pollinations.ai/test/tracking-observability.test.ts`, drive `trackResponse` with a community-proxy candidate and usage headers on a media response (the content-type guard requires `video/mp4` for `generate.image`):

1. `generate.image` + `x-usage-completion-video-seconds: 601` → on unpatched main this is **billed** (clamp never fires); with the fix it returns `502 usage_invalid`, `isBilledUsage: false`, no price.
2. `generate.audio` + `x-usage-prompt-audio-seconds: 36001` → same transition.
3. `generate.image` + `x-usage-completion-image-tokens: 1000001` → same transition.
4. `generate.embedding` + `x-usage-prompt-text-tokens: 2000001` → on unpatched main this was pinned as *"still bills a proxy's embeddings"* by the existing test; with the fix it is rejected.
5. The earnings side needs no separate patch: an unbilled claim produces no `communityModelReward` (reward flows from the billing value).

## Fix (`solution22-community-media-usage-clamp`)

`isImplausibleProxyUsage` now applies to every community-proxy event type with modality ceilings, keeping the text branch byte-for-byte:

- video seconds (prompt + completion) ≤ **600** (the shared video schema caps a requested clip at 120 s; flux-3-max 20 s, mirelo/sfx 120 s of source — 5× headroom)
- audio seconds ≤ **36,000** (uploads are capped at 50 MB ≈ 7 h of the lowest-bitrate speech — headroom above the legitimate maximum)
- image tokens ≤ **1,000,000** (official image models price orders of magnitude below this per call)
- prompt tokens ≤ 2,000,000 now bind embeddings (legitimate max ≈ 262K for a 32-input batch × 8K tokens)

The existing negative/non-finite per-count rejection already covers every field of every modality. A claim past its ceiling is recorded as `502 usage_invalid`: no debit for the caller, no reward for the owner — identical to the text contract.

## Verification

`npx vitest run test/tracking-observability.test.ts` — **132/132 passing**, including 14 new cases: each meter over and exactly at its ceiling (media-typed responses so the billing guard runs), the embeddings case moved from "still bills" to rejected, plus controls proving official video models (`google/veo-3.1-fast` at 1,000,000 s) and community agents are unaffected. `tsc --noEmit` clean.

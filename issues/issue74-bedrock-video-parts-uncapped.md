# Issue 74 — Bedrock `video_url` parts are counted nowhere: uncapped sequential fetch fan-out (and a 500-class crash) on the Nova 2 Lite transform

- **Severity:** Medium (availability + egress/request-forging amplification on a `paidOnly` model; provider-guaranteed 400 for the legitimate case)
- **Affected:** `gen.pollinations.ai/src/text/transforms/mediaToBedrock.ts` (the `amazon/nova-2-lite-v1` transform, reached from `/v1/chat/completions`), upstream `pollinations/pollinations` main @ `6989f4bb64` (2026-11-18)
- **Fix branch:** `solution66-bedrock-video-part-cap` — **PR:** [#86](https://github.com/NamanSoni78/pollinationsai/pull/86)
- **Relationships:** same unbounded-count/sequential-fetch family as issues 20 (per-fetch deadline, PR #24), 55, 56 and 67 (aggregate byte budgets) — but a distinct missing control: **the per-part count cap**. The text path's image inlining caps its parts (`maxImageUrls`, default 8); the Bedrock video path capped bytes (20 MiB shared) but never counted parts. The per-fetch deadline half is already PR #24's; this fix does not duplicate it.
- **Renumber note (2026-11-18):** filed as issue 74 after a concurrent session (round 19, session 18) claimed issues 71-73 while this session's branches were being pushed; branch `solution66-*` keeps its number per the established convention.

## Root cause

1. `textCapabilityError` (`text/fallbackCompatibility.ts:123`) counts only `["image_url", "input_image"]` parts against `maxReferenceImages` — **`video_url` parts are invisible to the capability check**.
2. `mediaToBedrock` fetched every `video_url` part sequentially with a 20 MiB shared byte budget but **no count cap** (`mediaToBedrock.ts` pre-fix loop). The request schema (`shared/schemas/openai.ts:344` messages array; content parts `.min(1)` with no max, plus the `z.object({ type: z.string() }).passthrough()` union arm) bounds neither.
3. AWS publishes **"Number of objects: 1"** for embedded video on both Nova generations (Nova 2 user guide, *Using multimodal models* — video, embedding data in the request; Nova v1: "a single video in the payload … 25 MB" base64-inclusive; S3 references 1 GB / 1 object) — so anything past the first video is a guaranteed provider 400 *after* the platform has already paid for the downloads.

Net effect on unpatched main: a caller with a funded key (`paidOnly` model, so `requireFunds` preflight applies) can submit N `video_url` parts pointing at a host they control — each part is one sequential outbound fetch from the platform (URL policy applies: public hosts only), each fetch unbounded in time until PR #24 merges, the count bounded only by the Workers subrequest ceiling (1,000/request) and the request body (32 MiB chat limit ⇒ hundreds of thousands of parts fit). A slow-loris source holds the request for hours; a fast source turns one request into up to ~999 attacker-directed outbound fetches. Failed generations are unbilled, so the attack costs nothing beyond the preflight balance.

Additionally (below gate on its own, fixed in the same function while rewriting the loop): the schema's passthrough union accepts five malformed `video_url` shapes — missing container, `null` container, string container, non-string `url`, non-string `mime_type` — and every one crashed the transform with a raw `TypeError` (HTTP 500) instead of a 400.

## Safe reproduction (isolated, no network)

`gen.pollinations.ai/test/text/transforms/mediaToBedrock.test.ts` (extend; the file already mocks `globalThis.fetch`):

- **Count cap:** two `video_url` parts → on unpatched main the transform resolves with **two fetches**; with the fix it rejects with 400 `"This model supports at most 1 video per request."` after exactly **one** fetch.
- **Payload cap:** a 19 MB single video (within the generic 20 MB per-image cap) → unpatched main accepts it (it would only fail at the provider, after the bytes were spent); the fix rejects it against the 18.75 MB raw / 25 MB base64-inclusive AWS inline-video payload cap.
- **Malformed shapes:** all five shapes → 400 instead of `TypeError`.

## Fix

`MAX_BEDROCK_VIDEOS = 1` enforced in the transform loop **before** the second part is fetched (the provider's own documented limit is the cap — the capability check stays untouched so pass-through video models are unaffected), `MAX_BEDROCK_VIDEO_BYTES = 18_750_000` raw bytes (25 MB base64-inclusive) threaded through `fetchUserImage`'s existing `maxBytes` option, and `typeof` guards on `url`/`mime_type` answer 400 for the malformed shapes. Fallback re-entry re-runs the transform per attempt, but with a count of 1 the worst case is one fetch per attempt (≤ 4 with a full model list), which retires the multiplier the audit recorded for this path.

## Verification

`npx vitest run test/text/transforms/mediaToBedrock.test.ts`: **16/16** (9 pre-existing + 7 new — red on unpatched main, green with the fix). Full transform suite **279/279**; `npx tsc --noEmit` clean. No live-probe spend: the model is `paidOnly` and the reproduction is fully isolated, so the bounty key was not used.

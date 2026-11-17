# Issue 2 — xAI direct video route: post-render moderation rejections are unbilled (deterministic free renders)

**Severity: High (financial)** — repeatable prompt-controlled free video renders at provider cost, on the highest-priced direct route
**Original tracker:** issue #91 in the 2026-10-23 report set

## Vulnerable code (`gen.pollinations.ai/src/image/models/xaiVideoModel.ts`, current HEAD b373afb)

```ts
const completed = await pollXaiVideo(submitted.request_id, apiKey);
const video = completed.video;
if (video?.respect_moderation === false) {
    throw UpstreamError.fromProvider(400, {              // ← no billedUsage
        message: "xAI filtered the generated video by moderation",
        errorCode: "content_policy_violation",
        ...
    });
}
```

The sequence is: submit → poll until `status === "done"` → **then** check `respect_moderation`. By the time this 400 is thrown, xAI has fully rendered the video and billed the platform for it. `track.ts` only charges failures whose error carries `billedUsage`:

```ts
// gen.pollinations.ai/src/middleware/track.ts
error instanceof UpstreamError ? error.billedUsage : undefined
```

So the caller pays nothing. The fal-routed sibling of the same model family already does this correctly (`image/models/falFallbackMediaModel.ts`):

```ts
if (config.billsRejectedVideos && isRejectedAfterGeneration(error)) {
    throw UpstreamError.fromProvider(422, {
        message: "... The video was rejected after it was generated, so this request was charged.",
        responseBody: error.responseBody,
        billedUsage: usage,                               // ← the pattern to copy
    });
}
```

## Impact

- `x-ai/grok-imagine-video*` is `paidOnly: true` at **0.07 pollen/second** (`shared/registry/image.ts:1766+`). A 15s 720p render is ~1.05 pollen of provider cost, delivered free, deterministically, via a prompt that trips moderation after generation (e.g. borderline content that renders then gets flagged).
- Repeatable per request — no special timing, no race; just prompt-controlled.
- The same missing-`billedUsage` pattern exists on the other post-render throw in this file (`video completed without a download URL`), and on the poll-timeout path (504 after renders may have completed server-side).

## Recommended fix (implemented in `solution2-xai-video-post-render-billing`)

Attach the same usage the success path reports to the post-render moderation throw — provider-reported `video.duration` when present, else the requested duration — mirroring `falFallbackMediaModel`. No behavior change for any non-rejected generation.

## Verification

- `bun build --no-bundle` transpile check passes.
- The `Usage` type (`shared/registry/registry.ts:76`) accepts `completionVideoSeconds` + `promptImageTokens`; the fal path proves the shape flows through `UpstreamError.billedUsage` → `track.ts` settlement.

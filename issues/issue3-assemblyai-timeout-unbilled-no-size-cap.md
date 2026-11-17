# Issue 3 — AssemblyAI transcription: 240s timeout abandons jobs unbilled & uncapped; transcriptions route has no upload size limit

**Severity: High (financial + DoS)** — free third-party spend on every timeout; the only audio upload route without a size cap
**Original tracker:** issue #52 in the 2026-10-23 report set

## Vulnerable code (current HEAD b373afb)

**1. Timeout = free transcription** — `gen.pollinations.ai/src/routes/assemblyai-transcription.ts`:

```ts
while (Date.now() < deadline) { ... poll ... }
throw new UpstreamError(504 as ContentfulStatusCode, {
    message: "AssemblyAI transcription timed out",       // ← no billedUsage, no cancel
});
```

When polling exceeds `ASSEMBLYAI_TRANSCRIPTION_TIMEOUT_MS` (240s), the request 504s with no `billedUsage` — but AssemblyAI keeps processing (and billing the platform) the job. Long files submitted with slow settings reliably exceed the window: the caller gets a 504, pays nothing, and the transcript still completes on the provider's side.

**2. No upload size cap** — `gen.pollinations.ai/src/routes/audio.ts` (`handleTranscription`, the `/v1/audio/transcriptions` route):

```ts
if (!(file instanceof File) || file.size === 0) {
    throw new UpstreamError(400 ...);
}
// ← nothing checks file.size here
```

The sibling routes already enforce 50 MB (`voice-changer` and `voice-isolator`, `audio.ts:722/788`):

```ts
if (audio.size > 50 * 1024 * 1024) {
    throw new UpstreamError(413 as ContentfulStatusCode, {
        message: "Voice Changer audio must be 50 MB or smaller.",
    });
}
```

## Impact

- Deterministic free provider spend per timed-out job (repeatable: file length × poll window arithmetic).
- Unbounded multipart uploads relayed to a third-party provider — bandwidth + provider cost amplification with a single valid key.
- Non-AssemblyAI transcription models on the same route share the missing cap.

## Recommended fix (implemented in `solution3-assemblyai-timeout-billing-and-size-cap`)

1. Attach `billedUsage` to the 504: estimate audio seconds from the upload size at a typical 128 kbps bitrate, bounded at an hour — the same usage shape the success path reports (`createAudioSecondsUsage`), so `track.ts` charges the abandoned job.
2. Enforce the sibling 50 MB cap in `handleTranscription`.

Both changes are additive guards; no success-path behavior changes.

## Verification

- `bun build --no-bundle` transpile passes for both files.
- `UpstreamError.billedUsage` → `track.ts` settlement is proven by the fal video path (issue 2, same mechanism).

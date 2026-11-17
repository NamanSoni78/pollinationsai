# Issue 20 — `fetchUserImage` bounds size but not time: a slow-loris image host pins generation slots (incl. detached coordinator alarms) for free until the platform proxy timeout

- **Severity:** Medium (resource-holding DoS, platform-bounded at ~125 s per slot; failed jobs are unbilled so the attack costs the attacker nothing)
- **Affected:** `gen.pollinations.ai/src/userImage.ts` (all image/video/vision input paths that download user-supplied URLs) — upstream `pollinations/pollinations` main @ `549feee`
- **Fix branch:** `solution20-user-image-fetch-timeout` — **PR:** [#24](https://github.com/NamanSoni78/pollinationsai/pull/24)

## Root cause

`fetchUserImage` guards the URL (`validateUserMediaUrl`) and caps the size (20 MB via `readResponseBytes`), but its `signal` is optional and supplied by **no main-path caller** — `src/userImage.ts:195-201`:

```ts
response = await fetch(url, {
    ...(redirect && { redirect }),
    headers: { "User-Agent": "Pollinations/1.0" },
    ...(signal && { signal }),
});
```

`downloadUserImage` (`src/image/utils/imageDownload.ts:115-121`) forwards only an equally-optional signal, and the model callers (`image/models/seedreamReplicateModel.ts:211`, `qwenImageModel.ts:81`, `falFallbackMediaModel.ts:261`, `veoVideoModel.ts:27`, `fluxKleinModel.ts:44`, …) and the text vision path (`text/transforms/imageUrlToBase64Transform.ts:37-40`) pass nothing — so nothing bounds time. `readResponseBytes` aborts on *size*, not on *time*.

A slow-loris image host (accept the connection, never respond or trickle bytes) therefore holds a generation slot — with `Prefer: respond-async`, a **detached `GenerationCoordinator` alarm** that the departed client can never cancel — until Cloudflare's default proxy read timeout (~125 s, the exact bound the coordinator's own `executeAtOrigin` comment acknowledges). Distinct-hash jobs at the per-key rate limit (600/10 s) multiply this. Failed jobs are not billed, so the attack is free.

This is an oversight, not a design choice, proven by the house pattern — the sibling user-media fetches on main all carry deadlines:

- `routes/audio.ts:233` — `REFERENCE_AUDIO_FETCH_TIMEOUT_MS = 30_000`;
- `image/handler.ts:67` — `EDIT_IMAGE_PROBE_TIMEOUT_MS = 10_000`;
- `image/communityEndpoint.ts:177` — `AbortSignal.timeout(COMMUNITY_ENDPOINT_TIMEOUT_MS)`.

(Distinct root cause from issue 4, the community *text-proxy* fetches: different fetch sites, different fix.)

## Safe reproduction (isolated, no network)

Extend `gen.pollinations.ai/test/image/imageDownload.test.ts` (already mocks `globalThis.fetch`): a mocked response whose body never enqueues but *honours the abort signal* — on unpatched main `fetch` receives `init.signal === undefined`, so the read hangs forever.

## Fix (`solution20-user-image-fetch-timeout`)

`fetchUserImage` gains `USER_IMAGE_FETCH_TIMEOUT_MS = 30_000`, applied as `AbortSignal.timeout(timeoutMs)` combined with any caller signal via `AbortSignal.any([...])`, covering every caller at once. Deadline aborts map to a distinct `failed_to_download_image` message ("Timed out downloading media from …"), separate from ordinary transport failures; a caller-initiated abort keeps the existing behaviour. `timeoutMs` is injectable for tests.

## Verification

`npx vitest run test/image/imageDownload.test.ts`: **40/40** (37 existing + 3 new — the fetch is always wired with an abort signal; a stalled never-finishing host rejects with the timeout message; the default deadline is pinned at 30 s). `npm run typecheck` (`tsc --noEmit`) clean.

# Issue 86 — fal queue client polls FAILED (and any unknown-status) jobs forever: no terminal failure state, no deadline, no per-fetch timeout

- **Severity:** High (availability + DO duration cost; shared by the 3D, image-fallback, and audio fleets)
- **Affected:** `gen.pollinations.ai/src/model3d/models/falClient.ts:81-94` (poll loop), `:36-38` (status union), `:115-133` (`falFetch`, no signal) — upstream `pollinations/pollinations` main @ `282ac54aeb` (2026-11-18)
- **Fix branch:** `solution87-falqueue-failed-terminal-status` — fork PR [#98](https://github.com/NamanSoni78/pollinationsai/pull/98)
- **Dedup:** distinct root cause from issues 25/72/81/82 (settlement — those fix *what the caller is charged* after a provider's paid event; this fixes *the wait never ending*). The concurrent `solution75`/`solution86` settlement branches were diff-verified to leave the poll loop and `falFetch` untouched. Not covered by any prior issue.

## Root cause

`runFalJobResponse`'s loop exits only on `COMPLETED`. The `FalQueueStatusResponse` union had no `FAILED` member, so a job whose status endpoint answers `200 {status:"FAILED"}` — fal's documented terminal failure — was re-polled every 5 s forever. There was no deadline constant and no `AbortSignal` anywhere in `falFetch`; the code comment "The durable generation alarm bounds the wait" relied on indirect platform timeouts (alarm/zone kills), and each quick status-poll fetch resets any per-fetch timeout. With `GENERATION_EXECUTION_ORIGIN` unset the loop runs inside the DO alarm; with it set, inside a public-origin handoff fetch killed by the zone timeout — neither is a code deadline.

Blast radius: this client is shared by the whole 3D fleet (rodin, tripo, trellis-2:fal), the image fal fallbacks (`falFallbackMediaModel.ts` imports `runFalJob`/`runFalJobResponse` — seedream-5.0-lite:fal and the fal video fallbacks), and the audio fleet (lyria `audio/lyria.ts:44`, sonilo `audio/sonilo.ts:55`, elevenlabs sfx `routes/audio.ts:1954`). Every image-fleet queue client (krea `kreaModel.ts:146-150`, wan3, kling, flux-max, minimax-h3) already models `FAILED` + deadline + `AbortSignal.timeout(remainingTime(deadline))` — the shared 3D client was the repo outlier.

Impact: one failed (or garbage-status) job pins the request/coordinator DO until an external timeout kills it — availability (request slots, alarm latency for other jobs) plus DO request/duration billing. Because fal bills jobs we stop polling, the hang also delays the settlement path issues 25/72/81 ride.

## Safe repro (isolated, non-destructive)

```ts
vi.useFakeTimers();
vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ status_url: "...", response_url: "..." }, { status: 202 }))
    .mockImplementation(async () => new Response(JSON.stringify({ status: "FAILED" })));
const job = runFalJob({ endpoint: "fal-ai/triposr", input: {} });
await vi.advanceTimersByTimeAsync(30_000);
// unpatched main: the promise never settles — the test times out.
```

## Fix

- `FalQueueStatusResponse`: `FAILED` + `error` added to the union; unknown statuses throw a 502 `FalError` instead of being re-polled forever
- `runFalJobResponse`: 20-minute deadline (`remainingTime` bounds sleep, poll, and result fetch) — 20 min preserves the repo-pinned 11-minute slow-job test semantics
- `falFetch`: `AbortSignal.timeout(remainingTime(deadline))` on every call; timeout mapped to a 504 `FalError`

## Tests

3 new tests (`test/model3d/falClientFailedStatus.test.ts`): FAILED rejects with the fal error detail; FAILED without detail surfaces the status URL; unknown status rejects. All red on unpatched main (promise never settled; tests timed out). falClient suite 11/11 green including the existing slow-job (11 min) and single-submission tests; `tsc --noEmit` clean.

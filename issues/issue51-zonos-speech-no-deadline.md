# Issue: neither hop of the ZONOS3 speech path has a deadline (six GPU slots wedgeable by a silent model server)

**Severity:** Medium (availability of a paid model + GPU rental cost; new root site — issues 4/20 fixed this class per-route elsewhere)
**Status:** Confirmed by spawned-service probe + worker-side vitest red on `a38014db9d` (2026-11-18, red→green on both hops)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/53 (branch `solution41-zonos-speech-deadlines`)

## Summary

The ZONOS3-Mini speech route (`438e0e447`) has **no deadline anywhere on its path**:

- **Worker** (`gen.pollinations.ai/src/routes/zonos-speech.ts:26-33`): `binding.fetch(endpoint, {...})` — no `AbortSignal`, no timer.
- **GPU service** (`operations/infrastructure/gpu/zonos/speech.mjs:59-68`): the model fetch's only abort trigger is the client's disconnect (`response.on("close") → abort.abort()`, `:29`); ffmpeg (`:87-133`) has no watchdog either.

A model server that accepts the connection but never responds (or stalls mid-stream, or an ffmpeg hang) therefore holds **one of the six GPU slots (`maxConcurrent = 6`) indefinitely**: the worker waits with it, every further request gets `429 "All six speech slots are busy"` (`speech.mjs:21-24`) for all paying users, and the Vast rental cost accrues for as long as the caller feels like waiting. Six patient clients wedge the whole model. The worker request itself is equally unbounded, so nothing on the platform side frees the slots either.

This is the same vulnerability class as issues 4 (community text-proxy no timeout) and 20 (user-image fetch no deadline), but those were per-route fixes on other routes; this is a brand-new route with a new worker→tunnel→GPU→model hop chain, and no prior fix covers it.

## Root cause

```js
// speech.mjs:59-68 (pre-fix) — the only abort is the client's disconnect:
const abort = new AbortController();
response.on("close", () => abort.abort());
...
const upstream = await fetch("http://127.0.0.1:1919/v2/generate", { ..., signal: abort.signal });
// → a model server that accepts but never answers never trips any bound;
//   `active` stays held until the CLIENT gives up
```

## PoC (isolated, no production calls; pre-fix results)

- **GPU service**: started a fake model server that accepts connections but never answers, spawned `speech.mjs` as `setup-vast.sh` does, sent one valid request — **no completion after 6 seconds; slot held; nothing would ever settle without the client disconnecting** (probe reproduced). Post-fix, with a 2 s TTFB deadline, the same request settles as `502 {"error":"Speech failed"}` in ~2 s.
- **Worker**: new vitest case (fake timers) — the tunnel fetch carried **no `AbortSignal` at all** (reproduced: `expected undefined to be an instance of AbortSignal`); post-fix the fetch races a 60 s first-byte deadline and a overrun surfaces as a clean 504.

## Impact

Cheap, caller-triggered denial of a paid model's entire capacity (6 slots, `paidOnly` route with double gating) plus unbounded GPU rental burn — the attacker's cost is six open connections that never read. Bounded per-request billing (~$0.05 max) makes the wallet angle negligible; the availability and cost angles are the finding.

## Fix

- **Worker** (`zonos-speech.ts`): the GPU service writes response headers with the first encoded audio byte, so the tunnel fetch now races a 60 s time-to-first-byte deadline — timer cleared when headers arrive (the body then streams bounded by the service watchdog and the caller's disconnect, which already propagates through the tunnel: client disconnect → request cancel → binding fetch cancel → `response.on("close")`). Overrun surfaces as `504 "ZONOS3-Mini did not start speaking within 60 seconds."`.
- **GPU service** (`speech.mjs`): the model fetch gets the same TTFB timer (default 60 s), and every request an overall watchdog (default 20 minutes, sized for a full 10,000-character generation on slow hardware) so a wedged encoder or stalled stream always frees its slot in `finally` (`clearTimeout(watchdog); abort.abort(); ffmpeg.kill(); active--`). `ZONOS_PORT` / `ZONOS_MODEL_URL` / `ZONOS_TTFB_TIMEOUT_MS` / `ZONOS_MAX_SPEECH_MS` env knobs keep the production defaults while letting the test suite exercise the deadlines off the production ports.

## Verification

- `speech.deadline.test.mjs` (node --test, real spawned service against fake model servers) **2/2**: silent model → 502 within the deadline (not a hang); mid-stream stall → response terminates and the slot is provably reusable.
- `zonos-speech.test.ts` 3/3 (fake-timer case pins the 60 s deadline → 504); audio suite **26/26**; `tsc --noEmit` clean.

## Merge note

Textually conflicts with `solution40-zonos-gpu-backend-token` (PR #52) in `speech.mjs`/`zonos-speech.ts` — both branches are independently based on upstream main, the hunks are disjoint (auth at the top of the handler, deadlines in the body) and resolve trivially.

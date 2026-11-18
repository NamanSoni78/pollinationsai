# Issue 98 — The Lyria fal-leg artifact download is unbounded and deadline-less: a stalled or runaway fal-storage response pins the paid request and can OOM the isolate

- **Severity:** Medium-High (availability — the accepted profile of issue 87 at the one `src/audio/` site sonilo's capped pattern never reached)
- **Affected:** `gen.pollinations.ai/src/audio/lyria.ts:57-61` — the fal leg of `google/lyria-3.5` (`model === "google/lyria-3.5:fal"`; reachable directly and as the declared fallback target of the Google leg, `shared/registry/audio-fallbacks.ts:39`) fetches `data.audio.url` with a raw `fetch()` (no AbortSignal, no redirect policy, no content-length check) then buffers the whole body with `audio.arrayBuffer()` — upstream main @ `282ac54aeb` (2026-11-18)
- **Fix branch:** `solution93-lyria-output-download-caps` (renumbered from solution91 after a concurrent session claimed the prefix — name verified unique via `ls-remote`) — fork PR [#111](https://github.com/NamanSoni78/pollinationsai/pull/111)
- **Dedup:** issue 82/PR #91 covers lyria **settlement** only (no-audio/download/empty legs settle `billedUsage` — on the unmerged `solution76` branch); issue 86 covers the fal **queue polling** client; issue 87 covers `model3d/modelUtils.downloadMesh` and enumerates the known fetch-cap family (floret 54, MCP audio 21, exa 7, user-image 20, 3D 87) — `audio/lyria.ts` is named in none. Not user-SSRF (the URL is fal-chosen), matching issue 87's severity framing.

## Root cause

The audio fleet's artifact-download cap was applied to the sibling client (`audio/sonilo.ts:76-83`: `fetchUpstream` + `readResponseBytes` 64 MiB) but never here. By the time this fetch runs, fal has already billed the completed job (the billable-units receipt is in hand — the very premise of issue 82's lyria settlement), so:

1. a slow/misconfigured fal-storage response pins the request — and its coordinator DO generation slot — until the platform limit (the issue-87 profile);
2. a huge body buffers entirely into the isolate **after** the paid event (the OOM class of issues 12/56/65/93);
3. any throw here feeds the issue-82 settlement family's $0-bill shape (owned by the unmerged solution76 — composing, not duplicated).

## Fix

`fetchUpstream` with a 60 s `AbortSignal.timeout` (solution88's mesh deadline convention) + `readResponseBytes` capped at 64 MiB (sonilo's cap), the too-large case surfacing a 502 `UpstreamError`. Composes with the unmerged `solution76-postpaid-settlement-media-client-sweep`: its settlement try/catch wraps these same lines — line-level changes only, trivial textual merge (verified against its diff).

## Safe reproduction (isolated, red on unpatched main)

`test/audio/lyria-download-caps.test.ts` — 4 tests over the stubbed fal queue flow: (1) a declared 200 MiB content-length rejected via the pre-stream check, (2) an endless 1 MiB-chunk stream rejected mid-download at the cap, (3) an AbortSignal is passed to the artifact fetch (pre-fix: none was), (4) a small well-formed song passes unchanged (control). Tests 1-3 fail on unpatched main; all 4 pass on the fix branch.

## Verification

- New suite 4/4 (3 red→green + 1 control); the lyria/lyria-billing/sonilo/assemblyai audio suites all green; `tsc --noEmit` clean
- No live probes; $0 spend

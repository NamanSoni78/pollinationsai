# Issue 131 — Stability image routes: every post-invoke failure settles $0 after the provider billed the request (issue-91/130 settlement family on the newest routes)

- **Severity:** Medium-High (billing integrity: AWS Bedrock / Stability direct billed the completed invoke; the caller settles $0 — including a raw `SyntaxError` 500 on the Bedrock parse leg — plus a hidden double-spend when the retryable 502s re-run the generation on the `:stability` fallback)
- **Affected:** `gen.pollinations.ai/src/image/models/stabilityImageModel.ts:101-158` — upstream `pollinations/pollinations` main @ `95323bdf64` (the file landed 2026-11-19 in #20336, after every prior filing)
- **Fix branch:** `solution131-stability-postpaid-settlement` — fork PR [#146](https://github.com/NamanSoni78/pollinationsai/pull/146)
- **Dedup:** the family is filed per-route-instance by the standing convention — issue 91/fork PR #4 (xAI post-render moderation), issue 120/124 (transcription fleet), issue 123 (MAI/Gemini/Lyria TTS parse legs), issue 130 (sonilo result parse), issues 72/81/82/96 (the video/image download-leg sweeps, incl. the pending `solution72` branch that already wraps the xAI **video** download leg — verified this round so it is *not* re-filed here). `git ls-tree` over every `fork/solution*` branch verified **none** touches `stabilityImageModel.ts` (the file post-dates all of them); the registry's only "Stability" entry is the below-gate Stable-Audio-3 note.

## Root cause

Both Stability image routes charge **per completed request**: Bedrock (`stability.sd3-5-large-v1:0` / `stability.stable-image-core-v1:1`, AWS per-invoke pricing — parity verified this round: $0.08/$0.04 vs the direct API's $0.065/$0.03, exactly the sheets `shared/registry/image.ts` + `image-fallbacks.ts` pin) and the direct `:stability` fallback (api.stability.ai per-image). Once the invoke returns 200, every downstream failure threw **without `billedUsage`**, and `middleware/track.ts:797` settles a failed request only from `error.billedUsage` — so the caller settles $0 while the platform pays:

1. **Bedrock parse leg:** `const result = (await response.json())` (`:143` pre-fix) — a 200 with a malformed/truncated body (intermediary HTML, torn proxy frame) escapes as a raw `SyntaxError` 500, no receipt.
2. **Bedrock decode leg:** `base64ToBuffer(result.images?.[0] ?? "")` — empty `images` array decodes to a 0-byte buffer, invalid base64 throws its own bare 502; both unbilled.
3. **Shared tail (both routes):** `detectImageMimeType(buffer) !== "image/png"` → 502 "no valid PNG" — a 200 non-PNG body (JPEG/HTML bytes) throws unbilled after the invoke billed.
4. **Direct body-read leg:** `Buffer.from(await response.arrayBuffer())` (`:113` pre-fix) — a mid-read network drop throws a raw error (not even an `UpstreamError`) after Stability billed the image.

Amplification: these wrapped-502s are **retryable** (`fallback.ts` — 5xx always retryable), so the fallback engine re-runs the same generation on the direct route: the platform pays AWS **plus** Stability for one billed caller request whenever the Bedrock 200 body is unusable — the settlement drop and the hidden double-spend have the same root cause on these sites.

## Safe reproduction (deterministic offline; $0 live)

`gen.pollinations.ai/test/image/stabilityImageModel.test.ts` (new file, 8 cases) — the 5 settlement cases are **RED on unpatched `95323bd`** via stubbed `fetch` (no provider spend):

- Bedrock 200 `not-json{` → raw `SyntaxError`, no `billedUsage` (main) → 502 + `{completionImageTokens: 1}` (fixed)
- Bedrock 200 `{"images":[]}` → bare "no valid PNG" 502, no receipt → same 502 + receipt
- Bedrock 200 `{"images":["@@not-base64@@"]}` → bare decode 502, no receipt → 502 + receipt
- direct 200 with an errored `ReadableStream` (mid-read drop) → raw `TypeError`, no receipt → 502 + receipt
- direct 200 JPEG bytes → bare "no valid PNG" 502, no receipt → 502 + receipt

The 3 control cases pin the intended negatives on both routes: the content-filter 400 stays **unbilled** (pre-generation control), and the happy path reports `usage: { completionImageTokens: 1 }` unchanged.

## Fix (`solution131-stability-postpaid-settlement`)

Mirror the repo's own `billsRejectedVideos`/issue-130 conventions: hoist `paidUsage: Usage = { completionImageTokens: 1 }` (the exact success-path usage) after the 60 s invoke `AbortSignal` is built, attach it to every post-invoke throw, and guard the bare reads —

- direct route: `try { raw = await response.arrayBuffer() } catch` → 502 `UpstreamError` with the cause + receipt;
- Bedrock route: guarded `response.json()` → 502 + receipt, then the decode wrapped so `base64ToBuffer`'s own 502 carries the receipt;
- the shared PNG-check 502 gains `billedUsage: paidUsage`;
- the `Filter reason:` 400 is deliberately left unbilled (the documented pre-generation content-policy control).

## Verification

New suite 8/8 green on the branch, **5 red on unpatched main** (re-run with the model file reverted); full `test/image/` directory 969/969 green; `test/error-observability.test.ts` + `test/tracking-observability.test.ts` 169/169 green (the billedUsage settle path and platform-provider error retention are unchanged); `tsc --noEmit` clean. Live probes: $0 (offline Vitest only). Public pricing fetches for the parity note: platform.stability.ai ($0.065/$0.03 direct) + LiteLLM's Bedrock tracker ($0.04 Core on Bedrock) — the direct-fallback rates match the registry exactly.

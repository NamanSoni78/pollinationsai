# F-03 — The community-publisher attack chain: one free registration = attacker position against callers, the shared infrastructure, and other publishers (Critical)

**Consolidates:** issues [#10](../issues/issue10-community-usage-billing-unbounded.md) (unbounded self-reported text usage), [#26](../issues/issue26-community-media-usage-unbounded.md) (non-text modalities), [#44](../issues/issue44-community-usage-clamp-zero-bills-over-ceiling.md) (clamp zero-bills over-ceiling = free service), [#22](../issues/issue22-community-text-proxy-unbounded-response.md) (text response OOM), [#77](../issues/issue77-community-transcription-embeddings-response-caps.md) (transcription/embeddings response OOM), [#93](../issues/issue93-community-speech-error-body-uncapped.md) (speech error-body OOM), [#106](../issues/issue106-media-put-byte-cap.md) (media-worker put OOM), [#107](../issues/issue107-community-asset-url-error-body-uncapped.md) (asset-URL error-body OOM), [#8](../issues/issue8-community-endpoint-upstream-host-and-body-disclosure.md) (upstream host/body disclosure), [#48](../issues/issue48-community-text-error-redaction.md) (text-leg + MCP redaction), [#57](../issues/issue57-community-endpoint-platform-zone-destinations.md) (endpoint platform-zone loops), [#78](../issues/issue78-community-asset-url-platform-zone.md) (asset-URL platform-zone loops) — 12 issues, one theme: **the community-model surface lets a self-registered publisher attack callers' balances, shared isolate memory, and other publishers' infrastructure, at zero cost to the attacker.**

**Status: LIVE on upstream `main` @ `4e662050`** — re-verified 2026-11-19: `isImplausibleProxyUsage` is still gated to `generate.text` only (`middleware/track.ts:205,728`), registry.ts still has no usage-quantity ceiling; error bodies still leak `upstreamHost` (observed live today: `"upstreamHost":"bedrock-runtime.us-east-1.amazonaws.com"`, `"upstreamHost":"portkey.myceli.ai"`).

**Fix PRs:** [#13](https://github.com/NamanSoni78/pollinationsai/pull/13), [#30](https://github.com/NamanSoni78/pollinationsai/pull/30), [#49](https://github.com/NamanSoni78/pollinationsai/pull/49), [#26](https://github.com/NamanSoni78/pollinationsai/pull/26), [#90](https://github.com/NamanSoni78/pollinationsai/pull/90), [#103](https://github.com/NamanSoni78/pollinationsai/pull/103), [#120](https://github.com/NamanSoni78/pollinationsai/pull/120), [#121](https://github.com/NamanSoni78/pollinationsai/pull/121), [#11](https://github.com/NamanSoni78/pollinationsai/pull/11), [#56](https://github.com/NamanSoni78/pollinationsai/pull/56), [#66](https://github.com/NamanSoni78/pollinationsai/pull/66), [#92](https://github.com/NamanSoni78/pollinationsai/pull/92).

---

## What this chain can do, end to end

Anyone can register a community model endpoint (free; ~90 allowlisted publishers already exist). From that position, with **zero cost** (owner traffic on your own model bills $0):

1. **Drain any caller's balance in one request and pay yourself 75%.** Self-reported usage *quantities* are unbounded on every modality: text (issue 10: `promptTextTokens: 9e15` → charge **4.5e17 pollen** in one response), video/audio seconds, image/embeddings tokens (issue 26: 1 s clip + `duration: 3600000` at the $0.5/s ceiling → **$1.8M-equivalent**; publisher reward = 75% of the billing value). The only existing clamp covers `generate.text` events and only via a price-side check — quantities pass.
2. **Or run your endpoint as a free service paid by nobody.** The anti-fraud clamp zeroes any claim past 2M/200k tokens — but nothing gates the request side, so an *honest* publisher serving an over-ceiling generation (caller-forced via `max_tokens`, advertised 10M contexts) gets $0 while the caller got the output (issue 44).
3. **OOM the shared gen/media isolates on demand.** Uncapped response/error bodies on every leg the caps never reached: text JSON/SSE (22), transcription/embeddings (77), speech error path (93), the media worker's `MediaUpload.put` cache-write (106), asset-URL error pages (107 — the red test literally exhausts the V8 heap draining a 40 MiB 404 page). Every concurrent co-tenant request dies (`error code: 1102`), triggered free by the publisher.
4. **Expose and then attack other publishers.** Every non-2xx community response forwards `details.upstreamHost` + untruncated `upstreamBody` to the caller (issues 8/48) — the publisher's real backend hostname (e.g. `api.groq.com`) and raw body are disclosed, enabling direct DDoS/scraping that bypasses the platform proxy, its rate limits, and its metering (which is how publishers get paid). Re-verified live today on two unrelated routes.
5. **Loop the platform into itself.** Community endpoint URLs and asset URLs (extracted from publisher response *bodies*) accept the platform's own zones (57/78) → self-referential proxy loops: free nested generations against the shared egress bucket, coordinator self-join deadlocks, agent cycles — a self-sustaining amplification loop the attacker starts once and walks away.

## Proof (strongest evidence per axis)

**Axis 1 — overcharge (issues 10/26, unit red/green on unpatched code):**

```
issue 10: max prices (50/1M) + promptTextTokens: 9_007_199_254_740_991
  unpatched totalPrice = 450359962737049540  (~4.5e17 pollen)
  with fix             = 500                  (10M-token ceiling)

issue 26: generate.image + x-usage-completion-video-seconds: 601
  unpatched: billed (clamp never fires — generate.text only)
  with fix: 502 usage_invalid
  scenario: 1s clip + duration 3600000 @ $0.5/s = $1.8M-equivalent pollen; publisher earns 75%
```

**Axis 2 — free service (issue 44, probe + unit):** real `trackResponse` probe with a community candidate reporting `{100, 250000}` tokens → `isBilledUsage: false, "usage_invalid"` (charge dropped *after* the 200 body was served); capability tests show 250k `max_tokens` requests accepted pre-fix. Honest scoping: the gate acceptance + billing zero-fill are proven; the delivered free generation assumes a proxy that honors `max_tokens`.

**Axis 3 — isolate OOM (issues 22/77/93/106/107, unit red/green):**

```
issue 107 (red on unpatched): a publisher 404 page streamed as 40 MiB
  -> the vitest worker DIES with V8 heap exhaustion draining it
  -> with the cap: reader stops at ~27.9 MiB
issue 22: declared Content-Length 209715200 resolves 200 on unpatched main;
          30 MiB lying-header chunked stream read to completion
issue 106: 66 MiB streamed body -> MediaUpload.put() stores it whole (unpatched)
issue 77: transcription/embeddings 200 MiB declared -> 200 on main
issue 93: 30×1 MiB error body -> whole 30 MB drained on main
```
Owner self-traffic on a private model bills $0 → the attack is free to the publisher. (The OOM mechanism itself — `error code: 1102` isolate kill with co-tenant blast radius — was live-probed in the sibling F-07 family, issues 12/56.)

**Axis 4 — disclosure (issues 8/48; 8 was live 2026-11-17, re-observed live 2026-11-19):**

```
2026-11-17 (original): garbage-audio POST to community whisper-large-v3
  -> 502 {"details":{"upstreamHost":"api.groq.com"}}   (publisher's real backend)
2026-11-19 (this pass, unrelated routes): error bodies leak
  "upstreamHost":"bedrock-runtime.us-east-1.amazonaws.com"
  "upstreamHost":"portkey.myceli.ai"
```
Issue 48 adds the text leg + MCP relay: a 200 KB publisher error body surfaces whole (`error.message.length === 204800`) in every MCP client transcript; post-fix capped at 64 KiB with a generic fallback.

**Axis 5 — self-origin loops (issues 57/78, module probe + unit):** importing the real validator on unpatched code: all 7 platform-zone URLs ACCEPTED (gen/api/mcp/enter/image/media.pollinations.ai, `*.myceli.ai`); a full-pipeline request to a self-referential model completes 200; `normalizeCommunityAssetUrl` (response-body layer) accepted the same zones until the twin fix. One `{"data":[{"url":"https://image.pollinations.ai/?model=community/<own-model>&prompt=…"}]}` body re-enters the platform and nests generations until the 300 s deadline — against the shared egress bucket, billing no one.

## The chain

```
free registration as a community publisher
        │
        ├─ self-reported usage unbounded ──> drain caller (4.5e17 pollen / $1.8M-eq)   (10/26, unit)
        │      └─ publisher reward = 75% of the charge (self-enrichment)
        ├─ honest over-ceiling generation ──> $0 billed, caller served free            (44, probe)
        ├─ uncapped response/error bodies ──> shared-isolate OOM, co-tenant kill      (22/77/93/106/107, unit)
        │      └─ owner self-traffic bills $0 → the DoS is free to repeat
        ├─ upstreamHost + raw body in every error ──> DDoS/scrape publishers directly (8/48, LIVE ×3)
        └─ platform zones accepted as destinations ──> free self-sustaining loops      (57/78, probe+unit)
```

## Members & fixes

| Issue | One-line | Verification | Fork PR |
|---|---|---|---|
| 10 | Text: unbounded self-reported token quantities → 4.5e17 pollen/response | Unit red/green | [#13](https://github.com/NamanSoni78/pollinationsai/pull/13) |
| 26 | Non-text modalities: same gap on every meter (video/audio/image/embeddings) | Unit red/green (14 new) | [#30](https://github.com/NamanSoni78/pollinationsai/pull/30) |
| 44 | Clamp zero-bills honest over-ceiling generations (caller-forcible free service) | Probe + unit | [#49](https://github.com/NamanSoni78/pollinationsai/pull/49) |
| 22 | Community text responses buffered with no byte cap or deadline (OOM) | Unit red/green (subsumes issue 4's timeout wiring) | [#26](https://github.com/NamanSoni78/pollinationsai/pull/26) |
| 77 | Transcription + embeddings serve paths uncapped | Unit red/green | [#90](https://github.com/NamanSoni78/pollinationsai/pull/90) |
| 93 | Speech error path buffers publisher's whole error body | Unit red/green | [#103](https://github.com/NamanSoni78/pollinationsai/pull/103) |
| 106 | `MediaUpload.put` buffers whole cached generation body (media worker OOM) | Unit red/green | [#120](https://github.com/NamanSoni78/pollinationsai/pull/120) |
| 107 | Asset-URL error bodies uncapped (vitest heap exhaustion on red) | Unit red/green | [#121](https://github.com/NamanSoni78/pollinationsai/pull/121) |
| 8 | Errors disclose publisher upstream hostname + untruncated body | **Live** 2026-11-17 + re-observed 2026-11-19 | [#11](https://github.com/NamanSoni78/pollinationsai/pull/11) |
| 48 | Text leg + MCP relay of upstream host/body/message; unbounded MCP error buffering | Unit red/green | [#56](https://github.com/NamanSoni78/pollinationsai/pull/56) |
| 57 | Endpoint base URLs accept platform zones → self-referential proxy loops | Module probe + unit | [#66](https://github.com/NamanSoni78/pollinationsai/pull/66) |
| 78 | Asset URLs (from response bodies) accept platform zones → nested free generations | Module probe + unit | [#92](https://github.com/NamanSoni78/pollinationsai/pull/92) |

Related without a PR in this family: issue 4 (community text timeout) is subsumed by PR #26's deadline wiring.

## Merge guidance

1. **Billing pair first:** #13 + #30 (two choke points — registry quantities and track-side clamp across modalities). #49 composes after them (request-side gate at the ceilings).
2. **Caps family:** #26 → #90 → #103 → #121 are the same `readResponseText/Bytes` convention applied leg by leg; #120 is the media-worker write side. Review as one campaign to stop whack-a-mole.
3. **Redaction pair:** #11 (all non-text legs) + #56 (text leg + MCP) — same `redactUpstream` flag, branches compose.
4. **Zone rule:** #66 + #92 share `isPlatformZoneHostname` deliberately — merge coherently in either order.
5. Product decision embedded in #49: the request-side ceiling changes what legitimately-large generations cost honest publishers — worth a maintainer call before merge.

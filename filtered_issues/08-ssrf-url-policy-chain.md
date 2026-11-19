# F-08 — The SSRF policy chain: one URL validator, five ways around it (High)

**Consolidates:** issues [#11](../issues/issue11-polli-scraper-ssrf-destination-policy.md) (polli container SSRF), [#14](../issues/issue14-user-media-redirect-policy-bypass.md) (redirect hops skip the policy), [#16](../issues/issue16-3d-unvalidated-url-forwarding.md) (/3d/ routes forward unvalidated URLs), [#21](../issues/issue21-mcp-audio-fetch-caps.md) (mcp audio hostname filter gaps), [#127](../issues/issue127-user-media-url-trailing-dot.md) (trailing-dot bypass) — 5 issues, one policy surface: **`validateUserMediaUrl` (and its app-level mirrors) is the only gate between user-supplied URLs and server-side fetches — and it can be bypassed, skipped, or fed hostnames it does not recognize.**

**Fix PRs:** [#14](https://github.com/NamanSoni78/pollinationsai/pull/14), [#17](https://github.com/NamanSoni78/pollinationsai/pull/17), [#19](https://github.com/NamanSoni78/pollinationsai/pull/19), [#25](https://github.com/NamanSoni78/pollinationsai/pull/25), [#142](https://github.com/NamanSoni78/pollinationsai/pull/142).

---

## What this chain can do, end to end

Every generation path that accepts a user URL (`image=`, `reference_images`, `reference_audio`, `image_url` parts, 3D `image=`, MCP `transcribe_audio` URLs, polli `web_scrape`/`fetch_file`) performs a **server-side fetch from platform infrastructure**. The stated policy is "no loopback / private / metadata destinations." The five members show the policy failing five different ways:

1. **Canonicalization bypass (issue 127 — the sharpest):** `BLOCKED_HOSTNAMES` is an exact-match `/^localhost$/i` plus a `.localhost` suffix rule, but WHATWG URLs preserve trailing dots in the hostname: `http://localhost./x` → `hostname === "localhost."` — **passes the validator**, and RFC 6761 §6.3 mandates resolvers answer `localhost.` with 127.0.0.1. This works even on the `redirect: "manual"` legs where the validator is the *only* gate. (Red at the validator level: `validateUserMediaUrl("http://localhost./x").ok === true`; the designed live control probe was not executed — honest label — production call-chain behavior is anchored to issue 14's earlier live probes.)
2. **Redirect hops skip the policy (issue 14):** three fetch paths use runtime-default `redirect: "follow"` — the guard validates the initial URL, then the worker follows a public 302 to `127.0.0.1`/RFC1918/metadata. Live control probe proved the guard active on the direct destination (`image=http://127.0.0.1/` → 400 `invalid_image_url`); the bypass leg is unit-pinned (pre-fix, `fetchUserImage` passed no `redirect` option — the manual-refusal logic was dead code). Honest note: RFC1918/link-local are typically unroutable from CF Workers — bypass complete, reachability limited.
3. **Paths that never applied the policy (issue 16):** `/3d/` routes forwarded raw user `image=` verbatim to providers (InferencePort/fal/Rodin) as `image_urls` — the only user-media path without `validateUserMediaUrl`, making pollinations the trusted trigger of SSRF-by-proxy against **partner networks**. Schema-level tests pin the policy (live provider-side probe deliberately not executed — it would direct a real fetch at a partner's internal network).
4. **Credentialed container SSRF (issue 11 — the deepest reach):** polli's `web_scrape`/`fetch_file` validated only scheme+netloc presence from the **bot container** that holds `.env` secrets, `polli.pem`, and compose-network neighbors — unit PoC (mocked aiohttp, unpatched code): `http://169.254.169.254/latest/meta-data/iam/security-credentials/` → `success: True`, credentials returned. Post-fix: 17 destinations blocked pre-client-call, 6 public allowed, 211 tests green.
5. **Hostname filter gaps in the app-level mirror (issue 21):** `packages/mcp` `publicAudioUrl` misses trailing-dot `localhost.`, `.local`, `.internal`, and single-label intranet hosts — `https://localhost./sample.mp3` bypasses and invokes `fetch` (red on unpatched); the same file's unbounded `response.blob()` buffering makes it an OOM primitive too (cross-listed in F-07).

**Chain effect:** individually each is "a URL validation gap"; together they show the platform's SSRF defense is a single exact-match hostname check applied inconsistently across every server-side fetch surface — so an attacker picks whichever bypass fits the route they're on, and reaches: cloud metadata (11), loopback services (127/14/21), private networks via redirect (14), or partner networks by proxy (16).

## Proof (strongest evidence)

**issue 11 — unit PoC on unpatched `bbccf2f5` (mocked aiohttp, verbatim):**
```
fetch_file http://169.254.169.254/latest/meta-data/iam/security-credentials/
-> {'success': True, 'url': ..., 'fetched': [...], parsed credentials returned}
>>> VULNERABLE: internal endpoint fetched by the bot container
```

**issue 127 — validator-level red on unpatched main:**
```
validateUserMediaUrl("http://localhost./x").ok === true     (expected false)
new URL("http://localhost./x").hostname === "localhost."    (WHATWG preserves the dot)
controls: IPv4 trailing-dot normalizes (blocked); legal "example.com." still accepted
```

**issue 14 — live control + unit:** direct `image=http://127.0.0.1/` → 400 (guard active); same destination via public redirector passes on the public hostname; 12 tests pin manual hop re-validation + 3-hop cap.

**issue 21 — unit red on unpatched:** `https://localhost./sample.mp3`, `https://intranet/...`, `.local`, `.internal` variants all bypass the filter and invoke `fetch`; mocked 30 MiB Content-Length buffers entirely.

**issue 16 — schema-level:** `Model3dParamsSchema.parse({model:"microsoft/trellis-2", image:"http://169.254.169.254/latest/meta-data/"})` succeeds pre-fix (would submit to `api.inferenceport.ai`); post-fix the parse fails with the policy 400.

## The chain

```
user-supplied URL (image= / image_url / reference_audio / 3d image= / MCP audio / polli scrape)
        │
        ▼
validateUserMediaUrl (or app-level mirror) — exact-match hostname blocklist
        │
        ├── trailing dot  "localhost."      → passes, resolves 127.0.0.1     (127, unit)
        ├── 302 hop       public → private   → guard never sees Location     (14, live-control + unit)
        ├── never applied /3d/ routes        → provider fetches it for us    (16, schema tests)
        ├── no policy in polli container     → metadata/credentials fetched  (11, unit PoC)
        └── mirror misses .local/.internal   → intranet fetch via MCP        (21, unit)
        ▼
SSRF from platform infrastructure (reachability varies by runtime egress — honestly noted per member)
```

## Members & fixes

| Issue | Path | Verification | Fork PR |
|---|---|---|---|
| 11 | polli `web_scrape`/`fetch_file` from the credentialed bot container | Unit PoC (metadata creds) | [#14](https://github.com/NamanSoni78/pollinationsai/pull/14) |
| 14 | Redirect hops skip `validateUserMediaUrl` (image/embeddings/audio) | Live control + 12 unit | [#17](https://github.com/NamanSoni78/pollinationsai/pull/17) |
| 16 | `/3d/` routes forward unvalidated URLs to providers (SSRF by proxy) | Schema tests (+ ethical skip of live leg) | [#19](https://github.com/NamanSoni78/pollinationsai/pull/19) |
| 21 | mcp audioService hostname filter gaps (+ unbounded blob buffering) | Unit red | [#25](https://github.com/NamanSoni78/pollinationsai/pull/25) |
| 127 | Trailing-root-dot loopback names pass the shared validator | Unit red at validator level | [#142](https://github.com/NamanSoni78/pollinationsai/pull/142) |

## Merge guidance

1. **#142 is the highest-leverage one-liner** (canonicalization fix in the shared validator closes the trailing-dot class for every consumer, including the manual-redirect legs).
2. **#17 (hop re-validation)** and **#19 (3D policy)** extend coverage of the same validator — merge together for a coherent policy story.
3. **#14 (polli)** is an app-level destination policy mirroring the platform's — independent.
4. **#25 (mcp audio)** pairs its hostname fix with caps/deadline (the F-07 half) — one PR, two reports' interests.
5. Structural recommendation: centralize the dot-stripped, IP-normalizing, redirect-aware check in one shared helper and lint against ad-hoc hostname checks — the family exists because five surfaces each implemented "the same" policy slightly differently.

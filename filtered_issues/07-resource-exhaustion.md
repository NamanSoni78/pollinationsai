# F-07 — Cross-tenant resource exhaustion: memory, time, and rate — cheap or anonymous DoS on every shared worker (High)

**Consolidates (33 issues):**
- **A. Memory (body/buffer → isolate OOM, `error code: 1102`):** [#12](../issues/issue12-media-json-upload-worker-oom.md) (media JSON upload — live-probed), [#56](../issues/issue56-gen-multipart-body-limit.md) (gen multipart — live-probed, pre-auth), [#100](../issues/issue100-media-json-body-limits.md) (JSON body limits), [#105](../issues/issue105-enter-anonymous-body-limits.md) + [#110](../issues/issue110-enter-wide-body-limit.md) (enter auth/billing control plane, anonymous), [#108](../issues/issue108-register-preauth-json-parse-residual.md) + [#109](../issues/issue109-stem-separation-preauth-body-limit.md) (mount completions), [#117](../issues/issue117-body-limit-gate-declared-header-bypass.md) (**the keystone: one header change defeats the pending gates**), [#65](../issues/issue65-images-b64-video-oom.md) (b64 multiplication), [#67](../issues/issue67-reference-images-aggregate-byte-budget.md) + [#76](../issues/issue76-gpt-image-edit-input-budget.md) (aggregate reference budgets), [#75](../issues/issue75-community-edit-image-fanout.md) (community edit fan-out), [#55](../issues/issue55-embeddings-multimodal-input-caps.md) (embeddings parts), [#74](../issues/issue74-bedrock-video-parts-uncapped.md) (bedrock video parts), [#54](../issues/issue54-floret-unbounded-media-fetch.md) (floret fetch), [#84](../issues/issue84-scribe-realtime-preconnect-queue-cap.md) (scribe queue), [#85](../issues/issue85-mcp-worker-request-body-caps.md) + [#94](../issues/issue94-mcp-gateway-jsonrpc-body-uncapped.md) (MCP workers + gateway), [#114](../issues/issue114-adaptedchat-quadratic-toolcalls.md) (quadratic CPU — measured), [#133](../issues/issue133-zod-validation-issue-amplification.md) (**zod validation-issue amplification — the byte-cap-defeating class: a 1.6 MB body of invalid array elements materializes 141×–223× its size in issue objects, pre-auth; GHSA-mrhx-c7xc-m3w5; measured 2026-11-20, fixed by PR #149 = zod ≥4.6.6 + array caps**).
- **B. Time (deadline-less fetches pin slots/sessions):** [#20](../issues/issue20-user-image-fetch-no-deadline.md), [#51](../issues/issue51-zonos-speech-no-deadline.md), [#86](../issues/issue86-falqueue-failed-terminal-status.md), [#87](../issues/issue87-3d-mesh-download-unbounded.md), [#98](../issues/issue98-lyria-fal-download-caps.md), [#101](../issues/issue101-realtime-budget-reserve-leak.md), [#115](../issues/issue115-audio-artifact-download-caps.md), [#125](../issues/issue125-elevenlabs-speech-deadlines.md).
- **C. Rate (unthrottled expensive surfaces):** [#68](../issues/issue68-unthrottled-routes-outside-proxy-limiter.md), [#79](../issues/issue79-ask-jev-mcp-unthrottled-public-domain.md), [#97](../issues/issue97-models-status-e2b-sandbox-edge-limiter.md), [#121](../issues/issue121-floret-gateway-ip-rate-limit.md), [#103](../issues/issue103-quests-standings-d1-fullscan.md) — **103 re-verified live 2026-11-19**.

**Status on upstream `main` @ `4e662050`:** the media JSON path (`MAX_BUFFERED_SIZE = 100 MiB`, post-decode check only) and the unthrottled standings route are unchanged (re-verified 2026-11-19).

**Fix PRs:** [#15](https://github.com/NamanSoni78/pollinationsai/pull/15), [#65](https://github.com/NamanSoni78/pollinationsai/pull/65), [#114](https://github.com/NamanSoni78/pollinationsai/pull/114), [#119](https://github.com/NamanSoni78/pollinationsai/pull/119), [#125](https://github.com/NamanSoni78/pollinationsai/pull/125), [#122](https://github.com/NamanSoni78/pollinationsai/pull/122), [#123](https://github.com/NamanSoni78/pollinationsai/pull/123), [#132](https://github.com/NamanSoni78/pollinationsai/pull/132), [#77](https://github.com/NamanSoni78/pollinationsai/pull/77), [#79](https://github.com/NamanSoni78/pollinationsai/pull/79), [#87](https://github.com/NamanSoni78/pollinationsai/pull/87), [#88](https://github.com/NamanSoni78/pollinationsai/pull/88), [#64](https://github.com/NamanSoni78/pollinationsai/pull/64), [#86](https://github.com/NamanSoni78/pollinationsai/pull/86), [#96](https://github.com/NamanSoni78/pollinationsai/pull/96), [#97](https://github.com/NamanSoni78/pollinationsai/pull/97), [#104](https://github.com/NamanSoni78/pollinationsai/pull/104), [#129](https://github.com/NamanSoni78/pollinationsai/pull/129), [#63](https://github.com/NamanSoni78/pollinationsai/pull/63), [#24](https://github.com/NamanSoni78/pollinationsai/pull/24), [#53](https://github.com/NamanSoni78/pollinationsai/pull/53), [#98](https://github.com/NamanSoni78/pollinationsai/pull/98), [#99](https://github.com/NamanSoni78/pollinationsai/pull/99), [#111](https://github.com/NamanSoni78/pollinationsai/pull/111), [#115](https://github.com/NamanSoni78/pollinationsai/pull/115), [#130](https://github.com/NamanSoni78/pollinationsai/pull/130), [#80](https://github.com/NamanSoni78/pollinationsai/pull/80), [#93](https://github.com/NamanSoni78/pollinationsai/pull/93), [#110](https://github.com/NamanSoni78/pollinationsai/pull/110), [#117](https://github.com/NamanSoni78/pollinationsai/pull/117), [#136](https://github.com/NamanSoni78/pollinationsai/pull/136).

---

## What this chain can do, end to end

One attacker with **no key at all** (several paths), a free `sk_` key, or a $0.01 prepaid key can degrade or kill **every shared worker the platform runs** — gen, media, enter (the auth/billing control plane), the MCP gateway, and the standalone MCP/floret apps — via three independent vectors:

**A. Memory — deterministic isolate kills with co-tenant blast radius.** The JSON/multipart parse paths buffer 2.6–5× the body before any cap runs, so ~30–60 MB payloads kill the 128 MB isolate (`HTTP 503 error code: 1102`) *below* every documented limit, pre-auth, pre-billing — live-probed twice on production (issues 12: 40 MiB → 503/1102 at 60% below the documented 100 MiB cap; 56: 60 MB multipart → 503/1102). Every in-flight co-tenant request dies with it. The same primitive exists on: the enter control plane (Stripe webhook, secret-scanning, device/OAuth endpoints — anonymous, pre-verification), the MCP umbrella + gateway (garbage bearer suffices; model-controlled tool `arguments` reach the gateway body), the scribe realtime queue, provider-output buffering (b64 video ≈5×, TTS inline JSON ≈3×, 16×20 MiB edit sources), sequential fetch fan-outs (999-part counts), and a **quadratic CPU** blow-up in the Responses→Chat adapter (measured on the real module: 100K items → 40.7 s, 200K → 173.7 s — a perfect ×4-per-doubling signature, anonymous, pre-billing).
**The keystone (issue 117):** the pending body-limit gates match the *declared* content-type and content-length header — `text/plain`-declared or chunked bodies bypass them all with **one header change**. Red proven on the pending base gate itself (an undeclared 33 MiB valid-JSON stream parses fully and reaches the token check).

**B. Time — deadline-less fetches pin generation slots and sessions for free.** No main-path caller wires an `AbortSignal` to user-image fetches (a slow-loris host pins slots ~125 s per request, including uncancellable detached coordinator alarms), the ZONOS3 GPU path can be wedged by a silent model server (6 slots → all users 429), a FAILED fal job polls forever (no terminal state, no deadline), 3D mesh/lyria/audio artifact downloads buffer unbounded and undeadlined, and a budget-exhausted Azure realtime upgrade leaks the completed provider session (session-capacity pinning, repeatable within the 10 req/s edge limit).

**C. Rate — unthrottled expensive surfaces.** Routes mounted outside `proxyRoutes` bypass the edge limiter entirely: `/v1/messages` parses 32 MiB bodies unauthenticated at unlimited rate (live single-shot control: full parse+validate in 0.14 s, repeatable), `/models/status` runs a paid Tinybird 24 h scan per distinct cache key (~484k paid queries/day/colo, unauthenticated), `/alpha/e2b/sandbox/*` proxies external fetches pre-auth, and the public quests standings route runs an uncached full-D1-ledger aggregate per anonymous request — **re-verified live 2026-11-19**: standings TTFB **0.83–0.99 s** (4,192 participants over a 141k+ row ledger) vs the KV-cached leaderboard sibling at **0.05–0.27 s**; one IP can hold ~60 concurrent full-scans at D1's per-database ceiling, degrading every `/api/*` request including gen's internal auto-top-up calls.

## Proof (strongest evidence)

**Live on production (issues 12/56):**
```
media POST /upload JSON, 40 MiB decoded  -> HTTP 503 {"error code": 1102}   (24 MiB control: 200)
gen POST /v1/images/edits 60 MB multipart -> HTTP 503 "error code: 1102"    (pre-auth; balance unchanged)
```

**Live timing differential (issue 103, re-run 2026-11-19):**
```
standings try1/2/3: TTFB 0.825s / 0.909s / 0.988s   (anonymous, uncached full scan)
leaderboard try1/2: TTFB 0.268s / 0.050s            (KV-cached sibling)
```

**Measured quadratic CPU (issue 114, real bundled module):** 20K items → 1.1 s; 50K → 9.6 s; 100K → 40.7 s; 200K → 173.7 s.

**Red tests that kill the runner itself:** issue 107's 40 MiB error body exhausts the V8 heap on unpatched main (see F-03); issue 86's FAILED-status mock never settles (test timeout); issue 51's silent-model probe holds the GPU slot >6 s with nothing to settle it.

**Unit red/green coverage:** every member has red-on-unpatched tests (413-capability-did-not-exist proofs for the body-limit mounts, `init.signal === undefined` pins for the deadline family, limiter-first 429 assertions with side-effect spies for section C). Honest labels: the OOM *mechanism* for issues 65/67/75/76/100/105/108/109/110 is inherited by citation from the live-probed 12/56 kills on the same worker class; issue 121's D1 amplification is mock-counted (fully mocked harness).

## The chain

```
attacker (anonymous | free sk_ | $0.01 prepaid)
        │
        ├── MEMORY: oversized JSON/multipart/b64/tool-args body
        │      parse buffers 2.6–5× pre-auth/pre-cap  → isolate 1102 kill   (12/56 LIVE; 100/105/108/109/110 mounts)
        │      one header change re-opens every pending gate                (117 — keystone)
        │      aggregate fetch fan-outs / provider outputs                  (55/54/65/67/74/75/76/84/85/94)
        │      quadratic tool_calls rebuild                                  (114, measured CPU)
        ├── TIME: deadline-less fetch/poll/upgrade
        │      slow-loris host pins slots & alarms (free, failed jobs unbilled) (20/51/86/87/98/101/115/125)
        └── RATE: unthrottled expensive surfaces
               32 MiB parses / paid Tinybird scans / external fetch proxy / D1 full-scans (68/79/97/121/103 — 103 LIVE today)
        ▼
shared isolates exhausted → co-tenant requests die platform-wide (gen, media, enter, MCP, apps)
```

## Members & fixes

| Issue | Surface | Verification | Fork PR |
|---|---|---|---|
| 12 | media JSON upload 4.6× pre-decode buffers (OOM below the cap) | **Live** 503/1102 | [#15](https://github.com/NamanSoni78/pollinationsai/pull/15) |
| 56 | gen multipart: `formData()` pre-auth; edits fan-out copies | **Live** 503/1102 + unit | [#65](https://github.com/NamanSoni78/pollinationsai/pull/65) |
| 100 | JSON body limits on media/audio/image/3d/e2b routes | Unit red (413 absent) | [#114](https://github.com/NamanSoni78/pollinationsai/pull/114) |
| 105 | enter anonymous endpoints (secret-scanning, device, oauth) | Unit red | [#119](https://github.com/NamanSoni78/pollinationsai/pull/119) |
| 110 | enter-wide gate incl. the Stripe webhook (money path) | Unit red (real workerd) | [#125](https://github.com/NamanSoni78/pollinationsai/pull/125) |
| 108 | `/register` pre-auth JSON parse (mount residual) | Unit red (stacked) | [#122](https://github.com/NamanSoni78/pollinationsai/pull/122) |
| 109 | stem-separation router pre-auth multipart/JSON | Unit red | [#123](https://github.com/NamanSoni78/pollinationsai/pull/123) |
| 117 | **Declared-header bypass defeats the whole pending gate family** | Unit red on the base gate | [#132](https://github.com/NamanSoni78/pollinationsai/pull/132) |
| 65 | Images b64_json ≈5× multiplication (video models) | Unit red | [#77](https://github.com/NamanSoni78/pollinationsai/pull/77) |
| 67 | Reference-image aggregate byte budget (17 call sites) | Unit red | [#79](https://github.com/NamanSoni78/pollinationsai/pull/79) |
| 76 | GPT-image edit sources: 16×20 MiB retained | Unit red | [#88](https://github.com/NamanSoni78/pollinationsai/pull/88) |
| 75 | Community edit `image[]`: count/aggregate/JSON triple gap | Unit red | [#87](https://github.com/NamanSoni78/pollinationsai/pull/87) |
| 55 | Embeddings multimodal parts: count + aggregate + deadline | Unit red | [#64](https://github.com/NamanSoni78/pollinationsai/pull/64) |
| 74 | Bedrock `video_url` parts invisible to caps (+500-class crashes) | Unit red (7) | [#86](https://github.com/NamanSoni78/pollinationsai/pull/86) |
| 54 | floret `_fetch_bytes` unbounded (shared container) | Unit red | [#63](https://github.com/NamanSoni78/pollinationsai/pull/63) |
| 84 | Scribe realtime pre-connect queue unbounded ($0.01 key suffices) | Unit red (13) | [#96](https://github.com/NamanSoni78/pollinationsai/pull/96) |
| 85 | MCP umbrella workers (public domains, garbage bearer) | Unit red (5 workers) | [#97](https://github.com/NamanSoni78/pollinationsai/pull/97) |
| 94 | gen MCP gateway JSON-RPC body (authenticated) | Unit red | [#104](https://github.com/NamanSoni78/pollinationsai/pull/104) |
| 114 | AdaptedChat quadratic `tool_calls` rebuild | **Measured CPU** + unit | [#129](https://github.com/NamanSoni78/pollinationsai/pull/129) |
| 20 | `fetchUserImage` no deadline (slot/alarm pinning) | Unit red (40/40) | [#24](https://github.com/NamanSoni78/pollinationsai/pull/24) |
| 51 | ZONOS3 speech: no deadline on either hop (6 GPU slots wedgeable) | Spawned-service probe | [#53](https://github.com/NamanSoni78/pollinationsai/pull/53) |
| 86 | fal queue: FAILED/unknown status polls forever | Unit red (never settles) | [#98](https://github.com/NamanSoni78/pollinationsai/pull/98) |
| 87 | 3D `downloadMesh` unbounded/undeadlined | Unit red | [#99](https://github.com/NamanSoni78/pollinationsai/pull/99) |
| 98 | Lyria fal-leg artifact download | Unit red | [#111](https://github.com/NamanSoni78/pollinationsai/pull/111) |
| 101 | Azure realtime: reserve-after-upgrade leaks provider sessions | Unit red (socket stays OPEN) | [#115](https://github.com/NamanSoni78/pollinationsai/pull/115) |
| 115 | Audio artifact downloads (4 legs) unbounded/undeadlined | Unit red (5/6) | [#130](https://github.com/NamanSoni78/pollinationsai/pull/130) |
| 125 | Nine ElevenLabs speech fetches have no deadline | Unit red (7/7) | [#140](https://github.com/NamanSoni78/pollinationsai/pull/140) |
| 68 | `/v1/messages`, `/internal/generation`, openapi fan-out outside the limiter | Live control + unit | [#80](https://github.com/NamanSoni78/pollinationsai/pull/80) |
| 79 | ask-jev-mcp public domain: no IP limit, no body guard | Unit red | [#93](https://github.com/NamanSoni78/pollinationsai/pull/93) |
| 97 | `/models/status` paid Tinybird scan; e2b sandbox proxy pre-auth | Unit red (4 side-effect spies) | [#110](https://github.com/NamanSoni78/pollinationsai/pull/110) |
| 121 | floret gateway: no IP limit; junk-bearer D1 read amplification | Unit red (mock-counted, labeled) | [#136](https://github.com/NamanSoni78/pollinationsai/pull/136) |
| 103 | quests standings: anonymous uncached D1 full-scan | **Live 2026-11-18 + re-verified 2026-11-19** | [#117](https://github.com/NamanSoni78/pollinationsai/pull/117) |

## Merge guidance

1. **The body-limit family must merge with its keystone:** #114/#119/#122/#123/#125 (mounts) are incomplete without **#132 (issue 117)** — otherwise the whole family ships with a one-header bypass. #132 is deliberately stacked on the pending base; land them together.
2. **Anonymous-surface first:** #119 + #125 (enter control plane), #65 (gen pre-auth), #97 (public MCP domains) are the paths reachable with no key at all.
3. **Time-critical live ones:** #117 (standings D1 scan — re-verified today) and #115 (Azure session leak) are production-observable right now.
4. The deadline family (#24/#53/#98/#99/#111/#130/#140) is one convention (`AbortSignal.timeout` + `fetchUpstream` + `readResponseBytes`) — a maintainer could land it as a single sweep; the per-file PRs are line-disjoint.
5. Cross-links: publisher-triggered OOM members (22/77/93/106/107) live in **F-03**; settlement consequences of failed downloads live in **F-04**; the coordinator stranding that isolate deaths trigger is **F-05/#74**.

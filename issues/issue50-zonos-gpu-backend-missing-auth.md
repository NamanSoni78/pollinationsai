# Issue: the ZONOS3 speech GPU service has no backend-token authentication (the only GPU backend without it)

**Severity:** Medium (defense-in-depth today — loopback + private tunnel; becomes High if the tunnel ever gets a public hostname, which is configured out-of-repo)
**Status:** Confirmed by spawned-service probe + worker-side vitest red on `a38014db9d` (2026-11-18, red→green on both sides)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/52 (branch `solution40-zonos-gpu-backend-token`)

## Summary

`438e0e447` ("feat: add ZONOS3-Mini speech on Vast") added a new GPU backend, `operations/infrastructure/gpu/zonos/speech.mjs`, that is the **only GPU service without the shared backend-token gate**. The four siblings all enforce it:

- `flux/server.py:114-116` — refuses to start without `PLN_GPU_TOKEN`; `:176-178` compares `x-backend-token`
- `dreamshaper/server.py:70,126-128,170` — same pattern
- `klein/handler.py:32-35,59` — same pattern (and klein shares the `vpc_networks` tunnel binding style that zonos uses, `wrangler.toml:182-189`)

`speech.mjs` accepted every request that reached the box: no token read, no header check (`speech.mjs:16-20` gates only method/URL), and the worker side (`gen.pollinations.ai/src/routes/zonos-speech.ts:26-33`) sent only `Content-Type: application/json` — no credential at all. The server binds `127.0.0.1:1920` behind a private Cloudflare Tunnel VPC binding today, which is why this is defense-in-depth rather than an exposed endpoint — but the tunnel's ingress hostnames are configured out-of-repo (`GPU_INSTANCES.md` has no zonos section yet), every sibling uses public `*.myceli.ai` hostnames, and the pattern breach is exactly how the gap slipped in.

## Root cause

```js
// speech.mjs:16-20 (pre-fix) — the entire request gate:
async function handleSpeech(request, response) {
    if (request.method !== "POST" || request.url !== "/speech") { ... 404 }
    if (active >= maxConcurrent) { ... 429 }
    // → no credential ever requested; handler runs for anyone who can reach the port
```

## PoC (isolated, no production calls; pre-fix results)

- **GPU service**: spawned `speech.mjs` exactly as `setup-vast.sh` does, then one unauthenticated `POST /speech` with a valid body — the request ran the full handler: `502 {"error":"Speech failed"}` (it had already reached for the model server at `127.0.0.1:1919`). No 401/403 was ever possible. Post-fix the same probe returns `403 {"error":"Forbidden"}`.
- **Worker**: new vitest case — the tunnel `binding.fetch` carried no `x-backend-token` header (reproduced: `expected null to be 'test-backend-token'`).

## Impact

Any path that can reach the loopback port — SSRF/RCE inside the GPU container, a co-tenant process, or a tunnel ingress misconfiguration — gets unauthenticated, unmetered GPU speech generation (and, given the 6-slot/64 KiB/10k-char caps, bounded but free compute) with zero audit trail to the platform. Credential-free reuse of paid infrastructure; the sibling services' tokens exist precisely to close this class.

## Fix

- `speech.mjs`: refuse to start without `PLN_GPU_TOKEN` (the flux pattern); `x-backend-token` compared in constant time (`timingSafeEqual` after a length check); listen port becomes `ZONOS_PORT`-overridable for testability.
- `zonos-speech.ts` + `audio.ts` dispatch: the worker sends the existing `PLN_GPU_TOKEN` Worker binding (already a required binding, `worker-bindings.d.ts:25` — the same secret the image routes use for the flux/klein hops) on the tunnel fetch; header omitted only when unset.

## Verification

- New `node --test` suite `operations/infrastructure/gpu/zonos/speech.test.mjs` **4/4**: refuses tokenless start; 403 without token; 403 with wrong token; 400 with the right token and a malformed body (auth passed, validation reached).
- `zonos-speech.test.ts` 4/4 (token sent / omitted / pre-existing cases); audio suite **27/27**; `tsc --noEmit` clean.

## Note

Session 10's round-14 clean-list recorded the zonos GPU service as acceptable because it is "loopback-only behind the Cloudflare Tunnel VPC binding" (session 11's round-14 agents concurred). This round promotes the missing token on the sibling-pattern argument (every other GPU service enforces it) plus the deterministic repro — the loopback bind bounds who can reach it *today*, not what the credential-free surface is.

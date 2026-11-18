# Issue 108 — POST /register parses an unbounded anonymous JSON body ahead of the PLN_GPU_TOKEN check (the issue-100 mount residual)

- **Severity:** Medium-High (anonymous isolate OOM / CPU parse DoS on the shared gen worker — the documented `issue 100` residual, re-verified live on main)
- **Affected:** `gen.pollinations.ai/src/routes/proxy.ts:711` (`.post("/register", handleRegisterServer)` mounted **before** `.use(auth())` at `:718` — no auth runs) → `gen.pollinations.ai/src/image/handler.ts:566-571` (`body = await c.req.json()` — full unbounded parse) → `:573` (`isAuthorizedRegisterRequest` → `secretEquals` against `PLN_GPU_TOKEN`) — upstream `pollinations/pollinations` main @ `379be828d5` (2026-11-18). The only guard is the 10 r/s/IP edge limiter (`proxy.ts:459`), which does nothing against a single oversized body.
- **Fix branch:** `solution106-register-preauth-json-cap` (stacked on `solution100-media-json-body-limits`) — fork PR [#122](https://github.com/NamanSoni78/pollinationsai/pull/122) (base = `solution100-media-json-body-limits`, so the PR diff *is* the register delta)
- **Dedup:** this is **not** a new root cause — it is the mount-list completion of the filed issue 100 family (`solution100`, fork PR #114), whose mount set (audioRoutes `use("*")`, e2b `sandboxApi`, proxy `/3d`, images) excludes `/register`. WORKLOG round 31 recorded exactly this residual: "`POST /register` (`c.req.json()` before the token check) is outside issue 100's mount list — one more `.use` line when that branch lands." The owner never added the line (verified against the pushed branch head `dfc136ae` on 2026-11-18), so this companion delivers it, the issue-104 precedent (companion settling the gap *inside* an unmerged fix) applied to the body-limit family. Issue 56 (`solution54`) is multipart-only by construction; `textBodyLimit` is mounted on the text routes only.

## Root cause

GPU fleet servers register through `POST /register` with a bearer/`?token=` `PLN_GPU_TOKEN`. The handler parses the JSON body before checking the token: an anonymous request with a 60-100 MB `application/json` body is fully buffered and `JSON.parse`d — the identical mechanism the issue-56/100 family live-probed to deterministic isolate kills (CF 1102) — before the 401 can ever run. Single request, no key, no cost.

## Safe repro (isolated, red on unpatched main)

`test/json-body-limit.test.ts` (new describe on the stacked branch): POST `/register` with `content-type: application/json`, declared `content-length: 60 MiB`, body `"x"` — **on unpatched main the declaration is never checked and the parser runs (400 `Invalid JSON` — proving parse-before-auth)**; with the mount: **413 + "32 MiB" before any read**. Control: a normal-sized anonymous body still reaches the parser and is answered by the token check (401, no env token) — the documented pre-auth parse behavior for small bodies is preserved, only the unbounded ceiling is closed.

## Fix

One line on the stacked base: `.use("/register", jsonBodyLimit)` registered immediately before the `.post/.get` mounts (Hono registration order — a `.use` after the route would not wrap it). `jsonBodyLimit` is the 32 MiB declared-JSON gate imported from `generation-handlers.ts` by the base branch; GET has no body and passes through untouched.

## Tests

2 new cases in `test/json-body-limit.test.ts` (oversized → 413 before the pre-auth parse; normal-sized → still parsed, 401) — red without the mount (1 failed | 6 passed), green with it (7/7); `tsc --noEmit` clean; biome clean. Live probes: **$0** (deterministic offline).

## Concurrent-duplicate note

A third concurrent session pushed `solution105-register-json-body-limit` (8848885013, stacked on the same `solution100` head with the same one-`.use`-line change) at 2026-11-18 16:41:30, without a PR or an issues_mds entry. Diff-verified against this branch: identical mount and intent. Per the round-30/31 duplicate convention, fork PR [#122](https://github.com/NamanSoni78/pollinationsai/pull/122) (this branch, red→green documented, issue MD filed) is the review surface; the bare branch is retained untouched for the record.

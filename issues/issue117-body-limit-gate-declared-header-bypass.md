# Issue 117 — one header change defeats the pending body-limit gates: jsonBodyLimit (solutions 100/106) matches the *declared* content type and content-length, and the parse sites parse regardless

- **Severity:** High (the exact issue-108 pre-auth parse-DoS scenario — anonymous `POST /register` — plus the issue-100 media routes — survives the entire pending fix family by changing one header or dropping the content-length declaration; stacked companion delivered before the gates merge)
- **Affected:** the `jsonBodyLimit` middleware on `gen.pollinations.ai/src/routes/generation-handlers.ts` as it exists on the pending branches `solution100-media-json-body-limits` (PR #114) and `solution106-register-preauth-json-cap` (PR #122): `if (!/\bjson\b/i.test(contentType)) return next();` + a content-length-header-only check — while every guarded parse site reads the body regardless of both declarations: `/register`'s pre-auth `c.req.json()` (`image/handler.ts:568`), the media routes' `validator("json")` / `c.req.json()` / `prepareGenerationRequest` `c.req.text()` (`proxy.ts:1199/:1288`, `images.ts:245`, `audio.ts:2373`, `generation-cache.ts:173`), e2b `readJson` (`e2b.ts:195`). Same declared-only shape in solution54's `multipartBodyLimit` (PR #65) for the multipart legs.
- **Fix branch:** `solution117-body-limit-gate-hardening` (stacked on `solution106-register-preauth-json-cap`, PR base = that branch) — fork PR [#132](https://github.com/NamanSoni78/pollinationsai/pull/132)
- **Dedup:** not a duplicate of issues 56/100/105/108/109 — those filed the *missing mounts* (which routes lack a gate); this files the *gate mechanism* being defeatable by request shape: with the pending PRs merged as-is, `content-type: text/plain` (or no content-type) or an undeclared (chunked / fetch-FormData) body skips `jsonBodyLimit` entirely and reaches the same unbounded parses. Round 34's issue 108 was the /register mount residual of issue 100; this is the mechanism residual of the whole family. The issue-104 stacked-companion convention applies (fix-before-merge on the owning branch).

## Root cause

Two mismatches between gate and parser:

1. **Content type:** the gate requires `application/json` (or a `*+json` suffix); Workers' `Request.json()`/`Request.text()` ignore the declared content type — a `text/plain`- or untyped-declared body is parsed identically.
2. **Content length:** the gate checks only the `content-length` *header*; undeclared bodies (chunked HTTP/1.1, or `fetch()` with a `FormData`/stream body — the standard browser upload shape) carry none.

Net: `POST /register` with `content-type: text/plain` and a 60 MiB declared body, or any undeclared body of any size, bypasses the pending 32 MiB ceiling and re-opens the pre-auth isolate-OOM the family exists to close (issues 56/100/108's mechanism: the body is buffered 4-6× before the first rejecting gate).

## Safe repro (isolated, red on the base gate)

`test/json-body-limit.test.ts` (extended, 11 cases): unit-level probes through the exported middleware — oversized `text/plain`-declared, content-type-less, and undeclared-streamed bodies all pass the base gate (RED: expected 413, got 200); worker-level `/register` probes: an oversized `text/plain` declaration parses (RED) and an undeclared 33 MiB **valid-JSON** streamed body parses fully and reaches the token check (401 on base; bounded-abort 400 on the fix) — proving the parse, not just the status, was ungated. Deterministic offline — live probes **$0**.

## Fix

Route every body through hono's `bodyLimit` (the primitive `textBodyLimit` already uses on the text routes): declared lengths are header-checked; undeclared ones are wrapped in a counting stream and cut at the cap. Multipart bodies keep the 52 MiB family ceiling (50 MB documented audio uploads still pass) via a second `bodyLimit` instance.

**Empirical correction of solution54's constraint:** its comment claims a re-wrapped stream breaks workerd's `formData()` — it does not. `fetch()` with a `FormData` body (the standard undeclared shape — no content-length) parses fine through the counting wrap, pinned by a real `formData()` parse through the gate plus the sonilo / assemblyai multipart fixtures. The byte-counting gate therefore also closes solution54's chunked-multipart gap.

## Tests

5 new red/green cases (**RED on the base gate: 5/11 fail**; GREEN 11/11), including the FormData-through-the-wrap parse, the undeclared >52 MiB multipart stream rejection, and the `/register` undeclared valid-JSON abort; regression e2b + image + audio + embeddings + json-body-limit suites **1081/1081**; `tsc --noEmit` clean.

# Issue 100 — Un-gated JSON request bodies on the media POST routes: 4-6 full-body copies before any size check deterministically kills the isolate

- **Severity:** High (authenticated memory-DoS with co-tenant blast radius — the JSON-side sibling of the filed multipart family, which that fix's own construction excluded)
- **Affected:** `gen.pollinations.ai/src/routes/audio.ts` (`audioRoutes` mounts only `edgeRateLimit` + `auth(), balance` — no body limit anywhere), `routes/proxy.ts` (`/v1/images/generations`, `/v1/images/edits` JSON branch, `POST /3d/:prompt`), `routes/e2b.ts` (`sandboxApi`'s `forward`/`readJson` — unbounded `c.req.text()`) — with the buffering itself in `middleware/model.ts:281-288` (resolveModel's `c.req.raw.clone().json()` to extract `model`), `middleware/generation-cache.ts:173` (`prepareGenerationRequest`'s `c.req.text()`), and the coordinator DO's `readBodyChunks` persistence — upstream `pollinations/pollinations` main @ `a21005d397` (2026-11-18)
- **Fix branch:** `solution100-media-json-body-limits` — fork PR [#114](https://github.com/NamanSoni78/pollinationsai/pull/114)
- **Dedup:** issue 56's family (`solution54-gen-multipart-body-limit`) is multipart-only by construction (`if (!contentType.includes("multipart/form-data")) return next();`) and its audit note recorded the audio-multipart addendum as deduped to that scope — the JSON side was never filed. Issue 94 (PR #104) is the gen MCP gateway route family only. Issues 75/76 are input byte budgets (reference images), not total JSON body gates — verified against their diffs: neither adds any body limit to the image routes. Issue 97 (PR #110) adds limiters to different `e2b.ts` mounts; this branch's `sandboxApi` change is line-disjoint. The text routes already enforce 32 MiB via `textBodyLimit` (`generation-handlers.ts:32-39`).

## Root cause

Every JSON POST on these routes is fully read and parsed several times before any handler, balance check, or schema cap can reject it:

1. `resolveModel` (runs on every POST that uses it, before `generationAccess` can 402 — any valid key, zero balance suffices): `getValidatedJsonBody(c.req) || await c.req.raw.clone().json()` — the `clone()` tee plus the parsed object;
2. `prepareGenerationRequest`: `await c.req.text()` — a full string copy, plus `normalizedJsonBody`'s `JSON.parse` + `stableStringify`;
3. `validator("json")` / hono-openapi on the routes that declare one;
4. the coordinator DO's `readBodyChunks` — the same body re-persisted into DO storage.

A ~40-60 MB `application/json` POST to `/v1/audio/speech` (whose own schema caps `input` at 10,000 characters — a cap that runs only *after* the buffers exist) therefore holds ≥4-6× the body inside a 128 MB isolate — the identical mechanism the multipart sibling live-probed to a deterministic `503 error code 1102` (isolate kill). Killing the isolate destroys other users' in-flight requests co-located on it, and is repeatable at the edge-limiter rate. The same un-gated chain serves `/v1/audio/speech/with-timestamps`, JSON hits on the multipart-only audio routes (`/v1/audio/voice-changer|voice-isolator|transcriptions`, `/alpha/audio/stem-separation` via the executor), the image JSON routes, `POST /3d/:prompt`, and the E2B sandbox API.

## Safe repro (isolated, red on unpatched main)

`test/json-body-limit.test.ts` (new): a standalone Hono app mounting the new gate rejects a Request with `content-type: application/json` and a declared 33 MiB `content-length` with 413 before any parsing (red on unpatched main — the middleware did not exist, and no 413 path exists on these routes); a worker-level case POSTs to `/v1/audio/speech` with a 60 MiB declared JSON body and asserts 413 (red on unpatched main); controls pin under-limit passthrough, non-JSON content types untouched (a 60 MiB multipart declaration is the multipart gate's business), vendor `+json` content types matched, and a normal small JSON speech request unaffected.

## Fix

`jsonBodyLimit` in `generation-handlers.ts` — the JSON-side twin of the multipart gate: a declared-content-length pre-parse check at the same 32 MiB ceiling `textBodyLimit` uses, skipping non-JSON content types via the same `/\bjson\b/i` test `resolveModel` uses. Mounted on:

- `audioRoutes` (`.use("*")`) — covers both speech routes and JSON hits on the multipart-only audio routes;
- `/v1/images/generations` + `/v1/images/edits` (path-scoped `.use`, registered before the `.post`s);
- `POST /3d/:prompt` (path-scoped `.use` on the pattern);
- the public E2B `sandboxApi(false, edgeRateLimit, jsonBodyLimit, auth())`.

The executor replay stays entry-gated (its bodies passed the public gate at ingestion). Chunked bodies without a declared `content-length` remain the known residual shared with the multipart gate's design.

## Tests

5 new cases in `test/json-body-limit.test.ts` — red on unpatched main (the capability did not exist), green with the fix; 89/89 with the model3d + image + media-cache + audio suites; `tsc --noEmit` clean. Live probes: $0 (deterministic offline).

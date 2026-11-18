# Issue 109 — stem-separation routes buffer an unbounded anonymous body (multipart and JSON) before generationAccess; the documented 50 MB cap runs only after the parse

- **Severity:** Medium-High (anonymous pre-401 isolate OOM on the shared gen worker — the mount gap of the filed issues 56/100 family, on a router outside both pending fix mount lists)
- **Affected:** `gen.pollinations.ai/src/routes/stem-separation.ts` (`stemSeparationRoutes` — a **separate router** mounted at `src/index.ts:298`, outside `audioRoutes`' mounts): the POST chain runs `resolveModel` (multipart `formData()` at `middleware/model.ts:272`) and `prepareGenerationRequest` (`middleware/generation-cache.ts:159` formData / `:173` `c.req.text()` for the JSON leg) **before** `generationAccess` (route position :83 in the chain) can reject an anonymous request; the documented 50 MB file cap inside the handler (`audio/stem-separation.ts:111`) runs only after the whole body has been buffered — upstream `pollinations/pollinations` main @ `379be828d5` (2026-11-18).
- **Fix branch:** `solution107-stem-separation-preauth-body-limit` — fork PR [#123](https://github.com/NamanSoni78/pollinationsai/pull/123)
- **Dedup:** not a new root cause — the mount-list completion of the filed body-limit family: issue 56 (`solution54-gen-multipart-body-limit`) mounts `multipartBodyLimit` only on `audioRoutes` + images/edits; issue 100 (`solution100-media-json-body-limits`) mounts `jsonBodyLimit` only on audioRoutes, e2b `sandboxApi`, proxy `/3d`, images — **neither list contains the separately-mounted `stemSeparationRoutes`**. A round-28 sweep called the route "authed + 50 MB cap", missing that the cap is post-parse and the route chain parses pre-401 (auth() is authenticating-not-rejecting). Filed as the companion settling the family's last route, the issue-104 precedent applied.

## Root cause

An anonymous `POST /alpha/audio/stem-separation` (any content type) is fully buffered — `formData()` for multipart bodies, `c.req.text()` for everything else including JSON — before the first rejecting gate (`generationAccess` → 401) can run. A 60-100 MB body holds several copies inside the 128 MB isolate (parse + normalized identity + tee), the identical mechanism the sibling issues live-probed to deterministic CF 1102 kills. The 50 MB check the route documents ("Source audio, up to 50 MB") only compares `file.size` after `formData()` has already buffered the whole upload.

## Safe repro (isolated, red on unpatched main)

`test/stem-separation-body-limit.test.ts` (new): worker-level probes POST `/alpha/audio/stem-separation` with a declared 60 MiB `content-length` — **multipart: on unpatched main the declaration is unchecked and the parser runs (400 `Invalid multipart form data` — expected 413, received 400); JSON: same**. Stream-enforcement unit case (plain Hono app + the exported middleware): a streamed 40 MiB body without any declaration passes (200), an 80 MiB stream is cut at the ceiling (413; the counting reader stops at 52 MiB + one chunk — the gate enforces on streams, not just declarations). Controls: a normal-sized request is unaffected (400 from the parser, not 413).

## Fix

Mount hono's `bodyLimit` at **52 MiB** (the family envelope ceiling: 50 MB documented source audio + multipart envelope, mirroring solution54's `MULTIPART_BODY_LIMIT_BYTES`) on `/alpha/audio/stem-separation`, registered **before** `auth()` — the same primitive `textBodyLimit` already uses (`generation-handlers.ts:32`), exported as `stemBodyLimit`. Unlike the content-length-only gates of solutions 54/100, hono's `bodyLimit` also enforces the ceiling on **streamed bodies that arrive without a declaration** (it pipes the body through a counting reader), so the JSON leg and chunked attackers are covered by the single mount.

## Tests

4 new cases in `test/stem-separation-body-limit.test.ts` — red on unpatched main (both oversized probes fail `expected 400 to be 413`), green with the mount (4/4); `tsc --noEmit` clean; biome clean. Live probes: **$0** (deterministic offline).

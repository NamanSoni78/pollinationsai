# Issue 54 — `floret` `_fetch_bytes` buffers unbounded remote media in the single shared container (`transcribe` / `transform_audio` / `edit_image`)

- **Severity:** High (availability): repeatable pre-billing OOM-kill DoS of the deployed public floret model
- **Affected:** `apps/floret/src/floret/tools/gen.py` — the `pollinations-ai/floret` production deployment (`floret.pollinations.ai`, Cloudflare Containers, `wrangler.jsonc` `max_instances: 2`, one shared `FloretContainer` per `worker.js:8-17`, any valid `sk_`/`ag_` key reaches it via `gateway.js:85-107` or through gen) — upstream `pollinations/pollinations` main @ `52fd0a6c824`
- **Fix branch:** `solution52-floret-fetch-byte-caps` — **PR:** [#63](https://github.com/NamanSoni78/pollinationsai/pull/63)

## Root cause

`_fetch_bytes(url, attempts=3, max_bytes=None)` already contains both a `Content-Length` pre-check and a streamed-byte check, but **both are gated on `max_bytes` being passed** (`gen.py:159-166`), and three of its four callers pass nothing:

| Caller | Site | What follows the fetch |
|---|---|---|
| `edit_image` | `gen.py:251` (`payload = await _fetch_bytes(src)`, ≤2 sources per request) | raw bytes held, then multipart-POSTed |
| `transcribe` | `gen.py:459` (`b64 = base64.b64encode(await _fetch_bytes(audio_url)).decode()`) | **same-container base64 re-encode (1.37×)**, then multipart POST |
| `transform_audio` | `gen.py:484` | raw bytes held, then multipart-POSTed |

Only `media.py`'s `_read_source` passes a cap (`max_bytes=MAX_UPLOAD_BYTES`, 100 MiB — `media.py:62`) — the house pattern these three call sites missed. The success path accumulates the whole remote body in a `bytearray` (`gen.py:163-168`) — note the **error** path is capped at 300 bytes (`:147-152`), so only the payload path is unbounded.

**Impact chain:** the brain model calls these tools with user-influenced URLs from ordinary chat; a multi-GB endpoint (or an endless stream — each chunk resets httpx's 180 s read timeout) accumulates in the **single shared container** until OOM-kill, taking the public model down and cold-restarting it — repeatable for sustained DoS, with **zero billing** because the failure precedes the transcription/generation POST (the same accepted OOM class as issues 12/21).

**Honest scoping — the SSRF prong does *not* transfer:** floret runs on Cloudflare Containers with no RFC1918/link-local/IMDS route space; the only internal outbound is the `floret-catalog.internal` service binding serving public catalog JSON. This is the issue-21 OOM class, not the issue-11 destination-policy class.

## Safe reproduction (isolated, no network)

`apps/floret/tests/test_fetch_byte_caps.py` (httpx `MockTransport`, the `test_fetch_retry.py` harness), **red on unpatched HEAD**:

1. `test_default_cap_rejects_lying_content_length` — a response declaring `Content-Length: 512 MiB` (1 KiB actually sent) is accepted and returned on unpatched HEAD (`DID NOT RAISE ValueError`).
2. `test_default_cap_enforces_streamed_bytes` — a header-less stream of 3 × 20 MiB chunks buffers to completion (60 MiB) on unpatched HEAD: direct proof of unbounded buffering.
3. `test_edit_image_caps_each_source` — a 25 MiB-declaring source is fetched and the generation API is POSTed on unpatched HEAD (platform spend begins).
4. `test_transcribe_caps_source` — same for a 200 MiB-declaring audio source.
5. `test_explicit_cap_still_honoured` (control) — explicit caps (media.py's 100 MiB) keep working pre- and post-fix.

## Fix (`solution52-floret-fetch-byte-caps`)

`MAX_FETCH_BYTES = 50 MiB` default (the platform's own audio multipart limit) and `MAX_EDIT_SOURCE_BYTES = 20 MiB` per edit source (the `/v1/images/edits` per-image `MAX_IMAGE_SIZE` limit); the existing pre-check/streamed-check plumbing becomes active by default. Minimal diff: constants + signature default + one caller line.

## Verification

New tests 5/5 green post-fix; full floret suite **185 passed / 18 failed** where pristine HEAD scores **181 passed / 22 failed** (the 18–22 failures are the pre-existing `test_mcp_tools.py` mcp-version environment class, identical pre- and post-fix; no regression, net +4).

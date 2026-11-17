# Issue 12 — JSON upload path OOMs the media Worker far below its documented 100 MiB cap (isolate-killing DoS)

- **Severity:** High (verified availability attack on production)
- **Affected:** `media.pollinations.ai` `POST /upload`, `application/json` branch — upstream `pollinations/pollinations` main @ `549feee`
- **Fix branch:** `solution10-json-upload-memory-cap` — **PR:** [#15](https://github.com/NamanSoni78/pollinationsai/pull/15)
- **Numbering:** renumbered from the earlier duplicate `issue10` (numbers 10/11 were already assigned to the community-usage and polli-SSRF reports). Finding, branch and PR unchanged.

## Root cause

The JSON upload path buffers the entire payload in isolate memory several times over before checking anything: the raw JSON body text (≈1.33× file size), the `JSON.parse` copy of the `data` string (≈1.33×), the `atob` binary string (1×), and the `Uint8Array` byte copy (1×) — a peak of ≈4.6× the decoded size. The decoded-size check (`fileBuffer.byteLength > jsonMaxSize`) runs only **after** all of those allocations, and `MAX_BUFFERED_SIZE` was set to 100 MiB. Cloudflare kills a Worker isolate above 128 MiB, so:

- ~25–30 MiB decoded already exceeds the isolate limit,
- the documented "JSON uploads remain limited to 100 MiB" cap was unsatisfiable,
- the Worker dies mid-request (HTTP 503, body `error code: 1102`), killing **every other in-flight request sharing that isolate**.

Any holder of a free `sk_` key can repeat this within the documented rate limits (50 req/10s per key, 100 uploads/min per account) to kill busy isolates in high-traffic colos.

Note the privacy branch ~20 lines above already pre-checks the **encoded** length (`base64Data.length > Math.ceil(MAX_PRIVACY_IMAGE_SIZE * 4 / 3)`); the general JSON path has no equivalent guard.

## Safe reproduction (non-destructive, own key — performed live 2026-11-17)

```bash
# 40 MiB random payload as base64 JSON
{ printf '{"data":"'; head -c 41943040 /dev/urandom | base64 -w0; printf '"}'; } | \
curl -sS -X POST https://media.pollinations.ai/upload \
  -H "Authorization: Bearer $SK_KEY" -H "Content-Type: application/json" --data-binary @-
```

Observed on unpatched production (bounty key, own account):

| Payload (decoded) | Result |
|---|---|
| 4 MiB | `200 OK` (control) |
| 24 MiB | `200 OK` (control) |
| 40 MiB | `503`, body `error code: 1102` (Worker exceeded resource limits) |

A payload **60% below the documented limit** crashes the Worker. The two control uploads (random bytes, untagged) remain on the bounty key's own account and expire via the 30-day lifecycle; the 40 MiB probe crashed before any storage write, so it left no residue.

## Fix (`solution10-json-upload-memory-cap`)

1. `MAX_BUFFERED_SIZE` 100 MiB → **16 MiB** (peak ≈ 74 MiB, safe margin under the 128 MiB isolate limit). Multipart and raw bodies already stream and keep the full cap.
2. **Pre-decode size gate:** reject via `base64Data.length > Math.ceil(jsonMaxSize * 4 / 3)` → 413 **before** `atob`/byte-copy, so a missing or lying `Content-Length` can no longer drive the OOM.
3. OpenAPI description and docs `maxFileSize` updated to `16 MiB (JSON)`.

## Verification

- New test `rejects JSON uploads above the memory-safe cap before decoding` → 413 pre-decode.
- Full `media.pollinations.ai` suite: **76/76 green** on the fix branch (recorded when the branch was authored).
- Re-checked against upstream `549feee`: the post-decode-only ordering and the 100 MiB constant are still present on main.

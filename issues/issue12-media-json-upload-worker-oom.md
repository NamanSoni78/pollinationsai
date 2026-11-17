# Issue 12 — media: an oversized JSON upload OOMs the Worker before the size check runs (413 documented, 1102 in practice)

| | |
|---|---|
| Severity | High (availability) |
| Component | `media.pollinations.ai/src/index.ts` |
| Baseline | upstream `549feee` (2026-11-17) |
| Fix | `solution10-json-upload-memory-cap` |
| PR | https://github.com/NamanSoni78/pollinationsai/pull/15 |
| Upstream PR | blocked: the token reports `pull_requests=write` but upstream returns 403 "Resource not accessible by personal access token" |

## Summary

`MAX_BUFFERED_SIZE` is meant to bound the memory a base64 JSON upload may cost, but the limit is compared against the **decoded** buffer `after` `atob()` and the byte-array copy. A base64 JSON body therefore holds roughly four copies of the file (raw body text, the base64 string, the binary string from `atob`, and the `Uint8Array`) before any limit is enforced. Cloudflare terminates an isolate above 128 MiB, so a mid-size payload dies with Worker error `1102` instead of the documented `413`.

## Root cause

```ts
// index.ts:60-61
const DEFAULT_MAX_SIZE = 104857600; // 100 MB
const MAX_BUFFERED_SIZE = 104857600; // JSON base64 uploads still buffer in memory
...
// index.ts:~678-690  (JSON branch)
binaryString = atob(base64Data);                    // whole file decoded, no limit yet
const bytes = new Uint8Array(binaryString.length);  // second full copy
for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
fileBuffer = bytes.buffer;
if (fileBuffer.byteLength > jsonMaxSize) {          // limit applied only here
    return c.json(fileTooLargeError(jsonMaxSize), 413);
}
```

The privacy branch ~20 lines above already pre-checks the **encoded** length, which is the correct pattern:

```ts
if (privacyRequested && isImage(contentType) &&
    base64Data.length > Math.ceil((MAX_PRIVACY_IMAGE_SIZE * 4) / 3)) {
    return c.json(fileTooLargeError(MAX_PRIVACY_IMAGE_SIZE), 413);
}
```

The general JSON path has no equivalent guard.

## Reproduction (non-destructive)

```bash
# ~54 MB of base64 characters => ~40 MB decoded; 4 live copies ~186 MB > 128 MiB isolate limit
python3 -c "print('{\"data\":\"' + 'A'*54000000 + '\"}')" > /tmp/big.json
curl -i -X POST https://media.pollinations.ai/upload \
  -H "Authorization: Bearer \$KEY" -H "Content-Type: application/json" \
  --data-binary @/tmp/big.json
# observed: Worker resource-limit failure (1102) / connection drop
# expected: 413 file too large, before decoding
```

Deterministic proof without a key: the decode order above is unconditional for the JSON branch, so any payload whose decoded size pushes the four-copy working set past the isolate limit fails the same way. Payloads below the limit still upload normally, so this is purely an input-size memory bug.

## Impact

One request per isolate kills a shared upload Worker. Uploads are the entry point for every generated-media path, so an attacker can repeatedly knock out media ingestion without any paid balance (the crash happens before billing).

## Fix

1. `MAX_BUFFERED_SIZE = 16 * 1024 * 1024` — 16 MiB decoded keeps the ~4.6x working set near 74 MiB, safely under the isolate limit.
2. Reject on `base64Data.length > Math.ceil(MAX_BUFFERED_SIZE * 4 / 3)` **before** `atob()` (same pattern as the privacy branch), so oversized bodies never allocate.
3. Integration test asserting 413 for an oversized JSON payload.

Multipart and raw uploads stream straight to storage and keep the existing 400 MiB cap, so large files are unaffected.

## Verification

- New integration test: oversized JSON payload returns 413 without decoding.
- Existing media suite (upload, custom id, catalog, delete) unchanged and green.
- Code path, constant and the missing pre-check confirmed at `549feee`.

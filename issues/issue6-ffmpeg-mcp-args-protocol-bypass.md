# Issue 6 — ffmpeg-mcp: `args` bypasses the validated-sources policy (file:// / https:// in argument position) and sources are uncapped

**Severity: High (container file read / SSRF exfiltration)** — the fetch-side URL validation is complete, but arguments are passed to ffmpeg verbatim, where `-i` accepts protocols the validator never sees
**Original tracker:** issue #98 in the 2026-10-23 report set (live-proven container-file exfiltration to public media URLs in the original report)

## Vulnerable code (`apps/ffmpeg-mcp/worker.js`, current HEAD b373afb)

Source URLs are validated properly (HTTPS-only, redirect revalidation, size caps):

```ts
function validateSourceUrl(value) {
    const validation = validateUserMediaUrl(value);
    if (!validation.ok || validation.url.protocol !== "https:") {
        throw new ToolFailure(400, "Source must be a public HTTPS URL");
    }
    return validation.url;
}
```

But the model-supplied `args` array is passed straight into the container:

```ts
// worker.js schema
args: z.array(z.string().min(1).max(1024)).min(2).max(64)
// container-runtime.js:59
const process = await runtime.exec(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args, outputPath],
    { cwd: WORK_DIR, ... },
);
```

ffmpeg's `-i` accepts any protocol it supports — `file:///etc/passwd`, `https://attacker/x`, `pipe:`, `concat:` with local paths, `-f concat -safe 0 -i <list>` reading container files. The tool's own description documents the intended contract:

> "Reference downloaded sources by their exact names, such as `["-i", "input0"]`. Do not include ffmpeg, source URLs, or an output path."

…but nothing enforces it. `sources` is also `.min(1)` with **no `.max()`** — unlimited parallel fetches per call.

## Impact (from the original report's live proof, unchanged in current code)

- **Container file exfiltration:** `args: ["-i", "file:///etc/passwd", ...]` → output uploaded to public unlisted media URL (flat 0.0002-pollen billing per call — the read costs less than a rounding error).
- **Arbitrary-URL fetch from the container** (`https://` in `-i` position), bypassing `validateSourceUrl` entirely.
- **Uncapped source fetch fan-out** — N sources per call × unlimited calls, each up to 100 MB.
- stderr (8 KB) doubles as a network-probe oracle for the container.

## Recommended fix (implemented in `solution6-ffmpeg-mcp-args-protocol-guard`)

1. `validateFfmpegArgs()`: reject any argument carrying a protocol prefix (`^[a-zA-Z][a-zA-Z0-9+.-]*:`) or a path (`/`, `\`, `./`, `../`) unless it is exactly an `inputN` reference — enforcing the tool's own documented contract at the executor boundary, before the container starts.
2. `sources` capped at `.max(16)` per run.

## Verification

- Full test suite passes: **16/16** (14 pre-existing + 2 new: "rejects URL and path arguments before execution" — five URL/path variants rejected with zero container runs; "accepts ordinary filter arguments alongside input references" — normal usage unaffected).

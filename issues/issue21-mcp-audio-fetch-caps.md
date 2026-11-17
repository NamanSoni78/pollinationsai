# Issue 21 — `pollinations-mcp` (`packages/mcp/src/services/audioService.js`) buffers uncapped remote audio via `response.blob()`, omits a fetch deadline, and misses trailing-dot `localhost.` / `.local` / `.internal` / single-label hostnames

- **Severity:** High (Worker 128 MiB isolate OOM & connection-holding DoS via hosted `/mcp/pollinations` tools `transcribe_audio`, `isolate_speech`, `change_voice`; SSRF hostname filter bypass for `localhost.`, `.local`, `.internal`, and single-label intranet hosts)
- **Affected:** `packages/mcp/src/services/audioService.js` (consumed by `apps/mcp/worker.js` at `gen.pollinations.ai/mcp/pollinations`) — upstream `pollinations/pollinations` main @ `549feee`
- **Fix branch:** `solution21-mcp-audio-fetch-caps` — **PR:** [#25](https://github.com/NamanSoni78/pollinationsai/pull/25)

## Root cause

`packages/mcp/src/services/audioService.js` powers the hosted `pollinations-mcp` Cloudflare Worker (`apps/mcp/worker.js`) exposed through the gateway at `/mcp/pollinations`. Its three remote-audio tools (`transcribe_audio`, `isolate_speech`, `change_voice`) call `fetchPublicAudio(source)` (`packages/mcp/src/services/audioService.js:249-269`):

```js
async function fetchPublicAudio(source) {
    const url = publicAudioUrl(source);
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) {
        throw new Error(
            `Failed to fetch audio from ${url.origin}${url.pathname}: ${response.status} ${response.statusText}`,
        );
    }
    const contentType =
        response.headers.get("content-type")?.split(";")[0]?.trim() ||
        "audio/mpeg";
    return {
        blob: await response.blob(),
        fileName: fileNameFromSource(url.pathname, contentType),
    };
}
```

Three concrete defects exist in this path:

1. **Unbounded `await response.blob()` buffers the entire remote response in Worker memory:**
   - Downstream `gen.pollinations.ai/src/routes/audio.ts` enforces strict upload limits (`MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024` for `/v1/audio/transcriptions` and `MAX_AUDIO_TRANSFORM_BYTES = 50 * 1024 * 1024` for `/v1/audio/speech/isolate` and `/v1/audio/voice-changer`).
   - However, `fetchPublicAudio` neither inspects `Content-Length` nor streams the body with a byte ceiling before constructing the `Blob` and `FormData`. Pointing `source` at a large file or a chunked stream without `Content-Length` causes the 128 MiB Cloudflare Worker isolate running `pollinations-mcp` to buffer arbitrary bytes until isolate OOM (`error code: 1102`) — before the request ever reaches `gen.pollinations.ai` or bills the caller.
2. **No fetch timeout (`signal` omitted):**
   - `fetch(url, { redirect: "error" })` passes no `AbortSignal.timeout(...)`, allowing a slow-loris or hung remote host to hold the Worker invocation open until platform termination.
3. **Incomplete hostname normalization in `publicAudioUrl(source)` (`audioService.js:211-247`):**
   - `const hostname = parsed.hostname.toLowerCase()` does not strip trailing FQDN dots (`https://localhost./sample.mp3` has `parsed.hostname === "localhost."`, which bypasses `hostname === "localhost" || hostname.endsWith(".localhost")`).
   - Unlike `gen.pollinations.ai/src/userImage.ts` (`validateUserMediaUrl`), `publicAudioUrl` also fails to reject single-label intranet hostnames (`https://intranet/sample.mp3`, `!hostname.includes(".")`) and `.local` / `.internal` internal domains.

## Safe reproduction (isolated unit tests, no network)

Run `node --test packages/mcp/test/audioService.test.js`:

1. **Trailing-dot / internal hostname bypass:** Passing `https://localhost./sample.mp3`, `https://sub.localhost./sample.mp3`, `https://intranet/sample.mp3`, `https://audio.local/sample.mp3`, or `https://service.internal/sample.mp3` to `transcribeAudio` / `isolateSpeech` / `changeVoice` bypassed `publicAudioUrl` on unpatched `main` and invoked `fetch`.
2. **Unbounded response body buffering:** Mocking `globalThis.fetch` with a `Content-Length: 30000000` (30 MiB) response or a chunked `ReadableStream` emitting 1 MiB chunks without `Content-Length` caused `transcribeAudio` on unpatched `main` to buffer the entire stream into memory instead of aborting at 25 MiB.
3. **Missing deadline:** Inspecting `init.signal` passed to `globalThis.fetch` showed `undefined` on unpatched `main`.

## Fix (`solution21-mcp-audio-fetch-caps`)

- **Bounded streaming reader (`readBoundedBlob`):** `fetchPublicAudio(source, maxBytes)` now checks `Content-Length` upfront and reads `response.body` incrementally via `getReader()`, cancelling the stream (`reader.cancel()`) and throwing `Audio source exceeds maximum size of 25 MiB` (for `transcribeAudio`, `MAX_TRANSCRIBE_AUDIO_BYTES = 25 * 1024 * 1024`) or `50 MiB` (for `isolateSpeech` and `changeVoice`, `MAX_TRANSFORM_AUDIO_BYTES = 50 * 1024 * 1024`) the moment accumulated bytes exceed `maxBytes`.
- **Fetch timeout:** `fetchPublicAudio` supplies `signal: AbortSignal.timeout(AUDIO_FETCH_TIMEOUT_MS)` (`30_000` ms).
- **Hostname normalization & internal-domain block:** `publicAudioUrl` strips trailing dots (`parsed.hostname.toLowerCase().replace(/\.+$/, "")`) before checking `localhost` / `.localhost` / `.local` / `.internal`, and rejects empty or single-label hostnames (`!hostname.includes(".")`).

## Verification

`node --test packages/mcp/test/*.test.js`: **46/46 passing** (including 4 new tests in `packages/mcp/test/audioService.test.js` covering trailing-dot `localhost.` / `.local` / `.internal` / single-label host rejection, `AbortSignal` attachment + `Content-Length` pre-check rejection for 25 MiB transcription and 50 MiB speech transforms, and streaming reader cancellation on chunked responses exceeding the byte cap).

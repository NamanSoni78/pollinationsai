# Issue 87 — model3d `downloadMesh`: unbounded, untimeouted provider artifact fetch

- **Severity:** Medium (isolate memory + request-slot pinning after the provider already billed; feeds the issue-81 settlement family on failure)
- **Affected:** `gen.pollinations.ai/src/model3d/modelUtils.ts:40-48` — upstream `pollinations/pollinations` main @ `282ac54aeb` (2026-11-18)
- **Fix branch:** `solution88-3d-mesh-download-caps` — fork PR [#99](https://github.com/NamanSoni78/pollinationsai/pull/99)
- **Dedup:** the fetch-cap class has filed instances for floret (issue 54), MCP audio (issue 21), exa-mcp (issue 7), user image fetch (issue 20) — the 3D **provider-output** download site is a distinct file/site never covered. Not overlapping with issue 81 (settlement).

## Root cause

`downloadMesh` fetched the provider's mesh URL with **no AbortSignal, no byte cap, and no content-length check**, then buffered the whole body via `arrayBuffer()`:

```ts
export async function downloadMesh(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) { throw ... }
    return Buffer.from(await response.arrayBuffer());
}
```

The URL is provider-chosen (fal's `model_mesh.url`), so this is not user-SSRF. But a misbehaving/misconfigured output host gets an unbounded fetch from our side: a slow host pins the request (and the generation-alarm slot) to the platform limit; a huge body buffers into the isolate after the provider already billed the job. Every image-fleet artifact download goes through `fetchUpstream` (bounded signal, `image/utils/fetchUpstream.ts:26-46`) and user-supplied media through the 20 MiB cap (`userImage.ts:234-237`) — the 3D fleet was the outlier.

Callers: every fal-backed 3D model (rodin, tripo, trellis-2:fal, trellis2 via InferencePort GLB download… all funnel through `downloadMesh` in `modelUtils.ts`).

## Safe repro (isolated, non-destructive)

```ts
// endless stream: pre-fix, downloadMesh buffers forever and the test times out
const endless = new ReadableStream({ start(c){ const k=new Uint8Array(65536); const p=()=>{c.enqueue(k);setTimeout(p,1)}; p(); } });
vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(endless,{headers:{"content-type":"model/gltf-binary"}}));
await downloadMesh("https://provider.example/mesh.glb"); // never settles on unpatched main
```

## Fix

- `AbortSignal.timeout(60 s)` on the artifact fetch
- declared `content-length` checked against a 64 MiB cap before reading
- streamed read with a running byte total — a lying content-length cannot exceed the cap either
- reader errors mapped to 502 `UpstreamError` (existing error shape preserved)

## Tests

4 new tests (`test/model3d/downloadMeshCaps.test.ts`): declared over-cap rejection; streaming over-cap rejection mid-download (red on main — the whole body buffered); signal-presence pin (red on main — no signal passed); small-artifact passthrough. 6 model3d suites (every `downloadMesh` caller + the caps suite) 34/34 green; `tsc --noEmit` clean.

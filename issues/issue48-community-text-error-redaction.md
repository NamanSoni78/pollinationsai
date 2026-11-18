# Issue 48 — Community text endpoints leak the publisher's hostname, raw error body, and upstream message; the MCP surface relays them and buffers unbounded error bodies

- **Severity:** Medium-High (same class as issue 8, on the **largest** community surface — the text leg — which issue 8's report and fix never covered, plus the MCP surface newly unmasked by `d2294d197` / #19709)
- **Affected:** `gen.pollinations.ai/src/text/genericOpenAIClient.ts`, `text/errors.ts`, `text/communityEndpoint.ts`, `text/generateTextPortkey.ts`, `text/responses/{client,chatClient,handler}.ts`, `utils/upstream-response.ts`, `shared/error.ts`, `packages/mcp/src/utils/coreUtils.js` — upstream `pollinations/pollinations` main @ `a38014db9` (2026-11-18)
- **Fix branch:** `solution41-community-text-error-redaction` — **PR:** [#56](https://github.com/NamanSoni78/pollinationsai/pull/56)
- **Relationships:** companion to issue 8 (`solution8-community-upstream-host-redaction` / fork PR #11, still unmerged — covers image/video/speech/transcription/embeddings). This issue's branch is self-contained against upstream main and composes with issue 8's (both add the same `redactUpstream` flag to `shared/error.ts`; the conflict is trivial).

## Summary

Issue 8 documented the community-endpoint upstream disclosure for the image, video, speech, transcription, and embeddings surfaces. The **text leg** — every `POST /v1/chat/completions`, `/v1/messages`, `GET /text/:prompt`, and `/v1/responses` call against a community model — was never covered, and `d2294d197` (#19709, "show the gateway's 404 and 5xx error messages") newly relays the gateway's `error.message` through the MCP surface (`mcp.pollinations.ai`, `gen /mcp/*`, agent transcripts) for 404/502/503/504:

1. **Host + body.** `genericOpenAIClient.createApiError` attaches the publisher's URL and the raw upstream `responseBody` to every non-ok community response; `throwTextError` forwards them into the `UpstreamError`; `createUpstreamErrorResponse` (`shared/error.ts`) publishes both as `details.upstreamHost` and `details.upstreamBody` (untruncated) to any caller. Same shape on the responses paths (`responses/client.ts` non-ok branch, the handler's own error sites, `assertStreamContentType`).
2. **Upstream message.** The envelope's `message` is upstream-derived on the same paths (`"${status} ${statusText}: ${upstream error text}"`) — and since `d2294d197` the MCP client surfaces exactly that message for 404/502/503/504 (`parseApiError` returns the gateway's `error.message`), so a community publisher's error text (which routinely carries internal hostnames, IPs, ports, and upstream-echoed credentials like `Incorrect API key provided: sk-pub-…`) renders in every MCP client and agent transcript.
3. **Unbounded MCP error-body read.** `fetchResponseWithAuth` (`packages/mcp/src/utils/coreUtils.js`) buffers the **entire** gateway error body via `response.text()` before parsing — a hostile community publisher can return a multi-megabyte error body on their own free traffic (owner calls are unbilled) and amplify into the shared MCP isolate and every client rendering the error.

## Root cause

```ts
// gen.pollinations.ai/src/text/genericOpenAIClient.ts — createApiError (pre-fix):
const error = new Error(detailMessage ? `${statusMessage}: ${detailMessage}` : statusMessage) as ServiceError;
error.responseBody = responseBody;          // the publisher's raw body
error.requestUrl = requestUrl;              // the publisher's URL
// → shared/error.ts createUpstreamErrorResponse publishes both to callers:
upstreamHost: error.requestUrl?.hostname,
upstreamBody: error.responseBody,           // untruncated

// packages/mcp/src/utils/coreUtils.js — pre-fix:
const errorText = await response.text().catch(() => "Unknown error");  // unbounded
throw new Error(parseApiError(response.status, errorText));
```

## PoC (isolated red tests on the real modules; pre-fix results)

New `gen.pollinations.ai/test/community-text-error-redaction.test.ts` — both cases fail on unpatched `a38014db9`:

- **The leak, reproduced through the real pipeline:** a hono app with `app.onError(handleError)` whose route runs `generateTextPortkey` with a community model definition, `directEndpoint: https://publisher-gpu.example.com/v1/chat/completions`, and a mocked 429 upstream response (`{"error":{"message":"rate limit exceeded on gpu-box.publisher-gpu.example.com (10.0.0.5:8443)"}}`). Pre-fix client envelope: status 502 (remapped) with `"message":"429 Too Many Requests: rate limit exceeded on gpu-box.publisher-gpu.example.com (10.0.0.5:8443)"`, `"upstreamHost":"publisher-gpu.example.com"`, `"upstreamBody":"{\"error\":{\"message\":\"rate limit exceeded on gpu-box…\"}}"` — the publisher's host, raw body, and message all disclosed. Post-fix: generic gateway message, no host, no body.
- **MCP bounded read:** `packages/mcp/test/coreUtils.test.js` — a mocked gateway 502 whose JSON error message is 200 KB: pre-fix `error.message.length === 204800` (the whole body buffered and surfaced); post-fix the read caps at 64 KiB, the truncated JSON falls to the per-status generic message. Control: small gateway messages still pass through unchanged.

## Impact

Any caller with a free API key calling any community text model whose upstream is rate-limited, misconfigured, or down learns the publisher's real backend hostname (bypassing platform rate limits and safety features for direct attacks on a self-hosted GPU box), the raw upstream body (untruncated), and the upstream's error text — and since #19709 the same content renders in every MCP client. The unbounded error body is a publisher-triggerable memory-amplification channel into the shared MCP isolate. Compounding: `remapUpstreamStatus` maps community 401/402/403/404/409/429/524 to exactly the 502/503/504 statuses the MCP passthrough newly unmasked.

## Fix

- `UpstreamErrorOptions.redactUpstream` (fork-compatible with issue 8's branch): when set, the client envelope drops `upstreamHost`/`upstreamBody`; server-side logging keeps full diagnostics.
- Community text attempts are tagged (`tagCommunityUpstreamError` in `text/communityEndpoint.ts`): the chat `directEndpoint` path and the responses adapter in `generateTextPortkey`, and the direct `/v1/responses` candidates in the responses handler (including its own `UpstreamError` sites and `assertStreamContentType`, which gains an options param).
- Upstream-**derived** messages — flagged `upstreamMessage` at their construction sites (`createApiError`, `assertCompletionOk`, `withUpstreamContext`, the responses client's non-ok/stream-failure/fetch-catch sites, the adapter's content-type echo) — answer with the gateway default under redaction. Gateway-authored messages (the handler's literals, `requireChatCompletionUsage`'s "omitted usage" diagnostics) keep their actionable text — the maintainers' `error-observability` (platform-provider body passthrough) and `community-endpoints` (usage diagnostics) suites pin both behaviors.
- The MCP client's error-body read is capped at 64 KiB (single oversized chunks are sliced, not appended whole).

Post-fix: new suite 2/2; `community-endpoints` + `error-observability` + the new file 214/214 green; 310 text-path tests green; `tsc --noEmit` clean; `packages/mcp` `node --test` 51/51. Residual (documented, not fixed here): `assertStreamContentType`'s message echoes the upstream content-type header value under a gateway-authored prefix for community attempts — bounded by header-value constraints; closing it fully belongs with issue 8's envelope work.

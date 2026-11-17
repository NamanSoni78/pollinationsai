# Issue 4 — Community text-proxy upstream fetches have no timeout (documented 300s unimplemented on the highest-traffic modality)

**Severity: Medium-High (availability + cost)** — a wedged third-party endpoint tarpits requests until the platform timeout; documented deadline exists but is not wired on the text path
**Original tracker:** issue #90 in the 2026-10-23 report set

## Vulnerable code (current HEAD b373afb)

Every other modality's community serve path binds its upstream fetch to the shared deadline:

```ts
// gen.pollinations.ai/src/image/communityEndpoint.ts:177 (and :265)
await downloadUserImage(imageUrl, AbortSignal.timeout(COMMUNITY_ENDPOINT_TIMEOUT_MS));
// gen.pollinations.ai/src/embeddings/communityEndpoint.ts:70
signal: AbortSignal.timeout(COMMUNITY_ENDPOINT_TIMEOUT_MS),
// gen.pollinations.ai/src/audio/communityEndpoint.ts:73,171  — same
```

The text path passes no signal anywhere:

```ts
// gen.pollinations.ai/src/text/genericOpenAIClient.ts:516
response = await fetcher(endpointUrl, {
    method: "POST",
    redirect: "manual",
    headers,
    body,            // ← no signal
});
// gen.pollinations.ai/src/text/responses/client.ts:232 — same
```

`COMMUNITY_ENDPOINT_TIMEOUT_MS = 300_000` (`shared/community-endpoints.ts:80`) is defined and used by three modalities — the text proxy (chat completions, the platform's highest-traffic surface) simply never got it.

## Impact

- A community endpoint that accepts the TCP connection then stalls (deliberately or through misconfiguration) hangs the worker until the platform's own timeout fires — `withModelFallback` retry logic cannot help because the fetch never returns.
- Any publisher can deploy a listening-but-unresponsive endpoint; every request routed to it is tarpitted, consuming concurrent-request capacity that the platform pays for.
- The 5-minute documented deadline is unenforceable on this path, so a slow-drip endpoint (drip 1 byte/minute) can hold requests far beyond the intended bound.

## Recommended fix (implemented in `solution4-community-text-proxy-timeouts`)

Add a deadline-bound fetcher in the community gateway config (`communityEndpointModelConfig`) and thread it through both transports:

- chat path: `modelConfig.fetcher` → `generateTextPortkey`'s `requestConfig.fetcher` (directEndpoint branch now honors a config-provided fetcher);
- Responses-API path: `modelConfig.responsesFetcher` → `callChatViaResponses`.

Official providers keep their existing fetchers (portkey binding, bedrock signing) — the override only rides on the community path, where the endpoint is a third-party self-hosted server.

## Verification

- `bun build --no-bundle` transpile passes for both edited files.
- The deadline value and `AbortSignal.timeout` pattern are lifted verbatim from the three sibling modality paths.

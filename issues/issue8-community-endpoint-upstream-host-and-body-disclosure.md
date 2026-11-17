# Issue: Community-endpoint errors disclose the publisher's upstream hostname and full untruncated body to every caller

**Severity:** Medium-High
**Status:** Confirmed by live test (2026-11-17)
**Fix:** PR from `solution8-community-upstream-host-redaction`

## Summary

Every community-model serve path (image, video, speech, transcription, embeddings) attaches the endpoint's `requestUrl` and raw upstream `responseBody` to the `UpstreamError` it throws, and `createUpstreamErrorResponse` (`shared/error.ts`) forwards both fields to **any caller** in the JSON error envelope. Community endpoints are third-party, self-hosted servers: this discloses the publisher's real hostname (bypassing the platform's proxy), and hands a hostile endpoint an untruncated response-amplification channel into every caller's error envelope.

## Root cause

`shared/error.ts` (at commit `0cf0ad1`), `createUpstreamErrorResponse`:

```ts
return createErrorResponse(error, status, timestamp, {
    details: {
        name: error.name,
        upstreamStatus: error.upstreamStatus,
        upstreamHost: error.requestUrl?.hostname,   // publisher's server
        upstreamBody: error.responseBody,            // untruncated
    },
    code: error.errorCode,
});
```

Community serve paths deliberately attach both: `gen.pollinations.ai/src/image/communityEndpoint.ts:247-252` (`requestUrl: new URL(url)`, `responseBody: text`), `src/audio/communityEndpoint.ts` (speech `:76-81`, transcription `:173-179, 185-190`), `src/embeddings/communityEndpoint.ts:43, 73, 81, 186`, and `shared/community-media.ts` (image/video fetch errors).

`MAX_UPSTREAM_BODY_LENGTH = 16000` truncation applies only to the Tinybird `error_event` log, never to the caller response.

## PoC (executed 2026-11-17, anonymous-readable route, own key, one garbage-audio request)

```bash
printf 'not-audio' > bad.wav
curl -sS -X POST https://gen.pollinations.ai/v1/audio/transcriptions \
  -H "Authorization: Bearer $KEY" \
  -F "file=@bad.wav" -F "model=community/Catniti/whisper-large-v3"
```

Response (verbatim):

```json
{"success":false,"error":{"message":"Community transcription endpoint 'community/Catniti/whisper-large-v3' rejected response_format=verbose_json. ...","code":"BAD_GATEWAY","timestamp":"2026-11-17T13:31:33.884Z","details":{"name":"UpstreamError","upstreamHost":"api.groq.com"}},"status":502}
```

`details.upstreamHost` names the publisher's actual backend (`api.groq.com` for that endpoint; a self-hoster would expose their GPU box's DNS name and any path/port structure). The same envelope carries `upstreamBody` verbatim wherever the upstream returns an error body — untruncated, so a hostile endpoint can also push megabytes through it.

## Impact

- **Direct attack surface transfer:** any caller learns the hostname behind the platform proxy, enabling direct DDoS/scraping of the publisher's server that bypasses platform rate limits, `requiredSafetyFeatures`, and usage metering (which is how the publisher gets paid).
- **Response amplification:** the untruncated `upstreamBody` lets a malicious endpoint buffer an arbitrarily large "error" into every caller's response (compounding the missing serve-path size caps on embeddings/transcription, tracked separately).
- **Privacy of publisher topology:** reveals hosting relationships (e.g. that a "community" model is actually backed by Groq) that the platform's proxy exists to hide.

## Fix

`shared/error.ts`: add a `redactUpstream?: boolean` option to `UpstreamError`. When set, `createUpstreamErrorResponse` omits `upstreamHost`/`upstreamBody` from the caller response. All community serve paths set it (13 construction sites across `audio/embeddings/image/communityEndpoint.ts` + `shared/community-media.ts`, plus `ensureUpstreamOk(..., { redactUpstream: true })` for the shared helper). Server-side `error_event` logging keeps the full host/body for debugging — only the client envelope is redacted. Platform-managed providers are unchanged (the existing 49 `error-observability` tests still pass; new `shared/upstream-redaction.test.ts` pins both behaviors).

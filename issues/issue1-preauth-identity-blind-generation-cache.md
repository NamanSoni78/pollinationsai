# Issue 1 — Pre-auth, identity-blind generation cache: keyless replay of paid generations and cross-tenant response poisoning

**Severity: Critical** — paid-model output served with no key, no account, no rate limit, no billing; attacker-seeded cache entries served to other callers as fresh model output
**Status: LIVE in production — live-verified 2026-11-17** (keyless `200 X-Cache: HIT` replay of a keyed generation, identical `X-Cache-Key`, on both `text.pollinations.ai` and `gen.pollinations.ai`)
**Original tracker:** issue #73 in the 2026-10-23 report set (media leg: #104)

## Live proof (2026-11-17, attacker role only: own key + keyless requests)

```bash
# 1. Warm the cache WITH a key
curl -sS -D - -o /dev/null -X POST https://gen.pollinations.ai/v1/chat/completions \
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  -d '{"model":"openai","messages":[{"role":"user","content":"<unique marker> say only: ok"}]}'
# -> HTTP/2 200, x-cache: MISS, x-cache-key: 778a39b78ceec6a3

# 2. Byte-identical replay, NO key, NO account
curl -sS -D - -o /dev/null -X POST https://gen.pollinations.ai/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"openai","messages":[{"role":"user","content":"<unique marker> say only: ok"}]}'
# -> HTTP/2 200, x-cache: HIT, x-cache-key: 778a39b78ceec6a3   (identical key!)

# 3. Control: keyless NEVER-SEEN body
# -> HTTP/2 401 UNAUTHENTICATED ("A valid API key is required")
```

The identical `x-cache-key` across the keyed and keyless requests proves the cache key contains no caller identity. The control proves auth runs only on MISS — a keyless caller receives unlimited 200 HITs for anything already cached, while fresh keyless requests are rejected. Reproduction script: `proof/poc1-preauth-cache.sh` in the bounty bundle.

## Vulnerable code (current HEAD b373afb)

**1. Cache mounts before auth on every generation route** — `gen.pollinations.ai/src/routes/proxy.ts`:

```ts
const chatCompletionHandlers = factory.createHandlers(
    ...
    every(textBalanceNotice, track("generate.text")),
    textCache,                                          // ← lookup HERE
    every(generationAccess, deduplicateGeneration),     // ← auth/balance only HERE
    apiKeyBudgetReservation,
    generateChatCompletion,
);
```

Same order for `/v1/responses`, `/alpha/decisions`, `/v1/embeddings`, `/text`, `/audio/:text`, and all image/video/3D routes (`imageCache`/`audioCache`/`model3dCache` before `generationAccess`). The middleware doc comment states it outright: *"Checks cache before auth/balance checks so cache hits can remain public. Returns immediately on cache HIT."*

**2. The cache key strips identity by construction** — `gen.pollinations.ai/src/utils/text-cache.ts`:

```ts
// Parameters to exclude from cache key (auth + cache control)
const EXCLUDED_PARAMS = ["key", "no-cache"];
```

`generateCacheKey()` = sha256(method + path + filtered-params + filtered-body + safety parts). No Authorization header, no API key id, no user id, no IP. The `?key=` param and body `key` field are explicitly stripped so **requests from different keys share one entry**. The media variant (`utils/media-cache.ts`) has the same `EXCLUDED_PARAMS = ["nofeed", "no-cache", "key", "stream"]`.

**3. Cache hits are unbilled** — `gen.pollinations.ai/src/middleware/track.ts`:

```ts
const cacheHit = response.headers.get("x-cache") === "HIT";
if (cacheHit) { return notBilled(); }
```

**4. Every read refreshes the R2 TTL** (`refreshR2ObjectTtl` in `getCachedResponse`) — popular entries never expire.

## Impact

- **Attack A — free paid output at scale:** sweep predictable/common request bodies (template prompts, tutorial examples, popular system prompts) against paid-only models. Every HIT is paid output generated and billed to someone else, served with no credentials and no rate limit.
- **Attack B — cross-tenant poisoning:** attacker seeds the cache with body `B`; every other user submitting identical `B` receives the attacker's content presented as fresh model output (`X-Cache: HIT` is a header most clients ignore). Strongest against `/v1/embeddings` (vectors feed RAG stores long-term) and `/v1/audio/transcriptions` (confidential transcripts served to anyone holding the same file bytes; multipart boundary is normalized out of the key, so cross-client replay works).
- **Attack C — victim-response exfiltration:** learn/predict a victim's exact request → read their cached answer with no credentials.
- **`no-cache` is stripped and never honored** — there is no supported way to force a fresh generation.
- The codebase itself states the principle being violated (`middleware/model.ts`, on the agent-run partition): *"An agent run executes tools and spends the caller's balance, so its answer belongs to that caller and must never be replayed to another."*

## Recommended fix (implemented in `solution1-preauth-cache-identity-partition`)

1. Partition the cache key by caller identity, resolved with the same read-only `authenticateApiKeyRequest` the auth middleware uses (the lookup runs before `auth`, so identity variables are empty at that point). Keyed generations become private to the key that paid for them; anonymous traffic keeps the documented shared cache for the classic `/text/:prompt` endpoint.
2. Mark keyed entries `Cache-Control: private, no-store` so intermediary caches never replay them either.
3. Lookup failures fall back to the anonymous scope; the auth middleware still rejects bad keys on MISS (fail-closed, no behavior change for valid anonymous traffic).

## Affected routes (complete mount map, all pre-auth)

| Route | Cache middleware | File |
|---|---|---|
| `POST /v1/chat/completions` | `textCache` | `routes/proxy.ts` |
| `POST /v1/responses` | `textCache` | `routes/proxy.ts` |
| `POST /alpha/decisions` | `textCache` | `routes/proxy.ts` |
| `POST /v1/embeddings` | `textCache` | `routes/proxy.ts` |
| `POST /text`, `GET /text/:prompt` | `textCache` | `routes/proxy.ts` |
| `POST /v1/audio/transcriptions` | `textCache` | `routes/audio.ts` |
| `POST /v1/audio/speech/with-timestamps` | `textCache` | `routes/audio.ts` |
| `POST /v1/audio/speech`, `/voice-changer`, `/voice-isolator`, `GET /audio/:text` | `audioCache` | `routes/audio.ts`, `routes/proxy.ts` |
| `POST /alpha/audio/stem-separation` | `audioCache` | `routes/stem-separation.ts` |
| image/video routes, chat-with-media bridge | `imageCache`/`model3dCache` | `routes/proxy.ts`, `src/media/responses.ts` |

The submitted fix covers the text and media adapters (`middleware/text-cache.ts`, `middleware/media-cache.ts`), which every row above funnels through.

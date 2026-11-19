# F-01 — The generation cache is public, identity-blind, permanent — and it can be poisoned (Critical)

**Consolidates:** issues [#1](../issues/issue1-preauth-identity-blind-generation-cache.md) (pre-auth identity-blind cache), [#40](../issues/issue40-text-cache-error-completion-poisoning.md) (error completions cached), [#71](../issues/issue71-content-filter-cache-refusal-companion.md) (content-filter refusals cached), [#15](../issues/issue15-exif-usercomment-public-content-and-url-disclosure.md) (EXIF public content channel) — 4 issues, one root surface: **the platform permanently hosts and replays generation output to anyone, and what enters that store is not validated.**

**Status: LIVE on upstream `main` @ `4e662050` — re-verified live 2026-11-19** (probe outputs below; cache middleware still mounted before auth in `gen.pollinations.ai/src/routes/proxy.ts:239/253`, `EXCLUDED_PARAMS = ["key","no-cache","stream"]` still strips identity, EXIF writer still embeds full `safeParams` uncapped).

**Fix PRs (review surface):** [#1](https://github.com/NamanSoni78/pollinationsai/pull/1) (identity partition — the keystone), [#45](https://github.com/NamanSoni78/pollinationsai/pull/45) (never cache error completions), [#83](https://github.com/NamanSoni78/pollinationsai/pull/83) (never cache content-filter refusals), [#18](https://github.com/NamanSoni78/pollinationsai/pull/18) (cap EXIF UserComment, drop input URLs).

---

## What this chain can do, end to end

1. **Anyone reads paid generations for free, unlimited.** Warm the cache once with any valid key (or wait for any other user to make a common request), then replay the identical body **with no key, no account, no rate limit** — you receive a `200` with the paid model's output. Verified again today.
2. **Anyone can poison what other users receive.** Cache entries are keyed on the request body only — no caller identity. Seed the cache with body `B` (your key, your content); every other user who submits the same `B` gets **your** content served as a fresh `200 X-Cache: HIT` model answer. Worse: **error completions and moderation refusals also get cached** (issues 40/71), so one provider hiccup or one deliberately-rejected prompt freezes a broken/refusal answer for every future caller of that request — *retries can never recover*.
3. **The poison is permanent.** Every read refreshes the R2 TTL (`refreshR2ObjectTtl`), `Cache-Control: immutable` on the media host, and there is no supported way to force a fresh generation (`no-cache` is stripped and never honored).
4. **The media host doubles as an unmoderated public content channel.** Every generated JPEG embeds the full request parameters (up to 32k-char prompts, input image URLs with signed tokens) in the EXIF `UserComment`, and the object is fetchable **anonymously** at `media.pollinations.ai/<hash>`, immutable, TTL-refreshed (issue 15). That is a platform-domain hosting channel for arbitrary text (phishing/C2/illegal content) and a leak of every shared image's prompt and input URLs.

## Proof

### Live re-verification, 2026-11-19 (this consolidation pass, own key, $0.0000069 spend)

```bash
# 1. Warm the cache WITH a key
curl -sS -D - -o /dev/null -X POST https://gen.pollinations.ai/v1/chat/completions \
  -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
  -d '{"model":"openai","messages":[{"role":"user","content":"<unique marker> say only: ok"}]}'
# -> HTTP/2 200, x-cache: MISS, x-cache-key: b69fc3a25b7b66e9

# 2. Byte-identical replay, NO key
# -> HTTP/2 200, x-cache: HIT, x-cache-key: b69fc3a25b7b66e9   (identical key!)
#    body byte-identical to the keyed response: YES

# 3. Control: keyless NEVER-SEEN body
# -> HTTP/2 401 UNAUTHENTICATED
```

The identical `x-cache-key` proves the cache key contains no caller identity; the control proves auth runs only on MISS. Balance moved only for the keyed MISS — every HIT is unbilled.

### EXIF channel, live 2026-11-19

Generated `flux` image with canary prompt via own key → response `link:` header → **anonymous** `GET https://media.pollinations.ai/a6ba958953fb5a22...`:

```
HTTP/2 200
content-type: image/jpeg
cache-control: public, max-age=31536000, immutable
```

EXIF `UserComment` at byte 149 contains the full request verbatim:
```json
{"prompt":"a red circle on white background. marker EXIF-CANARY-c9d1e3f5-...","originalPrompt":"...","width":1024,"height":1024,"seed":...
```

### Unit/integration evidence (from the member reports)

- **issue 40** (unit, red on unpatched): a `200` body with `finish_reason:"error"` → second identical request returns `X-Cache: HIT` (origin hit once) — JSON, SSE-nested-error and Responses `status:"failed"` variants all cached; normal bodies still cached (correct). Nested-error SSE terminal chunk → HIT.
- **issue 71** (unit, red on unpatched): two identical POSTs where the model returns `finish_reason:"content_filter"` with no usage → second request `X-Cache: HIT`; the billing side classifies the same shape as a rejection — the cache and the biller disagree.
- **issue 1** (live 2026-11-17, original): identical probe pair on `text.pollinations.ai` and `gen.pollinations.ai`, including `/v1/embeddings` (RAG store poisoning) and `/v1/audio/transcriptions` (same file bytes → confidential transcript replay; multipart boundary normalized out of the key).

## The chain

```
keyed request (any valid key, incl. free tier)
        │  body = f(model, params, prompt)   ← NO identity in key
        ▼
R2 cache entry (immutable, TTL refreshed on every read)
        │
        ├── keyless replay        → free paid output, unlimited      (issue 1, live)
        ├── poisoned entry        → other users receive attacker/error content (issues 1+40+71)
        │   ├── provider error    → frozen garbage served as 200 HIT (issue 40, unit)
        │   └── moderation refusal→ frozen refusal, retry-proof     (issue 71, unit)
        └── media host object     → anonymous immutable public URL   (issue 15, live)
            └── EXIF UserComment → unmoderated 32 KB content channel + prompt/input-URL disclosure
```

## Members & fixes

| Issue | One-line | Verification | Fix branch | Fork PR |
|---|---|---|---|---|
| 1 | Cache mounts before auth on every generation route; key strips identity; HITs unbilled | **Live** 2026-11-17 + **live re-verified 2026-11-19** | `solution1-preauth-cache-identity-partition` | [#1](https://github.com/NamanSoni78/pollinationsai/pull/1) (open) |
| 40 | HTTP-200 error completions written to the cache as immutable HITs | Unit red/green (real cache middleware + R2 mock) | `solution34-text-cache-finish-error-gate` | [#45](https://github.com/NamanSoni78/pollinationsai/pull/45) |
| 71 | `content_filter` refusals cached as free HITs (billing classifies the same shape as rejection) | Unit red/green | `solution71-content-filter-cache-refusal` | [#83](https://github.com/NamanSoni78/pollinationsai/pull/83) |
| 15 | EXIF UserComment: unbounded caller text + input media URLs published on the public media host | **Live PoC 2026-11-18 + re-verified 2026-11-19** | `solution15-exif-usercomment-cap-and-url-omission` | [#18](https://github.com/NamanSoni78/pollinationsai/pull/18) |

## Merge guidance for maintainers

1. **PR #1 first** — partitioning the cache by caller identity removes the cross-tenant axis of everything else in this report (keyless replay, poisoning, victim exfil).
2. **PR #45 + #83 together** — they gate *what* may enter the cache (union covers `finish_reason: "error"` and `"content_filter"`); both are independent of #1 and of each other.
3. **PR #18** — EXIF cap + input-URL omission; closes the public-channel axis regardless of cache changes.
4. Cross-report note: the error-completions that poison this cache are themselves served as success on the wire — see **F-12** for the protocol-level handling (issues 41/42/43/59/126).

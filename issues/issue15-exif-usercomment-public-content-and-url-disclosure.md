# Issue: EXIF UserComment publishes unbounded caller text and input media URLs on the public media host

**Severity:** High
**Status:** Confirmed by live PoC with own key (2026-11-18, production `gen.pollinations.ai`)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/18 (branch `solution15-exif-usercomment-cap-and-url-omission`)

## Summary

Every generated JPEG embeds `JSON.stringify({...safeParams, ...resultMetadata})` — the full request prompt and every generation parameter — in its EXIF `UserComment` (`gen.pollinations.ai/src/image/writeExifMetadata.ts`), and the media cache serves that file **publicly** at `media.pollinations.ai/<hash>` with no authentication, `cache-control: immutable`, and a TTL that is **refreshed by any read after day 15** (`shared/r2-storage.ts` — `refreshR2ObjectTtl`), so periodic polling makes the hosted object permanent.

Two concrete problems:

1. **Unmoderated, unbounded content hosting on the platform's domain.** Prompts are allowed up to **32,000 characters** (`shared/schemas/openai.ts:1014,1090`), and the default image models run **no prompt safety scan** (`requireSafePrompt` is only invoked on the GPT-image and nano-banana branches in `createAndReturnImages.ts`; the `content-filter` middleware returns early when no `safe` feature is set). Any caller — the free anonymous tier included — can host an arbitrary 32k-character text payload per request on pollinations' domain: phishing-kit text, C2 configuration, illegal content — attributed to pollinations, never reviewed, kept alive indefinitely.

2. **Input media URL disclosure.** `safeParams` includes the caller's input URLs (`image`, `reference_images`, `reference_videos`, `reference_audios` — `gen/src/image/params.ts:104-120`). A signed URL to a private asset — whose query string can carry session-scoped credentials, which `validateUserMediaUrl` does not inspect (it checks scheme/credentials-in-userinfo/hosts only) — is published verbatim into a publicly readable EXIF field of the output image. Anyone who receives the generated image learns the input URL and its token.

Side effect for honest users: every image shared from the platform leaks its full prompt and input-image URLs to anyone who downloads it.

## PoC (live, own key, one request, non-destructive)

Executed 2026-11-18 against production:

```bash
curl "https://gen.pollinations.ai/image/CANARY-EXIF-PoC-7f3a9b2c%3A%20arbitrary%20unmoderated%20text%20payload%20for%20the%20public%20media%20host" \
     -H "Authorization: Bearer $KEY"
# → 200, JPEG; second identical request exposes the cache object:
#   link: <https://media.pollinations.ai/247b4acf...>; rel="enclosure", x-cache: HIT
curl "https://media.pollinations.ai/247b4acf20bcd52947bd239cd771454be1b94bd5c5e8504d3fa34e5b5ff97f91"
# → 200 with NO authentication; EXIF UserComment contains:
#   {"prompt":"CANARY-EXIF-PoC-7f3a9b2c: ...","originalPrompt":"...","seed":42,
#    "model":"tongyi-mai/z-image-turbo","safe":false,...}
```

The canary appears verbatim in the EXIF of the publicly-fetchable object (`exiftool -UserComment` or any EXIF reader; verified by byte search in the fetched file).

## Impact

- **Platform-hosted unmoderated content channel** (up to 32 KB of arbitrary text per request, anonymous-tier accessible, permanent via TTL refresh) with pollinations attribution.
- **Credential-bearing input URL disclosure** into publicly readable image metadata.
- **Prompt privacy:** full prompt + parameters leak from every shared image.

## Fix

`buildUserComment()` in `gen/src/image/writeExifMetadata.ts`:

- **omits the input URL fields** (`image`, `reference_images`, `reference_videos`, `reference_audios`) entirely — no provenance value for the output image;
- **caps the embedded payload at 4,096 characters** — `prompt`/`originalPrompt` truncated to 1,000 characters with an ellipsis (keeping the JSON parseable), with a hard backstop cut for pathological parameter sets.

Provenance keeps working (model, params, prompt preview embedded); ordinary prompts are byte-identical to before.

Verification after fix: 3 new tests in `writeExifMetadata.test.ts` (input URLs incl. a signed-URL token never embedded; 32k prompt → ≤4,096-char comment with parseable ≤1,001-char prompt; ordinary prompts unchanged); full `test/image/` suite (939 tests) green; `tsc` delta zero.

## Notes

- The broader moderation gap (default image models run no prompt safety scan — affecting pixels as much as text) is a product-level decision; this fix closes the two concrete engineering holes: the unbounded embedded channel and the input-URL disclosure.

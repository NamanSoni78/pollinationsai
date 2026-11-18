# Issue 89 — `amazon/nova-2-lite-v1` advertises 20 reference images; AWS Nova 2 documents 5 — deterministic provider 400 after the full fetch fan-out

- **Severity:** Medium (availability + wasted caller-directed fetch fan-out on a `paidOnly` model: every 6-20 image request downloads all sources, then fails at AWS on all three entry points)
- **Affected:** `shared/registry/text.ts` (`amazon/nova-2-lite-v1` entry, aliases `nova-2-lite`/`amazon-nova-2-lite`/`nova-2`/`nova`), consumed by the capability check (`gen.pollinations.ai/src/text/fallbackCompatibility.ts:137-141`), the image-inlining transform (`text/transforms/imageUrlToBase64Transform.ts:17-24`) and `/v1/messages` oldest-drop (`text/messages/translate.ts:304-318`) — upstream `pollinations/pollinations` main @ `282ac54aeb` (2026-11-18)
- **Fix branch:** `solution79-nova2-reference-image-cap` — fork PR [#101](https://github.com/NamanSoni78/pollinationsai/pull/101)
- **Dedup:** issue 74 (branch `solution66`, unmerged) capped the **video** half of the same AWS limits table at 1 object — its report explicitly recorded the image half as "the registry's `maxReferenceImages: 20` … exceeds Nova 2's documented 5 inline images … left as a doc nit". This issue graduates that note on issue 74's own precedent: a provider-guaranteed 400 for the legitimate case, paid for with an uncapped sequential fetch fan-out first. The registry-lead family (issues 46/49/52/62/70/80) is rate-sheet parity — this is a *request-shape* limit, distinct axis.

## Root cause

The registry entry copied **Claude-on-Bedrock's** Converse image limit:

```ts
maxReferenceImages: 20, // Bedrock Converse image limit.
```

AWS's Nova 2 Developer Guide (multimodal-input limits table, verified against the published PDF) documents Nova's own limits for data **embedded in the request**: images **25 MB total, 5 objects**; video 25 MB, 1 object (the row issue 74 already enforced); S3-backed inputs 2 GB / 1000 objects.

Net effect on unpatched main, for a caller with a funded key sending 6-20 image URLs:

1. `textCapabilityError` counts `image_url`/`input_image` parts against the registry's **20** → passes;
2. `imageUrlToBase64Transform` downloads **every** source sequentially (20 MiB shared byte budget, per-fetch deadline from PR #24's class — but N fetches happen), inlining all of them;
3. Bedrock answers `ValidationException` for the 6th+ inline image — a **deterministic 400 after the platform has paid for all the downloads**.

No fallback rescue exists (`nova-2-lite` has no `fallbacks`), and the failure is unbilled (the caller loses nothing but the platform burns the egress/subrequests — the same amplification framing issue 74 used). All three entry points are affected: `/v1/chat/completions`, `/v1/responses` (both gate on the same registry value) and `/v1/messages` (which keeps all parts up to the registry value before its oldest-drop).

## Safe repro (isolated, red on unpatched main)

```ts
// test/text/transforms/imageUrlToBase64Transform.test.ts (new case)
const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(/* PNG */);
const { options } = resolveModelConfig([], { model: "amazon/nova-2-lite-v1" });
await transform(urls(6), options); // RED on main: converts all 6 (limit read from the registry = 20)
// with the fix: rejects { status: 400, errorCode: "image_too_large" } and fetch was called exactly 5 times
```

A live pre-fix probe (own key, 6 images) would reproduce the AWS 400 post-fetch; the model is `paidOnly` and the isolated test is deterministic, so no live spend was needed.

## Fix

One registry line: `maxReferenceImages: 5` with the vendor citation in a comment. All three entry points fix themselves from the single source of truth:

- the capability check rejects the 6th image **before any fetch** (400 "supports at most 5 reference images");
- the transform's `maxImageUrls` reads the same value (6th image never downloaded);
- `/v1/messages` auto-drops the oldest images beyond 5 (its documented behavior, `omitOldestImages` reads the registry value).

## Tests

New case in `test/text/transforms/imageUrlToBase64Transform.test.ts` — red on unpatched main (the 6-image Nova request converts all 6), green with the fix (6th rejected before it is fetched; exactly 5 fetches asserted). Vendor evidence: AWS Nova 2 Developer Guide PDF (`docs.aws.amazon.com/pdfs/nova/latest/nova2-userguide/nova2-ug.pdf`), multimodal-input limits table — Image / "Embedding data in the request": size 25 MB, **Number of objects: 5**. transforms + messages suites 328/328 green; model-permissions 20/20; `tsc --noEmit` clean.

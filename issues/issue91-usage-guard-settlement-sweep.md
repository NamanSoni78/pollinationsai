# Issue 91 — The usage-guard settlement sweep: every receipt guard that fires after the provider delivered the render

- **Severity:** High (billing integrity: 100% revenue loss per affected request — the class of issues 25/72/81/82/90, at the sites issue 82 explicitly named as its residual plus guard families no prior sweep listed)
- **Affected:** `image/utils/alibabaClient.ts` (`requireAlibabaUsage`), `image/models/alibabaImageModel.ts` (receipt guards), `image/models/alibabaVideoModel.ts` (receipt guards), `image/models/azureMaiImageModel.ts` (`:183-202`), `image/models/azureFluxKontextModel.ts` (`:537-548`), `image/models/seedreamVercelModel.ts` (`:73-83`), `image/models/vercelGeminiImageModel.ts` (`:82-96` + the `:123-141` rewrap), `image/models/vertexAIGeminiImageModel.ts` (`mapVertexGeminiImageUsage` call site), `image/models/openRouterImageModel.ts` (7 guard sites), `image/models/inferencePortImageModel.ts` (`:121-152`) — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution77-usage-guard-settlement-sweep` (name verified unique at push; the number was claimed by a concurrent session's branch, so the report is issue **91** per the round-20 renumber convention) — fork PR [#107](https://github.com/NamanSoni78/pollinationsai/pull/107)
- **Dedup:** issue 81 (PR #89) settled the fal-fallback + model3d post-paid legs; issue 82 (PR #91) settled xAI-image/kling/minimax/sonilo/lyria and the **alibaba no-payload + download** legs; issue 90 settled the route-layer parse/delivery gaps. Issue 82's own text names this branch's scope as its residual: *"the usage-guard family (azureMai/azureFluxKontext/`requireAlibabaUsage`)"* — plus `inferencePortImageModel`'s guards and the OpenRouter/Vercel/Vertex receipt guards no prior sweep listed. This branch deliberately leaves every site those branches fixed untouched (composition discipline): the alibaba no-image/no-video throws and download catches, and the entire fal-fallback/model3d cluster, are NOT in this diff.

## Root cause

`middleware/track.ts:793-798` settles a failed request only from `error.billedUsage`. Every guard in this family throws a 502 **after** the provider already delivered the render — the image/video/payload is in hand, so the provider completed and billed the call — because one receipt field is missing or inconsistent. The thrower discarded every readable leg of the receipt and settled nothing: the platform pays the provider, the caller pays $0.

The paid events per family: DashScope reports `task_status: "SUCCEEDED"` and `callAlibabaMedia` only returns on SUCCEEDED (the image URL / video URL is in hand); Azure MAI/FLUX.2 answered **200 with `data[0].b64_json`** (the render happened; only the `usage`/`request_meta` receipt is unusable); the Vercel AI Gateway resolved `doGenerate`/the chat completion with the image delivered (`data:image/...` verified); Vertex returned `inlineData` before `mapVertexGeminiImageUsage` rejected the usageMetadata; OpenRouter returned `b64_json` (or the Recraft SVG body) before the receipt check; InferencePort answered 200 with the image (a completed, charged job).

## Sites (all verified red on unpatched main)

| # | Family | Guard that fires after the paid event | Settled usage |
|---|---|---|---|
| A1 | Alibaba video | `requireAlibabaUsage` output/input duration guards | requested duration + readable reported legs |
| A2 | Alibaba image | `requireAlibabaUsage` output/input count guards | flat 1 image + readable reported input count / requested references |
| B1 | Azure MAI | `returned no billing metadata` (image delivered); `returned no image` settles readable legs | every readable receipt leg (inputs; output when readable) |
| B2 | Azure FLUX.2 | `returned no billing metadata` after `b64_json` verified, `request_meta` absent | `ceil(requested MP)` output + per-reference input MP capped at the vendor's 4 MP resize ceiling, ceil at the total (mirrors `billableMegapixels`) |
| C1 | Vercel Seedream 5 Pro | image-or-cost guard: image delivered or valid cost in hand | `{ completionImageTokens: 1 }` |
| C2 | Vercel Gemini 2.1 | invalid-usage guard after `data:image/` verified; **plus the rewrap bug**: the catch at `:123-141` rebuilt the UpstreamError and dropped any inner `billedUsage`; the non-filtered no-image leg | readable reported token legs (google first, then the gateway's `usage`) — the prompt rates are equal across modalities on this route |
| D1 | Vertex Gemini | `invalidVertexUsage` after `inlineData` delivered (malformed/missing modality details) | safe-integer top-level counts (`promptTokenCount` → prompt text, `candidatesTokenCount` → completion floor) |
| E1 | OpenRouter Seedream Flash | `usage.cost` invalid/missing after `b64_json` | `{ completionImageTokens: 1 }` |
| E2 | OpenRouter Qwen Image | same | + `promptImageTokens: references.length` on metered routes |
| E3 | OpenRouter FLUX.2 Max | cost guard; **and the unknown-size throw** (`readImageDimensions` failed on the delivered buffer) | delivered/output MP (from the delivered buffer; requested bounds fallback) + reference MP |
| E4 | OpenRouter FLUX.3 | cost guard | `{ completionImageTokens: 1 }` |
| E5 | OpenRouter Gemini | `mapOpenRouterGeminiImageUsage` invalid-usage throws | readable `prompt_tokens`/`completion_tokens` legs |
| E6 | OpenRouter MAI | prompt/image-token receipt guard | readable legs, prompt modality keyed by references (the success path's probe-pinned convention) |
| E7 | OpenRouter Recraft vector | `media_type !== image/svg+xml` — the SVG body was delivered and OpenRouter billed the fixed per-image fee | `{ completionImageTokens: 1 }` ($0.08) |
| I1 | InferencePort image | no-image and no-valid-usage guards (200 = completed charged job) | reported `image_count` when valid, else 1 image |

## Fix

- `requireAlibabaUsage` gains an optional `billedUsage` param attached to its 502 (the guard's own throw site); both call sites in each alibaba model pass the settle computed from readable reported legs + the requested quantity. The no-payload throws and download `.catch` legs are **untouched** (issue 82's branch owns them).
- Azure MAI: `settleMaiUsage(includeOutput)` builds the settle from every `tokenCount`-valid receipt leg; both guards attach it.
- Azure FLUX.2: the guard settles `ceil(w*h/1e6)` from the requested dimensions plus `ceil(Σ min(refMP, 4MP))` over the downloaded references (the vendor-documented 4 MP resize ceiling, ceiled once at the total — the same rounding `billableMegapixels` applies to Azure's own number).
- Vercel Gemini: `settleVercelGeminiUsage(google, reported)` prefers Google's top-level counts, then the gateway usage legs; the guard rides it on the error cause so the rewrap propagates it, and the rewrap now forwards `billedUsage` from both inner shapes; the non-filtered no-image leg settles readable usage (a filtered completion stays unbilled — Google does not bill filtered completions).
- Vertex Gemini: the `mapVertexGeminiImageUsage` call is wrapped; on `invalidVertexUsage` the safe-integer top-level counts settle.
- OpenRouter: `invalidOpenRouterImageUsage` gains the settle param (all 6 call sites pass their success-path usage); FLUX.2 Max's two throws settle delivered/requested MP + reference MP via two new helpers; the Gemini mapper call wraps and settles readable legs; the Recraft media-type throw settles one image.
- InferencePort image: both guards settle reported-then-flat image counts.

## Safe reproduction (isolated, red on unpatched main)

`test/image/usage-guard-settlement.test.ts` — 9 tests (A1, A2, B1, B2, C1, D1, E1, E2, I1), each forcing the exact guard failure with mocked fetch and asserting the exact `billedUsage`. **All 9 fail on unpatched main with `billedUsage: undefined`; all 9 pass on the fix branch.**

`test/image/nanobanana-e2e.test.ts` — the three pre-existing "does not bill failed fallback" cases pinned the old behavior on exactly the fixed Vercel Gemini sites (missing usage / invalid usage / no final image, each with the image delivered): updated to assert **one billed settle event** (`modelProviderUsed: vercel`); a new control keeps the never-answered fallback (503) unbilled.

## Verification

- New suite 9/9 red→green; nanobanana-e2e 21/21
- Full `test/image/` suite: **966/966 green** (49 files)
- `tsc --noEmit` clean; biome clean on all touched files
- No live probes; $0 spend

## Named residuals for the next round

- The Replicate fleet's no-output/download legs and `inferencePortImageModel`'s **download** leg (issue 82's remaining names) — same class, per-model estimate machinery.
- Azure Flux Kontext's three `returned no image` 200-no-payload throws (`:293-299`, `:392-398`, `:524-530`) — no receipt is present on those legs, so nothing is provably billable unless usage data exists in `data` (weaker evidence; document-only).
- MAI output-token count with a fully absent receipt: no in-repo constant documents tokens-per-image for the MAI family, so the output leg is omitted (inputs settle) when `num_output_tokens` is unreadable — partial settlement is strictly better than zero.

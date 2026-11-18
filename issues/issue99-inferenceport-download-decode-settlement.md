# Issue 99 — InferencePort's post-paid download and decode legs: a failed download of the delivered URL (or a decode failure of the delivered b64 payload) settles $0

- **Severity:** Medium-High (billing integrity: 100% revenue loss per affected request — the class of issues 25/72/81/82/91; the exact leg issue 91's "Named residuals for the next round" hands off)
- **Affected:** `gen.pollinations.ai/src/image/models/inferencePortImageModel.ts` — the `else if (imageUrl)` download leg (`:118-119` pre-fix: `(await downloadUserImage(imageUrl)).buffer` with no settlement) and the b64-decode leg (`:117` pre-fix: `base64ToBuffer(encodedImage)` with no settlement) — upstream main @ `282ac54aeb` (2026-11-18)
- **Fix branch:** `solution94-inferenceport-download-settlement` — fork PR [#113](https://github.com/NamanSoni78/pollinationsai/pull/113)
- **Dedup:** issue 91 / PR #107 (`solution77-usage-guard-settlement-sweep`, site I1) owns the **guards** — the no-image 502 (settles reported `image_count`, else flat 1) and the no-valid-usage 502 (settles flat 1). Its own text names this branch's scope: *"inferencePortImageModel's **download** leg (issue 82's remaining names) — same class, per-model estimate machinery."* This companion touches only the two legs that branch does not (line-disjoint — verified against its full diff), and carries the b64-decode leg its list did not name.

## Root cause

InferencePort charges PAYG credits on completed jobs and the usage receipt rides the same response as the image data. When `data[0].url` is present, the completed job's charge has settled provider-side — a failed download of that URL throws with no `billedUsage`. The same holds for a delivered `b64_json` whose base64 fails `base64ToBuffer`'s validation (a 502 with no settlement). `middleware/track.ts` settles only from `error.billedUsage`, so the caller pays $0 for the charged inference.

## Fix

`.catch` around the `downloadUserImage` call and a try/catch around `base64ToBuffer`, each attaching `billedUsage: { completionImageTokens: billableCount ?? 1 }` — the usage receipt (`usage.image_count`) when readable, else the delivered image (the route always requests `n: 1`; the image in hand is itself the proof of the completed, charged job). Composes with PR #107: the receipt is read once before the legs (a region its diff does not touch), and the guards' own settles remain its branch's.

## Safe reproduction (isolated, red on unpatched main)

`test/image/post-paid-failure-settlement-inferenceport.test.ts` — 3 tests: (D1) delivered URL + `image_count: 2` receipt + download 500 → settles `{ completionImageTokens: 2 }`; (D2) delivered URL without a readable receipt + download 500 → settles `{ completionImageTokens: 1 }`; (B1) delivered b64 that fails base64 validation → settles `{ completionImageTokens: 1 }`. All 3 fail on unpatched main (`billedUsage: undefined`); all pass on the fix branch.

## Verification

- New suite 3/3 red→green; existing `inferencePortImageModel.test.ts` 12/12 unchanged; `tsc --noEmit` clean
- No live probes; $0 spend

## Withdrawal record

This round's first attempt (`solution92-inferenceport-image-settlement`, PR #112) also settled the two guards — diff-verified a duplicate of PR #107's site I1 — and was **withdrawn** (PR closed with the cross-reference; branch deleted from the fork, both mine). The delta above is the surviving novel work.

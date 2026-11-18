# Issue 60 — Chat-over-Responses adapter drops `promptVideoTokens` and `completionImageTokens` from billed usage — the same provider usage bills $0 via `/v1/chat/completions` but full rate via `/v1/responses`

- **Severity:** Medium-High (adapter-level undercharge upstream of the registry — even sheets that price the lines bill 0 through this path)
- **Affected:** `gen.pollinations.ai/src/text/responses/chatResponse.ts:64-112` (`chatUsage()` synthesizes the terminal Chat usage chunk billing reads) — upstream `pollinations/pollinations` main @ `52fd0a6c824`
- **Fix branch:** `solution56-responses-chat-usage-parity` — **PR:** [#73](https://github.com/NamanSoni78/pollinationsai/pull/73)

## Root cause

`chatUsage()` copies every token-detail field from the Responses usage object into the synthesized Chat `usage` chunk **except two**: `input_tokens_details.video_tokens` (never copied into `prompt_tokens_details`) and `output_tokens_details.image_tokens` (never copied into `completion_tokens_details`).

The billing normalizer prices both on the pure Responses path: `responsesUsageToUsage` (`shared/registry/usage-headers.ts:314-341`) passes `input_tokens_details` wholesale into `openaiUsageToUsage`, which reads `video_tokens` (`:244`) and output `image_tokens` (`:255`) and prices `promptVideoTokens` / `completionImageTokens`. The Chat path (`middleware/track.ts:1652-1695`) parses the synthesized chunk through the same normalizer — but the fields were already dropped by the adapter.

Result: the identical provider usage object bills its video/input-image and output-image token lines on `POST /v1/responses` but **$0** on `POST /v1/chat/completions` for the same `useResponsesApi` model — the gpt-5.x/6.x Sol/Terra/Luna/Astra/codex family (`availableModels.ts:212-407`) plus community `api:"responses"` gateways. This is not a missing registry rate (issues 34/45/46/47/49/52's class): even models whose sheet carries the lines bill 0 through this path, because the drop happens before the registry sees usage.

**Honest scoping of the live trigger:** `chatToResponsesRequest` rejects `video_url` Chat content parts outright (`responses/chatRequest.ts:162-165`, 400), so the drop fires when a provider attributes tokens to those buckets from accepted content (e.g. `input_file` file-data video at `chatRequest.ts:148-161`) or when a community Responses gateway reports its own usage shape.

## Safe reproduction (isolated, pure unit)

`gen.pollinations.ai/test/text/responsesChatAdapter.test.ts` (new `it.each([false, true])`), **red on unpatched HEAD**:

A completed Responses usage of `{input_tokens: 1000, input_tokens_details: {cached_tokens: 100, image_tokens: 300, video_tokens: 400}, output_tokens: 200, output_tokens_details: {reasoning_tokens: 20, image_tokens: 60}}` driven through `callChatViaResponses` — the synthesized terminal Chat usage frame carries `video_tokens: undefined` / output `image_tokens: undefined` (`expected undefined to be 400`), on both the non-stream completion and the stream terminal chunk. Run the same object through `getResponsesEventUsage` + `calculateUsageBilling` on a video-rated sheet and it bills > 0 — one-sided by construction.

## Fix (`solution56-responses-chat-usage-parity`)

Two lines added to the synthesis: `video_tokens: inputDetails.video_tokens ?? 0` and `image_tokens: outputDetails.image_tokens ?? 0` (stream and non-stream paths share `chatUsage`, so one fix covers both — asserted by the `it.each`). Post-fix the details land in the Chat usage frame on both variants; adapter suites 103/103 (`responsesChatAdapter` + `responsesAdaptedChat` + `responses`), `tsc` clean.

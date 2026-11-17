# Issue: /v1/messages translates finish_reason=error completions into normal end_turn turns

**Severity:** High
**Status:** Confirmed by isolated unit + worker-route tests against `a7aed04e24` (2026-11-18, bug reproduced pre-fix)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/46 (branch `solution35-messages-finish-error-stop-reason`)

## Summary

`stopReason()` (gen `text/messages/translate.ts`) mapped `finish_reason === "error"` to the default `"end_turn"`, and the stream translator only failed on **top-level** `chunk.error`. A failed, truncated generation was translated into a **normal completed Messages turn**: non-stream → `stop_reason:"end_turn"`, stream → `message_delta{stop_reason:"end_turn"}` + `message_stop` with no error event. No protocol field carried the failure at all, so even the fixed SDK/CLI/MCP pattern (which inspects `finish_reason`) cannot detect it — Claude Code / Anthropic SDK users receive half-finished work as a completed turn and an agent loop silently commits partial file edits and keeps going. The request schema explicitly accepts `finish_reason:"error"` (`shared/schemas/openai.ts`: "backends may return various values (stop, length, error, ...)"), so the marker reaches translation untouched. Compounds issue 40: the inner chat completion is cached under the mapped chat key, and every identical Messages request replays the poisoned entry as `end_turn` again. The sibling `/v1/responses` adapter already fails the same shapes (`adaptedChat.ts`: `status:"failed"` + `event: error`), and the route's own docs promise "a failed stream ends with an error event". Not the aca5490521 fix (that kept `length` truncation out of the tool-call error path).

## Root cause

```ts
// text/messages/translate.ts (pre-fix)
export function stopReason(finishReason, hasToolUse) {
    if (finishReason === "length") return "max_tokens";
    if (hasToolUse) return "tool_use";
    if (finishReason === "content_filter") return "refusal";
    return "end_turn";              // ← finish_reason "error" lands here
}
// text/messages/stream.ts — the only failure detector:
if (chunk.error) { fail(...); }     // ← top-level only; nested choice.error invisible
```

## PoC (isolated tests on the real translator + full worker route; pre-fix results)

`gen.pollinations.ai/test/text/messages-finish-error.test.ts`:

- Stream with a terminal chunk `{delta:{}, finish_reason:"error", error:{message:"Provider failed mid-generation"}}` → ends `message_stop` + `end_turn`, **no error event** (bug)
- Non-stream `chatToMessagesResponse` on the same completion → returns `stop_reason:"end_turn"` with partial content (bug)
- Worker-level `POST /v1/messages` (mocked provider returning the 200 error completion) → **HTTP 200** with `"stop_reason":"end_turn"` and `"partial answer"` content (bug)
- Controls: normal turns still translate/stream to `end_turn` correctly

## Impact

Silent data-integrity loss for every Anthropic-protocol consumer: truncated generations delivered as complete, with zero protocol signal. Agent workflows continue on half-finished work (file edits, unfinished tasks).

## Fix

The stream fails with an `error` event carrying the provider's nested message when a choice finishes `finish_reason=error` (message captured from `choice.error`); the non-stream route returns 502 + a Messages error body via a new `completionFinishError()` helper (checked before translation, so the fallback chain still applies); `chatToMessagesResponse()` throws for error completions. New suite 5/5 (route-level case updated to the schema-stripped error message contract); `messages*.test.ts` 66/66; `tsc` clean.

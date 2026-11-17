# Issue: managed prompt-agent runs bill errored completions as successful steps

**Severity:** Medium
**Status:** Confirmed by isolated tests on the real model provider against `a7aed04e24` (2026-11-18, bug reproduced pre-fix)
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/48 (branch `solution37-agent-model-finish-error-gate`)

## Summary

The managed prompt-agent loop (community `prompt_agent` models) calls the gateway's own `/v1/chat/completions` through `@ai-sdk/openai-compatible@3.0.30`. Its finish-reason mapping sends the provider's `finish_reason:"error"` to `"other"`, and `openAIFinishReason()` (shared `agents/model.ts`) maps `"other"` → `"stop"`. An errored, truncated step therefore resolved as a **successful completion**: the run returned its partial output as a finished answer and `strictAgentUsage()` billed the caller for the failed step's tokens. This is the missing consumer of the error-completion gate upstream shipped for the SDK (#19399), MCP (#19584) and CLI (#19796) — the server-side agent loop was never covered. Verified one-line probe on the real module: `openAIFinishReason("other") === "stop"`; the pinned SDK version's mapping was confirmed from the published tarball.

## Root cause

```ts
// shared/agents/model.ts (pre-fix)
export function openAIFinishReason(reason: FinishReason): string {
    if (reason === "tool-calls") return "tool_calls";
    if (reason === "content-filter") return "content_filter";
    if (reason === "stop" || reason === "length") return reason;
    return "stop";                  // ← AI SDK "other" (raw finish_reason "error") lands here
}
```

## PoC (isolated tests on the real provider + the `ai` package; pre-fix results)

`gen.pollinations.ai/test/agent-model-finish-error.test.ts`:

- `generateText` via `createAgentModelProvider` with a fetcher returning the 200 error completion → **resolves** with partial output (bug: expected rejection)
- `streamText` over an SSE stream whose terminal chunk carries `finish_reason:"error"` → **resolves** (bug)
- Control: normal completion → resolves with `"full agent output"`

## Impact

Community prompt-agent models complete runs with garbage while charging the caller for the failed step's tokens — the reverse direction of the unbilled-failure issues (2/25/14), same billing-integrity class.

## Fix

The model provider's metadata extractor now rejects any step whose raw chat body or SSE chunk carries `finish_reason=error` (`finishErrorMessage` reads the nested `choice.error.message`): the extraction throw rejects the SDK's sibling promises, failing the run — the same mechanism the file's own usage-validation comment documents, and the mirror of the SDK's `chatCompletionError`. New suite 3/3; `agent-run-token` + `code-agent` 13/13; `tsc` clean.

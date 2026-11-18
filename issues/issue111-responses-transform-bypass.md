# Issue 111 — the native `/v1/responses` direct path bypasses every model transform: the #19789 effort remaps and the Mistral strip never run on it

- **Severity:** Medium-High (correctness/billing surface — paid-eligible hard failures on a first-class public endpoint; both of upstream's just-landed text fixes (#19789, the Mistral strip guard) are dead on `/v1/responses`)
- **Affected:** `gen.pollinations.ai/src/text/responses/client.ts` (`resolveDirectResponsesTarget` resolves the model config but never runs `modelDef.transform`) and `gen.pollinations.ai/src/text/responses/request.ts:53-92` (`buildDirectResponsesRequestBody` spreads the caller's request raw — only the Alibaba forced-tools override touches `reasoning`). Upstream main `47573fa60b` (2026-11-19).
- **Fix branch:** `solution107-responses-effort-remap` (branch number predates the round-35 renumber; maps to this issue) — **PR:** fork [#126](https://github.com/NamanSoni78/pollinationsai/pull/126) (upstream PR creation remains 403-blocked by the token's `pull_requests:read` scope).

## Root cause

The Chat pipeline runs each model's transform before its provider call:

```ts
// generateTextPortkey.ts:89-96 — the chat path
if (modelDef?.transform) {
    state = await modelDef.transform(messages, state.options);
}
```

The native `/v1/responses` direct path (every model with a `responsesEndpoint`) never does. `resolveDirectResponsesTarget` uses `findModelByName` only to resolve the config, and `buildDirectResponsesRequestBody` forwards the caller's `reasoning.effort` — a free-form string on this endpoint (`shared/schemas/openai.ts:488`, no enum) — untouched. So the same myceli-prod-eastus deployments that the #19789 remaps exist to protect receive the rejected levels raw again on `/v1/responses`:

- `openai/gpt-6.1-sol` / `gpt-6-astra` chat remaps `none → low`; on `/v1/responses` the caller's `reasoning:{effort:"none"}` is forwarded as `"none"` — the Azure 400 the commit fixed, back on this endpoint. Same for `max` on the 2024-12-01-preview family (`gpt-5.4-mini` etc. → `"max"` forwarded raw instead of `xhigh`) and `gpt-oss-20b`'s `none/xhigh/max` remaps.
- `mistralai/mistral-large-3` (Azure deployment that "500s on reasoning_effort" per its own config comment at `availableModels.ts:1519`) gets `reasoning.effort` forwarded raw — the parameter the chat path's `stripReasoning` exists to remove.
- Blast radius: every direct-responses model — Azure GPT-5.x/6.x, grok-4.3/4.6, gpt-oss-20b, mistral-large-3 — including `paidOnly` tiers, on a documented public endpoint. A settled 400/500 (caller-error class, no fallback on the direct path) is a hard user-visible failure.

The adapted paths are unaffected and stay that way: the responses→chat adaptation goes through `generateChatAttempt` (transformed), and the chat→responses adaptation (`callChatViaResponses`) receives post-transform options whose `reasoning_effort` `chatToResponsesRequest` maps into `reasoning.effort` — verified line-by-line this round.

## Safe reproduction (non-destructive)

`gen.pollinations.ai/test/text/responses.test.ts` — `describe("native Responses reasoning-effort remaps (#19789 parity)")` (6 tests, mirroring the existing `authorizedTarget`/`resolveDirectResponsesTarget`/`buildDirectResponsesRequestBody` harness):

- **RED on unpatched main:** the 4 remap tests fail — `responsesReasoningEffortRemap is not a function` (the export does not exist: nothing on the direct path computes a remap; the caller's `"none"`/`"max"`/`"medium"` is what `buildDirectResponsesRequestBody` forwards). This is the production gap expressed as the missing export.
- **GREEN with the fix:** `openai/gpt-6.1-sol` + `effort:"none"` → body `reasoning.effort === "low"`; `openai/gpt-5.4-mini` + `"max"` → `"xhigh"`; `mistralai/mistral-large-3` + `"medium"` → `reasoning` removed entirely; a `reasoning:{effort, summary:"auto"}` keeps `summary` when the effort is stripped.
- **Controls:** an accepted level (`"high"`) is untouched, and a request with no effort gets no `reasoning` added.

No live probe was needed (deterministic offline; the provider 400s are upstream-documented by the #19789 remaps themselves).

## Fix (`solution107-responses-effort-remap`)

Run the model's own transform on the caller's effort for the direct path, exactly as the chat pipeline does, and apply it when building the body:

- `client.ts` — new `responsesReasoningEffortRemap(modelId, request)`: runs `modelDef.transform([], {model, reasoning_effort})` and returns the mapped level, `null` when the transform strips/drops it, `undefined` when the caller sent no effort or the model has no transform (untouched).
- `handler.ts` — in the direct-attempt callback, computes the remap for `attempt.id` and carries it on the target (community-endpoint and adapted attempts are untouched: they have no platform transform).
- `request.ts` — `buildDirectResponsesRequestBody` applies `target.reasoningEffort`: remap to the accepted level, or strip the `effort` key (dropping `reasoning` entirely only when it becomes empty, preserving sibling fields like `summary`). Ordered **before** the Alibaba forced-tools override so that `"none"` still wins last.

`resolveDirectResponsesTarget` stays synchronous (its existing test call sites are unchanged). Verification: the extended suite 49/49; the five neighboring suites (`responsesAdaptedChat`, `responsesChatAdapter`, `static-provider-fallbacks`, `generateTextPortkey`, `responses`) 263/263; `tsc --noEmit` clean.

## Deliberately out of scope

The developer-role rewrite for `mistral-large-3` on the direct path (subagent B's delta): the chat fix gates on the Mistral-API 422 while the direct path hits a different backend (Azure responses), where developer-role rejection is unproven — recorded in the WORKLOG for a future round if evidence lands.

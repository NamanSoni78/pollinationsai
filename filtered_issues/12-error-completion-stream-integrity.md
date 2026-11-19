# F-12 — Provider errors served as success: silent data corruption for every downstream consumer (High)

**Consolidates:** issues [#41](../issues/issue41-messages-finish-error-end-turn.md) (`/v1/messages` maps `finish_reason:"error"` to `end_turn`), [#42](../issues/issue42-text-route-error-completions-as-200.md) (`/text` routes serve error completions as 200 plain text), [#43](../issues/issue43-prompt-agent-bills-error-steps.md) (prompt-agent resolves and bills errored steps), [#59](../issues/issue59-sse-keepalive-parse-crash.md) (one non-JSON SSE frame kills the whole stream), [#126](../issues/issue126-vercelsearch-stream-frame-crash.md) (vercelsearch stream twin + $0 settlement) — 5 issues, one provider behavior, five consumers that all mishandle it: **when a provider returns `finish_reason:"error"` (or a keep-alive frame), the platform serves it, streams it, caches it, and bills it as success.**

(Cache-side members of the same behavior — error completions *cached* as immutable HITs — are consolidated in **F-01**, issues 40/71. Settlement-side members are in **F-04**.)

**Fix PRs:** [#46](https://github.com/NamanSoni78/pollinationsai/pull/46), [#47](https://github.com/NamanSoni78/pollinationsai/pull/47), [#48](https://github.com/NamanSoni78/pollinationsai/pull/48), [#72](https://github.com/NamanSoni78/pollinationsai/pull/72), [#141](https://github.com/NamanSoni78/pollinationsai/pull/141).

---

## What this chain can do, end to end

A provider failure mid-generation is **indistinguishable from success** on four public protocols, and kills the fifth:

1. **Anthropic `/v1/messages` (issue 41):** `stopReason()` maps `finish_reason === "error"` to the default `"end_turn"`; nested `choice.error` is invisible to the stream translator. An agent loop (Claude Code, SDKs) receives a half-finished answer as a *normal turn* — commits the partial file edit and keeps going, with **zero protocol signal** that anything failed. Worker-level test on unpatched main: `POST /v1/messages` with a provider error completion → **HTTP 200 `"partial answer"`**.
2. **Plain-text `/text` routes (issue 42):** the simplest, most widely integrated surface — the only completion-quality gate rejected *empty* completions; a partial one passes and is served as `200 text/plain` with no error channel at all. And every 200 body becomes the cache entry for later callers (ties into F-01).
3. **Managed prompt-agents (issue 43):** the SDK chain maps the provider's `finish_reason:"error"` → `"other"` → `"stop"` (one-line probe on the real module: `openAIFinishReason("other") === "stop"`), so a community prompt-agent run *resolves* with garbage and **bills the caller for the failed step's tokens** — the reverse of the unbilled-failure family.
4. **Any SSE stream through the reasoning-strip transform (issue 59):** an unguarded `JSON.parse` on every SSE data frame — a keep-alive frame, an empty `data:` line, or a torn final event throws out of the TransformStream: client stream dies mid-answer with **no error event and no `[DONE]`**, and the tee'd tracking branch throws inside `waitUntil` so **settlement never runs** (partial content delivered free — the settlement axis is cross-listed in F-04). Publicly triggerable via the passthrough `reasoning.exclude` / `include_reasoning:false` schema; always-on for `mistral-large-4` / `mistral-small-2603`. Verbatim production symptom reproduced in tests: `SyntaxError: Unexpected token 'k', "keep-alive" is not valid JSON`.
5. **The Vercel-search streaming leg (issue 126):** the same unguarded parse plus mid-stream `requireUsage` throws on the platform's main search model — silent truncation after the 200 was sent, and **both paid Vercel generations settle $0**.

**Net effect:** downstream agents and lightweight integrations receive corrupted output as authoritative — the failure mode most expensive to debug, because nothing anywhere says "error".

## Proof (strongest evidence)

**issue 41 — worker-level route test, red on unpatched main:**
```
POST /v1/messages, provider returns finish_reason:"error" + "partial answer"
  unpatched: HTTP 200, stop_reason "end_turn", no error event   (expected 502)
  controls: normal turns translate correctly
  with fix: stream error event + non-stream 502  (5/5 + 66/66)
```

**issue 42 — worker-level, red on unpatched main:**
```
GET /text/<prompt>, provider returns finish_reason:"error" + "partial answer"
  unpatched: HTTP 200, body "partial answer"   (expected 502)
  with fix: 502; full /text suite 958/958
```

**issue 59 — isolated mocked SSE stream, exact production symptom:**
```
stream = keep-alive comment frame + delta + usage + [DONE], reasoning:{exclude:true}
  unpatched: rejects with SyntaxError: Unexpected token 'k', "keep-alive" is not valid JSON
  controls (no transform): byte-identical passthrough
  with fix: frames tolerated, [DONE] synthesized, settlement runs   (82/82)
```

**issue 43 — unit red/green on the real provider + real `ai` package:**
```
generateText with a 200 error completion: RESOLVES with partial output on unpatched main
  (expected: rejection); streamText over an SSE error terminal chunk: also resolves
one-line probe on the real module: openAIFinishReason("other") === "stop"
  with fix: rejects in the metadata extractor  (3/3 + 13/13)
```
Honest label: the billing leg (caller charged for the failed step) is asserted from the `strictAgentUsage` code path, not shown with a billed event.

**issue 126 — red on unpatched main:** reading `result.responseStream` rejects with the production SyntaxError; torn streams and invalid usage shapes tear; with fix, frames pass byte-identically / in-band `usage_missing` event (the sibling contract). 21/21 + 152 sibling tests.

## The chain

```
provider returns finish_reason:"error" (or a keep-alive / torn SSE frame)
        │
        ├── /v1/messages  -> mapped to end_turn, 200 "partial answer"   (41) ──> agents commit garbage
        ├── /text routes  -> 200 text/plain partial answer              (42) ──> curl/SDK integrations get garbage
        ├── prompt-agents -> step resolves; caller billed for it        (43) ──> garbage + charge
        ├── SSE transform -> SyntaxError kills the stream; no [DONE];
        │                    tracking branch throws -> no settlement    (59) ──> silent truncation + free content
        └── vercelsearch  -> same crash + both paid generations $0      (126)
        (and the 200 bodies enter the public cache — F-01, issues 40/71)
```

## Members & fixes

| Issue | Consumer | Verification | Fork PR |
|---|---|---|---|
| 41 | `/v1/messages` adapter (Anthropic protocol) | Worker-level red + unit | [#46](https://github.com/NamanSoni78/pollinationsai/pull/46) |
| 42 | `/text` content routes | Worker-level red | [#47](https://github.com/NamanSoni78/pollinationsai/pull/47) |
| 43 | managed prompt-agent loop | Unit red + module probe | [#48](https://github.com/NamanSoni78/pollinationsai/pull/48) |
| 59 | `transformStreamCompletions` (all chat SSE) | Unit red (verbatim symptom) | [#72](https://github.com/NamanSoni78/pollinationsai/pull/72) |
| 126 | `vercelSearch.ts` streaming leg | Unit red (3+3) | [#141](https://github.com/NamanSoni78/pollinationsai/pull/141) |

## Merge guidance

1. All five are line-disjoint, independent merges. Natural review order: **#46 + #47** (the two protocol surfaces, same gate concept), then **#72 + #141** (the two stream transforms, same frame-tolerance contract), then **#48** (the SDK-chain gate).
2. The `/v1/responses` adapter already handles this correctly — the family's fixes deliberately mirror its contract; a maintainer reviewing #46/#47 against that adapter will see the intended pattern.
3. Pairs with F-01's cache gates (without both, a poisoned entry can be served as a clean `end_turn` forever).

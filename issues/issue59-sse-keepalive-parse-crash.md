# Issue 59 — `transformStreamCompletions` crashes the whole stream on any non-JSON SSE data frame (keep-alive, empty frame, truncated final event) — mid-answer kill + partial content served unbilled

- **Severity:** High (availability + revenue loss): model-agnostic trigger via `reasoning: {exclude: true}` / `include_reasoning: false` on `POST /v1/chat/completions`; always-on for `useMistralChatFormat` models
- **Affected:** `gen.pollinations.ai/src/text/genericOpenAIClient.ts:163-170` — upstream `pollinations/pollinations` main @ `52fd0a6c824`
- **Fix branch:** `solution55-sse-keepalive-parse-guard` — **PR:** [#72](https://github.com/NamanSoni78/pollinationsai/pull/72)

## Root cause

`transformStreamCompletions` — the stream transform applied whenever reasoning is hidden locally or the model uses Mistral chat format — parses every SSE data frame with an **unguarded `JSON.parse`**:

```ts
onEvent(event) {
    let data = event.data;
    if (data.trim() !== "[DONE]") {
        const completion = JSON.parse(data) as ChatCompletion;   // ← throws
        transform(completion);
        data = JSON.stringify(completion);
    }
```

Any frame that is not a JSON completion kills the entire pipe chain: the transform throws inside `parser.feed` inside `TransformStream.transform`, the client's response stream errors mid-answer, `ensureOpenAISseDone`'s flush never synthesizes `[DONE]`, and the tee'd tracking branch throws inside its `waitUntil` — so the billing settlement never runs (the catch at `track.ts:586-590` releases the reservation and emits **no billing row**): the partial content already streamed settles free.

**This is a divergence, not a hypothetical** — four sibling layers in the same pipeline explicitly tolerate the identical frames:
- `chat/usage.ts:49-54` — `try { JSON.parse } catch { return; }`
- `messages/stream.ts:227-231` — catch, *"Non-JSON keepalive or comment payloads carry nothing"*
- `chat/public.ts:98-111` — catch, *"Leave non-JSON events unchanged; validation happens before the tee"*
- `responses/chatResponse.ts` / `responses/adaptedChat.ts` — catch and only fail on `response.*`-shaped frames

Verified mechanically against the bundled `eventsource-parser` dist: `data: keep-alive\n\n`, an empty `data:\n\n`, and a final event force-flushed after an upstream connection reset all dispatch non-JSON events into the unguarded parse.

**Reachability:** (1) any model — the public Chat schema is `.passthrough()`, so `"reasoning": {"exclude": true}` (or `"include_reasoning": false`) routes the stream through the transform (`requestUtils.ts:37 → textGenerationUtils.ts:68-82 → genericOpenAIClient.ts:408-411, 564-571`); (2) always-on for `mistral-large-4` and `mistral-small-2603` (`modelConfigs.ts:595, 1187` set `useMistralChatFormat`) with no caller option.

## Safe reproduction (isolated, no network)

`gen.pollinations.ai/test/text/genericOpenAIClient.test.ts` (new cases), **red on unpatched HEAD** with the exact production symptom:

```
SyntaxError: Unexpected token 'k', "keep-alive" is not valid JSON
```

A mocked upstream SSE stream of `data: keep-alive` + comment frame + normal delta-with-reasoning + usage chunk + `data: [DONE]`, requested with `reasoning: {exclude: true}`: the response stream errors on the first frame. Controls: same stream without `reasoning.exclude` on a non-Mistral model passes byte-identical (no transform); an empty `data:` frame reproduces the same crash with `include_reasoning: false`.

## Fix (`solution55-sse-keepalive-parse-guard`)

Mirrors `chat/public.ts`: wrap parse+transform in try/catch — non-JSON frames pass through **unchanged** (the usage validator and the public stream apply their own validation before/after the tee), `[DONE]` synthesis is unaffected, and reasoning is still stripped from real frames. Post-fix: the keep-alive frame passes through, the delta is transformed, usage and `[DONE]` survive — suite 82/82, `tsc` clean.

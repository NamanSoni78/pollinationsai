# Issue 126 — `vercelSearch.ts` streaming transform crashes the whole public SSE stream on non-JSON frames and missing-usage throws (issue 59's class on the unfiled leg)

- **Severity:** High (availability of a public streaming leg + settlement loss: two paid Vercel generations settle $0 on every torn/keepalive framing event)
- **Affected:** `gen.pollinations.ai/src/text/vercelSearch.ts:112-153` (reached from `google/gemini-2.5-flash-lite:search:vercel`, public aliases `gemini-search`/`google-search`/`gemini-2.5-flash-lite-search`, with `response_format` non-text + `stream: true`) — upstream `pollinations/pollinations` main @ `8fc4c212a4`
- **Fix branch:** `solution126-vercelsearch-stream-frame-guards` — fork PR [#141](https://github.com/NamanSoni78/pollinationsai/pull/141)
- **Dedup:** issue 59 covers `genericOpenAIClient.ts` `transformStreamCompletions` only (the fork fix did not touch vercelSearch — verified by branch diff); issue 88 covers the **non-streaming** settlement sites (`:83-98`, `:101`) and explicitly records the streaming legs as a deliberately-untouched residual; issue 123 is the TTS inline-JSON family; issue 41 the messages finish/error translation. The streaming **crash/teardown** half on this leg was never filed.

## Root cause

The Vercel two-step search path pipes the formatting step's SSE through a `TransformStream` whose `createParser({ onEvent })`:

1. `vercelSearch.ts:119` — `const chunk = JSON.parse(event.data)` **unguarded**: a keep-alive frame (`data: keep-alive`), an empty `data:` line, or a final event force-flushed truncated by an upstream connection reset (the flush at `:148` feeds `"\n\n"`, force-dispatching the partial event) throws a raw `SyntaxError` out of `parser.feed` → out of `TransformStream.transform` → the piped stream errors;
2. `vercelSearch.ts:115` (`[DONE]` handler) and `:150` (flush) — `requireUsage({ usage: lastUsage })` throws a raw `UpstreamError` mid-stream when terminal usage/charge is missing;
3. `vercelSearch.ts:126` — `requireChatCompletionUsage(chunk)` throws mid-stream on an invalid usage shape.

Every one of these tears the caller's already-200'd stream mid-answer: the client connection dies with **no error event and no `[DONE]`** (silent truncation), and the tee'd tracking branch throws inside its `waitUntil` → the catch at `middleware/track.ts:586-590` releases the budget reservation and emits **no billing row** — the **two paid Vercel generations** (the search step's `usage.cost` was already required > 0 by `requireUsage` at `:81` before the formatting step ran) settle $0.

This is a **divergence, not a hypothetical** — every sibling layer in the same pipeline explicitly tolerates the identical frames and converts missing terminal usage to an in-band error event: `chat/usage.ts:49-54` (`try { JSON.parse } catch { return; }`), `chat/public.ts:98-111` (non-JSON passthrough), `messages/stream.ts:227-231`, `chatResponse.ts:472-482` — and `requireChatStreamUsage` (already wrapped around this exact stream at `text/handler.ts:456-458`) converts its own usage-missing gate into the in-band `usage_missing` event instead of tearing.

## Safe reproduction (deterministic offline; $0 live)

`gen.pollinations.ai/test/text/vercelSearch.test.ts`, 3 new cases + 3 updated pins, **red on unpatched `8fc4c21`**:

1. non-JSON passthrough — step-2 SSE containing `data: keep-alive`, an empty `data:` line between delta chunks, then valid usage + `[DONE]`: reading `result.responseStream` rejects with the production `SyntaxError` (red); after the fix the frames pass through byte-identical and `[DONE]` survives;
2. torn stream — step-2 SSE closes after one partial delta frame (no usage, no `[DONE]`): the flush's `requireUsage` throw tears the stream (red); after the fix the in-band `usage_missing`/`upstream_error` event is emitted;
3. invalid usage shape mid-stream — a usage frame with string-typed token counts tears the stream at `:126` (red); after the fix the frame passes through and the stream still completes with summed usage + `[DONE]`.

The three pre-existing tests that pinned the hard rejection (`fails a stream missing final token usage or charge`) are updated to pin the graceful in-band event instead (the contract every sibling layer already implements).

## Fix (`solution126-vercelsearch-stream-frame-guards`)

Mirrors the sibling conventions exactly: non-JSON frames pass through unchanged (`chat/public.ts` convention); an invalid usage shape mid-stream passes through for the terminal gate to decide; missing usage/charge at `[DONE]` and flush emit the in-band `usage_missing` error frame (dropping `[DONE]`, exactly what `requireChatStreamUsage` does) instead of throwing — guarded against double emission by a `usageErrorSent` flag.

## Verification

Suite 21/21 green (18 pre-existing + 3 new; the 3 updated pins assert the in-band event); sibling suites `streamUsageFraming` + `publicChat` + `genericOpenAIClient` 152 green; `tsc --noEmit` clean.

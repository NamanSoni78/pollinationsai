# Issue 114 — the Responses→Chat adapter rebuilds the accumulated `tool_calls` array per item: one anonymous ≤32 MiB `/v1/responses` body burns quadratic CPU and pins the isolate before any upstream call or billing

- **Severity:** High (anonymous, pre-billing, per-request CPU DoS — a single request from one IP pins the worker isolate for tens of seconds; deterministic and measured on the real module)
- **Affected:** `gen.pollinations.ai/src/text/responses/adaptedChat.ts:141-146` (the `chatMessages` accumulation loop), reached via `responsesToChatRequest` (:231) ← `text/responses/handler.ts:203-205` ← `routes/generation-executor.ts:126-137` (`POST /v1/responses` behind `textBodyLimit` 32 MiB); input schema `shared/schemas/openai.ts:486` (`input: z.union([z.string(), z.array(z.unknown()).min(1)])` — **no item-count cap**). Upstream main `459b7c41c` (2026-11-18 16:43 UTC).
- **Fix branch:** `solution111-adaptedchat-quadratic-toolcalls` (branch number predates the round-36 renumber; maps to this issue) — **PR:** fork [#129](https://github.com/NamanSoni78/pollinationsai/pull/129) (upstream PR creation remains 403-blocked by the token's `pull_requests:read` scope).

## Root cause

For every consecutive `function_call` item in the request `input`, the adapter rebuilds the accumulated array with a full spread copy:

```ts
const previous = messages.at(-1);
if (previous?.role === "assistant") {
    previous.tool_calls = [
        ...(previous.tool_calls ?? []),
        toolCall,
    ];
}
```

n consecutive calls ⇒ n(n+1)/2 element copies (plus the same array re-allocation churn). The only bound on n is the 32 MiB text body: ~40 bytes per minimal item (type, unique `call_id`, name, empty arguments — unique ids are enforced by the adapter's own `callIds` set, which is O(1) per item) puts ~100-150K items in a ~4-6 MB body. Above ~150-200K items `validateDirectResponsesRequest`'s own `pending.push(...value)` (`responses/request.ts:38`) throws the V8 spread-arg `RangeError` — which converts the very worst bodies into fast 500s, leaving the ~150K ceiling as the exploitable range.

The loop runs **inside request adaptation, before any upstream provider call and before billing settlement** — and `/v1/responses` is reachable anonymously (anonymous callers skip the balance gate at `generation-access.ts:43`; every chat-only model advertises the endpoint via `model-registry.ts`'s adapted path). The edge rate limiter bounds request *rate*, not per-request CPU. One request holds the isolate until the per-request CPU limit kills it; sustained at limiter-allowed rates this saturates worker capacity.

**Measured on the bundled real module** (esbuild, unmodified source, minimal `function_call` items): 20K items → 1.1 s; 50K → 9.6 s; 100K → 40.7 s; 200K → 173.7 s (perfect ×4 per doubling — the quadratic signature; the 200K point additionally hits the `request.ts:38` RangeError in the harness, mirroring the production fast-500 conversion).

## Attack path (safe, non-destructive form)

`POST /v1/responses` with `model` = any non-native chat model and `input` = an array of 100K minimal `{"type":"function_call","call_id":"a<i>","name":"a","arguments":""}` items (~6 MB, well under the 32 MiB limit): the adapter burns ~40 s of CPU before the request ever reaches a provider or the billing path. The offline unit test reproduces the same complexity differential with zero provider spend.

## Safe reproduction (deterministic offline)

`gen.pollinations.ai/test/text/responsesAdaptedChat.test.ts` — two new tests:

- **"accumulates a long parallel tool-call batch without quadratic rebuilds"** — a machine-speed-independent complexity assertion: time 10K-item and 40K-item batches and require the elapsed ratio to stay under 10 (quadratic ≈16×; linear ≈4×), plus structure assertions (single assistant message, `tool_calls` length 40K, first/last ids in order). **RED on unpatched main** (measured ratio ~15; the earlier absolute-threshold variant measured 50K ≈ 2.5-9.6 s on unpatched code vs ~0.1 s patched); **GREEN with the fix** (23/23).
- **"keeps parallel calls in one assistant message in order"** — pins the byte-identical output contract for a 3-call batch (order, ids, `content: null`).

Blast-radius controls: the full `test/text/` directory 36 files / 993 tests green on the fix branch; `tsc --noEmit` clean; biome clean. Live probes: $0 (the CPU-DoS is fully deterministic offline; no provider or billing interaction is needed to demonstrate it).

## Fix (`solution111-adaptedchat-quadratic-toolcalls`)

One line in `adaptedChat.ts:141-146` — append in place instead of rebuilding:

```ts
(previous.tool_calls ??= []).push(toolCall);
```

**Safety:** the assistant message and its `tool_calls` array are adapter-owned (`messages.push({ role: "assistant", content: null, tool_calls: [toolCall] })`); a user-supplied `type: "message"` assistant item goes through `chatContent(item.content)` and carries `content`, never `tool_calls`, so `??=` always allocates a fresh array when the previous assistant message is user-supplied — no user object is ever mutated. Output is byte-identical; complexity becomes O(n).

## Dedup notes

- Checked against the full registry (issues 1-112): not covered — issue 68 covers route *throttling* (the unthrottled `/v1/messages` parse class), not algorithmic per-request CPU; issues 56/100/105/108/109 are body-*size* parse mounts; issue 59 is an SSE parse crash; issues 40/41/42 the text error funnel; issue 60 the responses usage-detail drop. The concurrent round-35 issues 111/112 own the **native** `/v1/responses` path (transform bypass / effort mapping in `responses/client.ts` / `request.ts` / `handler.ts`) and explicitly record the adapted path as out of their scope ("The adapted paths are unaffected and stay that way" — issue 111's own text); this finding is the adapted path's accumulation loop in `adaptedChat.ts`, file-disjoint from every round-35 branch.

## Deliberately out of scope

- The `pending.push(...value)` / `toolMedia.push(...output...)` V8 spread-arg `RangeError` above ~150K items (fast-fail 500 noise with no CPU amplification — below gate; an input item-count cap in the schema would be defense-in-depth and would also bound the quadratic by construction).
- The `validatedSSEStream` pending-buffer re-scan quadratic on boundary-free streams (below-gate observation of the same round's C-sweep: rides the already-filed unbounded-community-response family, issues 4/22/26 — but a byte cap alone still leaves n² scan cost, so that family's fix should also bound the pending buffer).

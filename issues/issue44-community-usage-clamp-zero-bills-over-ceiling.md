# Issue: the implausible-usage clamp zero-bills honestly-reported over-ceiling generations (caller-forcible free service)

**Severity:** High
**Status:** Confirmed by isolated probes on the real `trackResponse` + capability-check modules against `a7aed04e24` (2026-11-18); billing side pinned by the repo's own suite
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/49 (branch `solution38-community-usage-clamp-bill-min`)

## Summary

The implausible-usage guard (`middleware/track.ts`) zeroes the charge of any community proxy text claim past its ceilings (2M prompt / 200k completion tokens) — correct anti-fraud for lying endpoints. But nothing stopped the **caller** from legitimately producing that much work, so an *honest* proxy that honored such a request delivered the full generation with the charge dropped after the response was already served:

- `max_tokens`/`max_completion_tokens` had no server-side maximum (`ChatOutputTokenLimitSchema`: `z.number().int().min(0)`; no community-model cap in the parameter processor)
- prompt bodies up to 32 MiB carry ≫2M tokens, while registration advertises community contexts up to 10M tokens — **5× the billing ceiling** (legitimate long-context models can never be billed above 2M prompt tokens)

Consequences per request: the caller's content is free (a community model at the registration-max $50/1M tokens delivering a `max_tokens=250001` run ≈ $12.5 of generation free; a junk-padded ~8 MB prompt makes any answer free), the publisher pays 100% of the compute, the owner's 75% earnings and the platform's cut are both zero. Repeatable; community `perUserRpm` may be `null`.

## Root cause

```ts
// middleware/track.ts — the guard itself (correct for lying endpoints):
return (prompt > MAX_PROXY_PROMPT_TOKENS || completion > MAX_PROXY_COMPLETION_TOKENS);
// → notBilled({ responseStatus: 502, errorTracking: { errorResponseCode: "usage_invalid" } })
//    (settle runs in waitUntil AFTER the 200 body was already delivered)

// and no request-side gate: the platform knowingly accepts requests whose
// honest billing it will refuse.
```

Isolated probe on the real `trackResponse` with a real community proxy candidate: `{prompt_tokens:100, completion_tokens:250000}` → `isBilledUsage:false, code "usage_invalid"`; `{prompt_tokens:2500000, completion_tokens:50}` → same.

## PoC (isolated tests on the real capability check; pre-fix results)

`gen.pollinations.ai/test/community-proxy-request-gates.test.ts`:

- proxy model + `max_tokens`/`max_completion_tokens`/`max_output_tokens` = 200,001 or 250,001 → capability check **returns undefined** (accepted; bug: such a request is unbillable if honored)
- ~2.25M-token prompt → accepted (bug)
- Controls: at/below ceiling accepted; non-community models unbounded; image/file payloads excluded

## Impact

Caller-forcible free service against any honest community text endpoint; publisher + platform revenue loss on the entire over-ceiling class.

## Fix

Gate those requests up front: the shared text capability check (already run on `/v1/chat/completions`, `/v1/messages` and `/v1/responses`) refuses proxy models a completion budget above 200k tokens and a conservative prompt estimate above 2M tokens (text characters / 4, skipping image/audio/file payloads billed by their own units). The ceilings are shared with the billing guard via new `MAX_COMMUNITY_[PROMPT|COMPLETION]_TOKENS` constants in `shared/community-endpoints.ts`, so the two sides can never drift. Agent-run endpoints report usage through their own path and are exempt; official models keep OpenAI-compatible semantics; a proxy still claiming past the ceiling is now by definition lying, and the zero-charge guard keeps protecting the caller from exactly that. New suite 6/6; `static-provider-fallbacks` + `tracking-observability` + transforms 510/510; enter community suites 72/72; `tsc` clean.

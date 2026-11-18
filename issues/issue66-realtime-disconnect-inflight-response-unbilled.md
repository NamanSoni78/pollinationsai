# Issue 66 — Realtime sessions bill $0 for the in-flight response when the client disconnects before `response.done`

- **Severity:** High (systematic under-billing on a production route; caller-exploitable; live-verified)
- **Affected:** `gen.pollinations.ai/src/routes/realtime.ts` — `wireClose` (:1014-1031, wired both directions at :1161-1162), `collectBillingEvents`/`extractResponseBilling` (:632-640, :922-953), `settleRealtimeSession` (:834-853) — upstream `pollinations/pollinations` main @ `52fd0a6c82` (2026-11-18)
- **Fix branch:** `solution55-realtime-disconnect-grace-settlement` — **PR:** [#78](https://github.com/NamanSoni78/pollinationsai/pull/78)
- **Relationships:** distinct from the per-second preflight/reservation family (issues 32/35/39 — reservation *sizing*) and from the error-path billing family (issues 2/25/53 — provider *error* receipts); this is the **client-abort receipt-loss** path, unfiled before.

## Root cause

Azure/OpenAI Realtime report a response's usage **only** in its terminal `response.done` event, which is emitted after every `response.audio.delta` / `response.output_audio.delta` has already been streamed to the client. The proxy's `wireClose` handler, wired for **both** socket directions, closed the *upstream* socket and called `scheduleRealtimeSettlement` the moment the *client* disconnected — settling with only the usage accrued so far. `settleRealtimeSession` with no positive usage releases the reservation, marks `settled = true`, and charges **nothing**; the late `response.done` can no longer revive settlement. The sockets were already accepted with `allowHalfOpen: true`, but the client-close path never used it.

## Impact

- **Exploitable, repeatable:** request a response, collect the audio deltas, close the socket before `response.done` → the delivered response (audio + its full-context input tokens — the largest usage chunk of a long session) bills **$0**. No per-user RPM applies to realtime models; only connection-level limits.
- **Organic leakage:** every voice-app user who closes the tab mid-reply gets that response free.
- **Live-verified on production** (own bounty key, non-destructive, `openai/gpt-realtime-2.1`, `paidOnly:false`):
  - CONTROL (socket kept open until `response.done`): balance `1.92783885 → 1.92458385`, **−0.00325500** billed (27 input / 19 text + 59 audio output tokens).
  - EXPLOIT (identical request, socket closed immediately after the first `response.output_audio.delta` — audio delivered): balance delta **+0.00000000**.
  - PoC script: `scripts/poc_realtime_disconnect.py` (session.update `type:"realtime"` → conversation.item.create → response.create → abort on first audio delta; balance read from `enter.pollinations.ai/api/account/balance`).

## Fix

Track in-flight responses (`response.created` vs terminal `response.done`/`response.failed`/`response.cancelled`). On a client disconnect with a response in flight, complete the client's close handshake but keep the half-open upstream for a bounded **5 s grace window**; settle when the receipt arrives (early, once nothing is in flight), when the upstream closes, or when the window expires. Idle disconnects (nothing in flight) keep the old immediate settlement — including the Azure close-handshake reply, which the refactor preserves. A follow-up `error` event for the same disconnect can no longer cancel the grace (the running window owns the upstream's fate).

## Tests (red → green)

Three new tests in `gen.pollinations.ai/test/realtime.test.ts` (suite **46/46** green, `tsc --noEmit` clean):

1. **bills the in-flight response when the client disconnects before `response.done`** — pre-fix the settlement ran with zero accrued usage (reproduced: no telemetry row, balance untouched); post-fix the receipt is accrued and billed (`totalPrice = 0.003553 × 0.75`, audio tokens present).
2. **still settles immediately when the client disconnects with no response in flight** — the upstream closes and the reservation releases within the 200 ms poll window (no grace wait; regression guard).
3. **settles at the grace deadline when the provider never sends the receipt** — upstream closed and reservation released at ≈5 025 ms; no unbounded hold.

# Issue: Stripe refunds and lost chargebacks never reverse credited Pollen

**Severity:** High (monetary integrity)
**Status:** Confirmed by code-path tracing at upstream `549feee` and pinned by integration tests (2026-11-18). Deferred triage candidate #72 from round 1 / FINDINGS registry entry R3-D1 from round 7 session 3 — both recorded, never filed or fixed; now verified at HEAD and resolved by this issue.
**Fix:** PR https://github.com/NamanSoni78/pollinationsai/pull/27 (branch `solution17-stripe-refund-pollen-reversal`)

## Summary

The only balance write a pack purchase performs is the **credit** on `checkout.session.completed` — `creditCheckoutSessionOnce` (`enter.pollinations.ai/src/routes/stripe-webhooks.ts:207-267` at the audited baseline) inserts `stripe_checkout_credits` and adds the pack's fixed USD amount to `pack_balance`. For the money-back paths:

- `refund.created` / `refund.updated` / `refund.failed` (`stripe-webhooks.ts:841-865`) are **analytics-only** (Tinybird event; no D1 write)
- `charge.dispute.*` falls into the unhandled `default` (`:867-868`)
- a repo-wide scan finds **every** `pack_balance` write is a credit — checkout, auto-top-up, x402 — no reversal path exists anywhere

The fraud-ban tooling (`stripe-fraud-ban.ts`) requires a Radar threshold **and** a `reason === "fraudulent"` dispute and only bans access — it never claws back, and ordinary (non-fraudulent) refunds bypass it entirely.

**Exploit:** buy a $100 pack → 100 Pollen credited on webhook → spend on generations → request a Stripe refund (or lose a chargeback) → the USD returns to the buyer's bank while the Pollen and the spend stay. The platform is out the money and the compute, repeatable per pack purchase.

## Verification (non-destructive, isolated)

1. Code-path evidence above, read in full at `549feee`.
2. Integration tests over the signed webhook route (`enter.pollinations.ai/test/stripe-refund-reversals.test.ts`, mocked Stripe API + real D1 with migrations): a completed full refund debits the credited amount **exactly once**; a replayed duplicate delivery of the same refund is a no-op (idempotent by refund id); partial refunds scale to their share of `session.amount_total` and the cumulative clamp prevents over-reversal across several partials; a `pending` refund and a refund on a non-checkout PaymentIntent reverse nothing; a **lost** dispute reverses while a **won** dispute keeps the credit. On unpatched HEAD none of these events touch `pack_balance` — that is the gap the fix closes.
3. Regression on the fix branch: `integration/stripe` 105/105, `fraud-ban` and `quests` (58/58) suites green; `tsc --noEmit` introduces no new errors (the two pre-existing frontend-lib errors are present on unpatched `main` as well).

Not live-tested: triggering a real refund or dispute against production Stripe is outside the non-destructive probe envelope.

## Impact

- Money-back fraud: buyers keep Pollen spend after a Stripe money-back; each abuse cycle costs the platform the pack value plus generation compute.
- Accounting integrity: credited Pollen silently diverges from actually-collected USD.

## Fix

`refund.created`/`refund.updated` with `status === "succeeded"` and `charge.dispute.closed` with `status === "lost"` now resolve the pack checkout through the PaymentIntent the event carries (`checkout.sessions.list({ payment_intent })` — a documented Stripe filter), scale the reversal to the refunded share of `session.amount_total`, clamp it against earlier partial reversals for the same session, and debit `pack_balance` once per refund/dispute id. The new `stripe_refund_reversals` table (PK = refund/dispute id) makes webhook replays idempotent exactly the way `stripe_checkout_credits` makes credits idempotent; the write is a single D1 batch mirroring the credit path and resets `low_balance_notified_at`. Won disputes, pending refunds, and events whose PaymentIntent belongs to no pack checkout (subscriptions, invoices) reverse nothing; reversal errors propagate so Stripe retries the webhook. Migration `0083_stripe_refund_reversals.sql`.

## Notes

- A reversal may drive `pack_balance` negative when the Pollen was already spent — consistent with the platform's documented overdraft semantics for generations.
- The fraud-ban tooling remains the complementary access control for fraudulent disputes; this fix is accounting-only and deliberately does not change ban behavior.

# Issue 101 — Azure realtime: the API-key budget reservation runs after the provider upgrade and outside the socket-closing try — budget-exhausted upgrades leak provider sessions

- **Severity:** Medium (provider capacity exhaustion by an authenticated caller within the edge IP rate limit; the defect itself is deterministic)
- **Affected:** `gen.pollinations.ai/src/routes/realtime.ts` — the Azure branch of `handleRealtimeWebSocket` (pre-fix `:1601-1616`): `connectAzureRealtime` completes the provider WebSocket upgrade, then `reserveApiKeyBudget` throws `keyBudgetExhausted` (HTTP 402) outside the try/catch that closes `upstream` — upstream `pollinations/pollinations` main @ `a21005d397` (2026-11-18)
- **Fix branch:** `solution101-realtime-budget-reserve-ordering` — fork PR [#115](https://github.com/NamanSoni78/pollinationsai/pull/115)
- **Dedup:** the scribe branch in the same function (`:1591-1598`) already reserves before any socket exists — only the Azure branch is affected. Issues 55/57/84 cover the disconnect-grace settlement, edge-limiter coverage and scribe queue cap — no prior branch covers the reserve-after-upgrade leak.

## Root cause

```ts
const upstream = await connectAzureRealtime(c, userId, ...);  // upgrade completes
if (upstream instanceof Response) return upstream;
await reserveApiKeyBudget(c.var, c.env);                      // THROWS 402 — outside the try
tracking.apiKeyReservedAmount = ...;
try {
    return proxyRealtimeWebSockets(c, upstream, tracking);
} catch (error) {
    await releaseApiKeyBudgetReservation(c.var, c.env);
    closeSocket(upstream, 1011, "Unable to start realtime session");  // never reached for the 402
    throw error;
}
```

`reserveApiKeyBudget` fails whenever the atomic reserve (`atomicReserveApiKeyBalance`) cannot take the estimate from the key's remaining budget — a routine outcome for finite-budget keys racing another request (the preflight in `requireFunds` reads the auth-time snapshot, the reserve reads D1 atomically). When it throws, the client correctly receives the 402, but the already-completed Azure session is never accepted or closed — it dangles until the runtime reaps the isolate. A caller with a nearly-exhausted key can repeat this within the 10 req/s edge IP limit, pinning the shared Azure deployment's concurrent-session capacity for all users.

## Safe repro (isolated, red on unpatched main — deterministic two-request orchestration)

New case in `test/realtime.test.ts`: one key holds `pollenBudget: 0.6` against a model-stats estimate of 0.5. Request A parks its mocked upgrade until request B's auth snapshot is loaded (observed via B's balance-check model-stats fetch), then reserves (D1: 0.6 → 0.1) and opens its session. Request B — whose preflight saw the full 0.6 — parks its upgrade until A's reservation is visible in D1, completes the upgrade, then fails its own reserve. On unpatched main: B gets the 402 with body `exhausted by another request` while B's upstream socket stays `OPEN` (readyState 1) — the leak. With the fix: `CLOSING`/`CLOSED`.

## Fix

Wrap the reservation in try/catch that accepts and closes the upstream session with 1011 before rethrowing the 402 — the caller sees the identical error while the provider session is released. The socket is not accepted until `proxyRealtimeWebSockets` runs, so the catch performs the first `accept()` for the close (the already-accepted case is swallowed).

## Tests

1 new deterministic case (red on unpatched main, green with the fix); full realtime suite 44/44; `tsc --noEmit` clean. Live probes: $0.

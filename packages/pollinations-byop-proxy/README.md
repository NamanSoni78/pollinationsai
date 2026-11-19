# pollinations-byop-proxy

BYOP ("bring your own Pollen") metering proxy for Agent Ground. It fronts
`https://gen.pollinations.ai` with the user's API key, gives the session a
git-ready identity, costs responses from `usage` x model pricing, and enforces
a hard Pollen budget: 75% -> `conservation`, 90% -> `wrapup`, 100% -> `cutoff`
(metered calls then get `402 {"error":{"code":"insufficient_pollen",...}}`;
`/account/*` and `/v1/models` keep passing through).

## Use

```js
import { createByopProxy } from "pollinations-byop-proxy/src/index.js";
const proxy = await createByopProxy({ apiKey, maxPollenBudget: 5 });
// proxy: { port, server, events, state, setBudget(n), topUp(n), identity(),
//          ledger(), reconcileNow(), stop() }
```

- Unmetered pass-through (caller's own credentials): `/account/*`, `/v1/models`.
- Metered (sent with `Authorization: Bearer <apiKey>`): `/v1/chat/completions`,
  `/v1/responses`, `/v1/messages`, `/v1/embeddings`, `/text*`, `/image*`,
  `/audio*`, `/video*`, `/realtime*`.
- Responses without `usage` (or unknown models) are ledgered as `mode:"reconcile"`;
  the live balance is polled every `reconcileMs` (default 15000) and
  `spent = max(spent, baseline - balance)`.
- Events on `proxy.events` (payloads `{type, at, ...}`): `budget.threshold
  {level, pct}`, `budget.cutoff {pct:100}`, `budget.resumed {maxPollen}`.
- `GET /internal/state` -> `{maxPollen, spent, pct, phase, identity, ledger}`
  (last 20 entries). The API key is kept in memory only, never in state.
- Listens on `127.0.0.1`; WebSocket upgrades (e.g. `/realtime`) are not relayed.

## Env

- `AGENT_BYOP_PORT` — listen port (default 8878; `options.port` wins, `0` = ephemeral).
- `POLLINATIONS_BASE_URL` — upstream base (default `https://gen.pollinations.ai`).

## Test

`npm test` — fully offline: GEN is stubbed with local `node:http` servers and
fake keys (`node --test test/*.test.js`).

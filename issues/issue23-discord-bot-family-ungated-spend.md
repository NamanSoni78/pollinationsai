# Issue 23 — `discord-bot-family` answers every human mention, reply, DM, and conversation-channel message with an ungated platform-keyed paid completion

- **Severity:** High (unbounded platform spend of the shared `TEXT_POLLINATIONS_TOKEN` by any Discord user; production-deployed fleet)
- **Affected:** `apps/discord-bot-family/src-functional/bot-loop.ts` + `api.ts` — upstream `pollinations/pollinations` main @ `30ae4da`
- **Fix branch:** `solution23-discord-family-spend-gating` — **PR:** [#31](https://github.com/NamanSoni78/pollinationsai/pull/31)

## Root cause

The family's five bots (kimi, gemini-search, perplexity-fast, deepseek, minimax — `start-all.js`) run in production on the `monitoring-agents` EC2 box as systemd unit `discord-bots.service` (`README.md`, `systemd/discord-bots.service`), each answering with the **shared platform key**:

```ts
// apps/discord-bot-family/src-functional/api.ts:19,50-56
// No rate limiting needed - let the API handle concurrent requests
...
const requestPromise = axios.post(url, requestData, {
    headers: {
        Referer: "roblox",
        Authorization: `Bearer ${process.env.TEXT_POLLINATIONS_TOKEN}`,
    },
});
```

The only spend controls in `processMessage` never touch the highest-volume paths:

```ts
// bot-loop.ts:328-329 — the sole rate limit, and it excludes directed traffic
// Stateless rate limit: only applies in global channels, not when directly addressed
if (!isDirected && isGlobalChannel && "messages" in msg.channel) { ... }
```

```ts
// bot-loop.ts:349-356 — the 2% gate likewise applies only to ambient traffic
} else if (isGlobalChannel && !isDirected) {
    if (Math.random() > 0.02) { ... return; }
}
// Human mentions and DMs: always respond
```

So every **mention** (any server the bots are in — anyone can add them via their own `!invite` link), every **reply to the bot**, every **DM** (DirectMessages intent + partials enabled), and every message in a bot's **conversation channel** triggers one paid completion packing up to 8 history messages × 4,000 chars — with **no per-user cap, no cooldown, no authz on who can spend**. This is the same gap issue 18 closed for catgpt-bot / opposite-prompt-bot; that fix's commit message even cites *"the per-channel rate limits the discord-bot-family bots already enforce"* — which never covered directed traffic.

## Safe reproduction (isolated unit tests, no Discord, no paid APIs)

`processMessage` takes `generateText` as a parameter, so the spend path is drivable offline with a recording stub (mock `Message`/`Client` objects, `node --test` via `tsx`):

1. On unpatched main, ten rapid DMs from one user each invoke `generateText` → ten platform-keyed completions. With the fix, only the first spends; the rest are skipped until the window elapses, then one more.
2. On unpatched main, a conversation-channel message from the same user back-to-back spends twice. With the fix, once per window.

## Fix (`solution23-discord-family-spend-gating`)

`processMessage` now enforces **one billed reply per user per bot per 60 s window** across all qualifying paths (mentions, replies, DMs, conversation channels):

- cooldown key `${config.name}:${author.id}` — a user conversing with several family bots still gets one reply from each (bounded at 5 replies/min/user across the fleet), and the free `!guilds`/`!invite`/`!permissions` commands stay outside the gate;
- `ProcessMessageOptions { cooldownMs, now }` injectable for tests, mirroring the catgpt-bot `createMessageHandler` seam;
- the cooldown map is capped at 5,000 entries like the sibling handlers.

## Verification

`npm test` in `apps/discord-bot-family` (`tsx --test src-functional/bot-loop.test.ts`): **5/5 passing** — rapid DMs spend once then re-arm after the window; per-user and per-bot budget isolation; conversation-channel gating; ungated ambient messages never spend. `tsc --noEmit` clean.

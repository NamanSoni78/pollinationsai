# Issue 18 — catgpt-bot / opposite-prompt-bot spend the shared platform key on mentions from any channel, unrate-limited, with retry amplification

- **Severity:** High (unbounded platform-metered spend by unauthenticated third parties)
- **Affected:** `apps/catgpt-bot/bot.ts`, `apps/opposite-prompt-bot/bot.ts` — upstream `pollinations/pollinations` main @ `549feee`
- **Fix branch:** `solution18-discord-bots-channel-gate-cooldown` — **PR:** [#22](https://github.com/NamanSoni78/pollinationsai/pull/22)

## Root cause

Both mention handlers gate only on the mention itself — no channel restriction and no per-user rate limit:

- `catgpt-bot/bot.ts:134-145`: `handleMessage()` checks `msg.author.bot`, a message-id dedupe (`processing`, 5 min), and `msg.mentions.users.has(client.user.id)`. `CHANNEL_ID` (line 13, default `1488297205671661640`) is consumed **only** by `catchUpUnanswered` (line 191) and the CLI (line 233) — never by the mention path.
- `opposite-prompt-bot/bot.ts:114-126`: identical shape; no channel constant exists at all.

Every surviving mention then spends the **shared platform token** `TEXT_POLLINATIONS_TOKEN` (line 15-19 in both bots, SOPS-committed and reused across the three bot apps):

- catgpt: 1 `claude-fast` text call + up to **3** paid `nanobanana-2-lite` image generations (retry loop, `maxRetries = 2`) + a `media.pollinations.ai` upload (`publishImage`).
- opposite-prompt: the retry loop repeats **both** the `claude-large` text call and the `zimage` image call — up to 3 text + 3 image per mention.

`processing` dedupes only the *same message ID*; a fresh mention is a fresh bill. Discord's own channel rate limits (~5 msgs/5 s per user per channel, times N channels) leave the burn bounded by nothing the platform controls. The `discord-bot-family` bots — the house standard — are channel-gated with per-channel rate limits (`bot-loop.ts`), and catgpt-bot already *has* a designated channel concept that its handler ignores: clear evidence the omission is an oversight, not a product choice.

Impact: any Discord user in any server/channel these bots occupy converts free mentions into unbounded platform spend (attacker-chosen prompt text, plus deliberate failure induction to trigger the 3× image retry amplification), and media-hosted comics are published under the platform key.

## Safe reproduction (isolated, no Discord / no paid APIs)

The reworked handlers are built by `createMessageHandler` factories with injectable dependencies (mirroring the swarm bot's `createInteractionHandler` seam in `apps/discord-agent-osaii-swarm/test/bot.test.js`), and the bootstrap is guarded to run-as-main — so the test suite drives the gates with stubbed `generateReply`/`downloadImage`/`publish`:

On unpatched main, a fake mention from *any* channel invokes the paid path (that is precisely the bug — no channel check exists in `handleMessage` at all).

## Fix (`solution18-discord-bots-channel-gate-cooldown`)

- **catgpt-bot**: the handler rejects mentions outside `CATGPT_CHANNEL_ID` (the channel catch-up already reads).
- **opposite-prompt-bot**: optional `OPPOSITE_PROMPT_CHANNEL_ID` gate (new; unset keeps today's any-channel behaviour).
- **Both**: `USER_COOLDOWN_MS = 60_000` per-user cooldown — one billed reply per user per window, bounding spend no matter how fast mentions arrive or from how many alt accounts.

## Verification

`node --test bot.test.ts` in both apps: **4/4 + 4/4** — a mention outside the designated channel never invokes the paid path; the cooldown skips a second quick mention from the same user and admits the next one after the window; different users are independent; the default window is pinned at 60 s. Direct execution (`node bot.ts`) still enters `main()` and fails on the missing bot token — the run-as-main guard preserves `npm start` behaviour.

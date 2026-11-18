# Issue 103 — `GET /api/quests/standings`: unauthenticated, uncached per-request D1 full-ledger aggregate (shared-database DoS)

- **Severity:** Medium-High (availability: shared-D1 exhaustion with co-tenant blast radius on every `/api/*` route of the enter service)
- **Affected:** `enter.pollinations.ai/src/routes/quests.ts` (`GET /api/quests/standings` mount), `enter.pollinations.ai/src/routes/quest-leaderboard.ts` (`buildQuestStandings` full-scan aggregate), `shared/db/better-auth.ts` (rewards schema — no `earned_at` index) — upstream `pollinations/pollinations` main @ `282ac54aeb`
- **Fix branch:** `solution95-quests-standings-index-cache` — fork PR [#117](https://github.com/NamanSoni78/pollinationsai/pull/117)
- **Dedup:** round 22's quests-economy audit (subagent B) verified the *billing integrity* of the claim path (atomicity, IDOR, amounts) — this finding is the availability axis of a different route, never filed. The sibling `GET /api/quests/leaderboard` was hardened in an earlier upstream round (KV cache + cron + rowid slicing); `standings` received none of it. No prior issue touches D1 query cost, indexes, or the standings route.

## Root cause

`quests.ts` mounts the standings route with `auth({ allowApiKey: false, allowSessionCookie: true })` — **no user is required; anonymous requests pass** — and every request executes `buildQuestStandings`, a full-table aggregate over the `rewards` ledger joined to `user` (`gte(earnedAt, monthStart)`, `isNotNull(githubUsername)`, the `LEADERBOARD_USER` filter, `groupBy lower(githubUsername)`, plus a `yesterdayPollen` CASE):

- **no index on `earned_at`** — drizzle snapshot 0055 defines only `idx_rewards_idempotency_key` and `idx_rewards_user_id`, so the month filter full-scans;
- **no cache** — the identical failure mode is documented in-repo for the same table (`quest-leaderboard.ts:43-47`): *"A rebuild reads every counted reward. Read in one go (141k rewards, 4.7s), it used up D1's 10-second resource window and failed other requests."*

The per-IP edge limiter (`wrangler.toml`: `simple = { limit = 600, period = 10 }`) is the wrong shape for ~1 s queries: a single anonymous IP can hold ~60 concurrent full-scans — at/over D1's per-database concurrent-query ceiling — degrading every other `/api/*` request that shares the binding (balance reads, key CRUD, quest claims, session-token, and gen's internal auto-top-up calls into enter). The cost grows monotonically with the rewards table.

## Live proof (2026-11-18, anonymous, non-destructive GETs only)

- `GET /api/quests/standings` (no auth): **0.91–1.40 s TTFB**, `{"you":null,…}`, 3,993 monthly participants over a 141k+ row table;
- `GET /api/quests/leaderboard` (the fixed sibling, KV-cached): 0.06–0.28 s — the differential that isolates the missing cache;
- the in-repo incident comment above is the same query shape on the same table.

## Fix

1. `CREATE INDEX idx_rewards_earned_at ON rewards (earned_at)` — added to the drizzle schema and as migration `drizzle/0083_rewards-earned-at-index.sql` (the established hand-written bare-SQL pattern; journal frozen since 0065).
2. A **60-second KV cache** for the month aggregate (`loadStandingsAggregate`, mirroring the leaderboard's KV usage exactly — same binding, `quests:standings:v1:<UTC-day>` key, `expirationTtl: 60`), collapsing any per-IP burst to at most one full scan per minute globally. The **personalized "you" window stays per-request** (`viewerStanding`: a fresh user-scoped month total — which the new index also serves — positioned in the ≤60 s-old ranking with the board's exact ordering; `rank: null` at 0, matching main's nullability). Anonymous callers receive the cached board with `you: null`. Both time boundaries (`monthStart`, `todayStart`) are day-granular and the cache key pins the UTC day, so a cached entry can never serve an aggregate built across a midnight or month rollover (reasoning documented in the loader's docstring).

The route stays public by design — the fix is index + cache, not access control.

## Safe reproduction (isolated, red on unpatched main)

`enter.pollinations.ai/test/quest-standings-cache.test.ts` (new; cloudflare:test/Miniflare harness with real D1 + real KV per test):
- **burst → cache-hit:** three `buildQuestStandings` calls run the D1 aggregate exactly **twice** (RED on main: three times);
- **"you"-freshness:** the viewer's own total is recomputed per request even on a cache hit (RED on main);
- **anonymous route test:** the public route serves from KV (RED on main);
- **index usage:** `EXPLAIN QUERY PLAN` on the per-user query plans as `SEARCH rewards USING INDEX idx_rewards_earned_at (earned_at>?)`;
- **UTC-day key boundary:** a cached entry is never served across a day rollover.

## Verification

- New suite 5/5; quests-related suites (quests, quest-leaderboard, quest-grants, quest-nav-status, top-up-search, referral + the new file): **111/111**
- `npx tsc --noEmit`: byte-identical error set to pristine main (zero new errors); biome clean
- Live probes: only the anonymous timing GETs above ($0 spend, balance untouched)

## Residual (recorded, no change made)

The podium-supporter flags query (`questId IN TOP_UP_QUEST_IDS`, no `earned_at` filter) still scans per request — pre-existing, cheaper than the aggregate, and outside this fix's scope; a follow-up could cache the supporter-login set alongside the aggregate.

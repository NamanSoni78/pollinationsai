import { env, SELF } from "cloudflare:test";
import * as schema from "@shared/db/better-auth.ts";
import { drizzle } from "drizzle-orm/d1";
import { expect } from "vitest";
import {
    buildQuestStandings,
    type QuestStandingsResponse,
    questStandingsAggregateQuery,
} from "../src/routes/quest-leaderboard.ts";
import { test } from "./fixtures.ts";

const addUser = async (githubUsername: string, githubId: number) => {
    const db = drizzle(env.DB, { schema });
    await db.insert(schema.user).values({
        id: githubUsername,
        name: githubUsername,
        email: `${githubUsername}@example.com`,
        githubId,
        githubUsername,
    });
};

const addReward = async (
    userId: string,
    id: string,
    pollenAmount: number,
    earnedAt = new Date(),
) => {
    const db = drizzle(env.DB, { schema });
    await db.insert(schema.rewards).values({
        id,
        idempotencyKey: id,
        userId,
        questId: "merged_pr",
        title: id,
        pollenAmount,
        balanceBucket: "tier",
        earnedAt,
    });
};

// Drops the KV copies standings shares the month aggregate through.
const clearStandingsCache = async () => {
    const { keys } = await env.KV.list();
    await Promise.all(
        keys
            .map((key) => key.name)
            .filter((name) => name.startsWith("quests:standings:"))
            .map((name) => env.KV.delete(name)),
    );
};

test("a burst of standings views shares one month aggregate", async () => {
    await addUser("burst-alice", 8_600_101);
    await addUser("burst-bob", 8_600_102);
    await addReward("burst-alice", "burst-alice-reward", 30);
    await addReward("burst-bob", "burst-bob-reward", 20);

    // The first viewer pays for the aggregate and shares it through KV.
    const first = await buildQuestStandings(env, null);
    expect(first.you).toBeNull();
    expect(first.participants).toBe(2);

    // A reward landing after that must not re-run the scan within the
    // cache's minute. Without the cache every request re-aggregates the
    // whole rewards table, so the 600-requests-per-10s-per-IP the edge
    // limiter allows can hold D1 with concurrent full scans.
    await addUser("burst-late", 8_600_103);
    await addReward("burst-late", "burst-late-reward", 10);
    const cached = await buildQuestStandings(env, null);
    expect(cached.participants).toBe(2);
    expect(cached.rows.map((row) => row.githubLogin)).toEqual([
        "burst-alice",
        "burst-bob",
    ]);

    // Once the cached copy is gone the next viewer rebuilds the board.
    await clearStandingsCache();
    const rebuilt = await buildQuestStandings(env, null);
    expect(rebuilt.participants).toBe(3);
});

test("the viewer's own place stays per-request on a cache hit", async () => {
    await addUser("overtake-rival", 8_600_201);
    await addUser("overtake-viewer", 8_600_202);
    await addReward("overtake-rival", "overtake-rival-reward", 20);
    await addReward("overtake-viewer", "overtake-viewer-reward", 10);

    const first = await buildQuestStandings(env, "Overtake-Viewer");
    expect(first.you).toEqual({
        githubLogin: "overtake-viewer",
        rank: 2,
        totalPollen: 10,
    });

    // The viewer earns past the rival after the board was cached. Their own
    // place must move immediately even though the shared board is a minute
    // old: the "you" data is a per-user read, never part of the cache.
    await addReward("overtake-viewer", "overtake-viewer-late", 11);
    const second = await buildQuestStandings(env, "Overtake-Viewer");
    expect(second.you).toEqual({
        githubLogin: "overtake-viewer",
        rank: 1,
        totalPollen: 21,
    });
    // The board itself still shows the race as of the first call.
    expect(
        second.rows.find((row) => row.githubLogin === "overtake-viewer")
            ?.totalPollen,
    ).toBe(10);
});

test("anonymous viewers get the standings board without signing in", async () => {
    await addUser("public-racer", 8_600_301);
    await addReward("public-racer", "public-racer-reward", 7);

    const response = await SELF.fetch(
        "http://localhost:3000/api/quests/standings",
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as QuestStandingsResponse;
    expect(payload.you).toBeNull();
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]).toMatchObject({
        rank: 1,
        githubLogin: "public-racer",
        totalPollen: 7,
        supporter: false,
    });

    // The board came through the shared KV aggregate, so the next anonymous
    // viewer in a burst does not touch D1 for it at all.
    const { keys } = await env.KV.list();
    expect(keys.some((key) => key.name.startsWith("quests:standings:"))).toBe(
        true,
    );
});

test("the month aggregate searches rewards through the earned_at index", async () => {
    const db = drizzle(env.DB);
    const { sql: aggregateSql, params } = questStandingsAggregateQuery(
        db,
        new Date("2031-01-01T00:00:00.000Z"),
        new Date("2031-01-15T00:00:00.000Z"),
    ).toSQL();
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${aggregateSql}`)
        .bind(...params)
        .all();
    expect(JSON.stringify(plan.results)).toContain("idx_rewards_earned_at");
});

test("the cached aggregate never crosses a UTC day into stale movement", async () => {
    await addUser("boundary-alice", 8_600_401);
    await addUser("boundary-bob", 8_600_402);
    // Alice led before today; Bob took over during today.
    await addReward(
        "boundary-alice",
        "boundary-alice-old",
        10,
        new Date("2031-05-01T08:00:00.000Z"),
    );
    await addReward(
        "boundary-bob",
        "boundary-bob-new",
        15,
        new Date("2031-05-02T10:00:00.000Z"),
    );

    const dayOne = await buildQuestStandings(
        env,
        null,
        new Date("2031-05-02T12:00:00.000Z"),
    );
    expect(dayOne.rows.map((row) => [row.githubLogin, row.movement])).toEqual([
        ["boundary-bob", null],
        ["boundary-alice", -1],
    ]);

    // After UTC midnight the movement baseline rolls forward — yesterday now
    // includes Bob's takeover, so both rows hold their ground. The cache key
    // pins the UTC day, so the day-two board cannot reuse the day-one
    // aggregate and its start-of-today boundary.
    const dayTwo = await buildQuestStandings(
        env,
        null,
        new Date("2031-05-03T00:30:00.000Z"),
    );
    expect(dayTwo.rows.map((row) => [row.githubLogin, row.movement])).toEqual([
        ["boundary-bob", 0],
        ["boundary-alice", 0],
    ]);
});

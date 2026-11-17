import assert from "node:assert/strict";
import test from "node:test";
import { createMessageHandler, USER_COOLDOWN_MS } from "./bot.ts";

const BOT_ID = "bot-1";
const client = { user: { id: BOT_ID } } as any;

let seq = 0;
function makeMessage({
    channelId,
    userId = "user-1",
    content = "<@bot-1> what is the meaning of life?",
}: {
    channelId: string;
    userId?: string;
    content?: string;
}) {
    seq += 1;
    const replies: unknown[] = [];
    const msg = {
        author: {
            bot: false,
            id: userId,
            username: `user-${userId}`,
            displayAvatarURL: () => "https://cdn.example/avatar.png",
        },
        id: `message-${seq}`,
        channelId,
        content,
        mentions: { users: { has: (id: string) => id === BOT_ID } },
        channel: {},
        reply: async (payload: unknown) => {
            replies.push(payload);
        },
    };
    return { msg, replies };
}

function makeHandler({
    channelId,
    now,
}: { channelId: string; now?: () => number } = {} as {
    channelId: string;
    now?: () => number;
}) {
    const generateCalls: Array<{ question: string; imageUrl: string | null }> =
        [];
    const imageCalls: string[] = [];
    const publishCalls: number[] = [];
    const handler = createMessageHandler({
        channelId,
        cooldownMs: 60_000,
        ...(now ? { now } : {}),
        generateReply: async (question: string, imageUrl: string | null) => {
            generateCalls.push({ question, imageUrl });
            return "Naps. Next question.";
        },
        downloadImage: async (url: string) => {
            imageCalls.push(url);
            return Buffer.from("fake-png");
        },
        publish: async () => {
            publishCalls.push(1);
        },
    });
    return { handler, generateCalls, imageCalls, publishCalls };
}

test("a mention outside the designated channel never spends the platform key", async () => {
    const { handler, generateCalls, imageCalls, publishCalls } = makeHandler({
        channelId: "channel-allowed",
    });

    const outside = makeMessage({ channelId: "channel-other" });
    await handler(outside.msg, client);
    assert.equal(generateCalls.length, 0);
    assert.equal(imageCalls.length, 0);
    assert.equal(publishCalls.length, 0);
    assert.equal(outside.replies.length, 0);

    const inside = makeMessage({ channelId: "channel-allowed" });
    await handler(inside.msg, client);
    assert.equal(generateCalls.length, 1);
    assert.equal(imageCalls.length, 1);
    assert.equal(publishCalls.length, 1);
    assert.equal(inside.replies.length, 1);
});

test("the per-user cooldown bounds spend to one billed reply per window", async () => {
    let clock = 1_000;
    const { handler, generateCalls } = makeHandler({
        channelId: "channel-allowed",
        now: () => clock,
    });

    const first = makeMessage({ channelId: "channel-allowed" });
    await handler(first.msg, client);
    assert.equal(generateCalls.length, 1);

    clock += 10_000;
    const second = makeMessage({ channelId: "channel-allowed" });
    await handler(second.msg, client);
    assert.equal(generateCalls.length, 1, "still inside the cooldown window");
    assert.equal(second.replies.length, 0);

    clock += 51_000;
    const third = makeMessage({ channelId: "channel-allowed" });
    await handler(third.msg, client);
    assert.equal(generateCalls.length, 2, "cooldown elapsed");
});

test("different users are not throttled by each other", async () => {
    let clock = 5_000;
    const { handler, generateCalls } = makeHandler({
        channelId: "channel-allowed",
        now: () => clock,
    });

    const alice = makeMessage({ channelId: "channel-allowed", userId: "alice" });
    const bob = makeMessage({ channelId: "channel-allowed", userId: "bob" });
    await handler(alice.msg, client);
    await handler(bob.msg, client);
    assert.equal(generateCalls.length, 2);
});

test("the default cooldown window is 60 seconds", () => {
    assert.equal(USER_COOLDOWN_MS, 60_000);
});

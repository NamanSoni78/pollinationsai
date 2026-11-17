import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelType } from "discord.js";
import type { Client, Message } from "discord.js";
import {
    processMessage,
    resetSpendGatesForTests,
    USER_COOLDOWN_MS,
} from "./bot-loop";
import type { BotConfig, GenerateTextWithHistory } from "./types";

/**
 * The spend gate, verified without Discord and without the paid APIs:
 * every qualifying message (DM, mention, reply, conversation channel)
 * triggers exactly one platform-keyed completion per user per cooldown
 * window, no matter how fast the messages arrive.
 */

type RecordedCall = { model: string; content: string };

const makeClient = (botId = "bot-1"): Client =>
    ({
        user: { id: botId, username: "test-bot" },
        channels: {
            fetch: async (channelId: string) => ({
                id: channelId,
                type: ChannelType.DM,
                messages: { fetch: async () => new Map() },
            }),
        },
    }) as unknown as Client;

const makeMessage = (
    authorId: string,
    content: string,
    overrides: Partial<Message> = {},
): Message =>
    ({
        author: { id: authorId, bot: false, username: `user-${authorId}` },
        channelId: "dm-1",
        channel: {
            type: ChannelType.DM,
            messages: { fetch: async () => new Map() },
        },
        mentions: { users: { has: () => false } },
        reference: null,
        content,
        reply: async () => {},
    }) as unknown as Message;

const makeConfig = (overrides: Partial<BotConfig> = {}): BotConfig =>
    ({
        name: "test-bot",
        token: "x",
        model: "kimi",
        conversationChannelIds: undefined,
        globalChannelIds: undefined,
        ...overrides,
    }) as unknown as BotConfig;

const recordingGenerateText = (calls: RecordedCall[]): GenerateTextWithHistory =>
    async (messages, model) => {
        calls.push({ model, content: String(messages.at(-1)?.content ?? "") });
        return "hello from the model";
    };

test("a DM always gets one paid reply, then the cooldown skips the rest", async () => {
    resetSpendGatesForTests();
    const calls: RecordedCall[] = [];
    const config = makeConfig();
    let clock = 1_000;
    const options = { cooldownMs: USER_COOLDOWN_MS, now: () => clock };

    await processMessage(
        makeMessage("u1", "hi bot"),
        makeClient(),
        config,
        recordingGenerateText(calls),
        options,
    );
    assert.equal(calls.length, 1, "the first DM is answered");

    clock += 5_000; // well inside the window
    await processMessage(
        makeMessage("u1", "spam 1"),
        makeClient(),
        config,
        recordingGenerateText(calls),
        options,
    );
    await processMessage(
        makeMessage("u1", "spam 2"),
        makeClient(),
        config,
        recordingGenerateText(calls),
        options,
    );
    assert.equal(calls.length, 1, "rapid DMs from the same user spend once");

    clock += USER_COOLDOWN_MS; // the window has fully elapsed
    await processMessage(
        makeMessage("u1", "hello again"),
        makeClient(),
        config,
        recordingGenerateText(calls),
        options,
    );
    assert.equal(calls.length, 2, "the next window gets a fresh reply");
});

test("the cooldown is per user, not global", async () => {
    resetSpendGatesForTests();
    const calls: RecordedCall[] = [];
    const options = { cooldownMs: USER_COOLDOWN_MS, now: () => 5_000 };

    for (const user of ["alice", "bob", "carol"]) {
        await processMessage(
            makeMessage(user, `hi from ${user}`),
            makeClient(),
            makeConfig(),
            recordingGenerateText(calls),
            options,
        );
    }
    assert.equal(calls.length, 3, "three users each get their one reply");
});

test("the cooldown budget is per bot", async () => {
    resetSpendGatesForTests();
    const calls: RecordedCall[] = [];
    const options = { cooldownMs: USER_COOLDOWN_MS, now: () => 5_000 };
    const message = makeMessage("u1", "hi");

    await processMessage(
        message,
        makeClient(),
        makeConfig({ name: "bot-a" }),
        recordingGenerateText(calls),
        options,
    );
    await processMessage(
        message,
        makeClient("bot-2"),
        makeConfig({ name: "bot-b" }),
        recordingGenerateText(calls),
        options,
    );
    assert.equal(calls.length, 2, "each bot answers once for the same user");
});

test("a conversation-channel post is gated like a mention", async () => {
    resetSpendGatesForTests();
    const calls: RecordedCall[] = [];
    const config = makeConfig({ conversationChannelIds: ["lounge"] });
    let clock = 10_000;
    const options = { cooldownMs: USER_COOLDOWN_MS, now: () => clock };

    const loungeMessage = (authorId: string, content: string) => {
        const base = makeMessage(authorId, content);
        return {
            ...base,
            channelId: "lounge",
            channel: { messages: { fetch: async () => new Map() } },
        } as unknown as Message;
    };

    await processMessage(
        loungeMessage("u9", "anyone here?"),
        makeClient(),
        config,
        recordingGenerateText(calls),
        options,
    );
    assert.equal(calls.length, 1, "conversation channels are answered");

    clock += 2_000;
    await processMessage(
        loungeMessage("u9", "more chatter"),
        makeClient(),
        config,
        recordingGenerateText(calls),
        options,
    );
    assert.equal(calls.length, 1, "the same user cannot refill the budget");
});

test("messages outside the gates never spend", async () => {
    resetSpendGatesForTests();
    const calls: RecordedCall[] = [];
    const options = { cooldownMs: USER_COOLDOWN_MS, now: () => 1_000 };

    // A message in a channel the bot neither monitors nor was mentioned in.
    const ambient = {
        ...makeMessage("stranger", "just talking"),
        channelId: "random-channel",
        channel: { type: ChannelType.GuildText, messages: { fetch: async () => new Map() } },
    } as unknown as Message;

    await processMessage(
        ambient,
        makeClient(),
        makeConfig(),
        recordingGenerateText(calls),
        options,
    );
    assert.equal(calls.length, 0, "ungated ambient messages spend nothing");
});

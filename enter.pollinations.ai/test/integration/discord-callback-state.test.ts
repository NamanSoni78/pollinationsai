import { env, SELF } from "cloudflare:test";
import {
    account as accountTable,
    user as userTable,
} from "@shared/db/better-auth.ts";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { expect } from "vitest";
import { test } from "../fixtures.ts";

// Regression: replay a GitHub sign-in state on the Discord callback with an
// unverified Discord email that matches an existing (verified) local user.
// Before the /callback/:id guard this linked the attacker's Discord account
// to that user and minted a session for them (account takeover).
test("a Discord callback cannot replay a sign-in state from another provider", async ({
    mocks,
    sessionToken,
}) => {
    await mocks.enable("github", "discord", "tinybird");

    // The victim is the fixture user: test@example.com, emailVerified.
    const db = drizzle(env.DB);
    const [victim] = await db.select().from(userTable).limit(1);
    if (!victim) throw new Error("Expected fixture user");
    expect(victim.email).toBe("test@example.com");
    expect(victim.emailVerified).toBe(true);

    // Attacker's Discord profile carries the victim's email, unverified.
    mocks.discord.state.email = "test@example.com";
    mocks.discord.state.emailVerified = false;

    // 1. Mint a GitHub sign-in state (never completed).
    const start = await SELF.fetch(
        "http://localhost:3000/api/auth/sign-in/social",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ provider: "github", callbackURL: "/" }),
        },
    );
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    const stateCookie = start.headers.get("Set-Cookie");
    if (!state || !stateCookie) throw new Error("Expected OAuth state");

    // 2. Present that state on the Discord callback with the attacker code.
    const callbackUrl = new URL(
        "http://localhost:3000/api/auth/callback/discord",
    );
    callbackUrl.searchParams.set("code", "discord-test-code");
    callbackUrl.searchParams.set("state", state);
    const callback = await SELF.fetch(callbackUrl.toString(), {
        headers: {
            Accept: "text/html,application/xhtml+xml",
            Cookie: stateCookie,
            "User-Agent": "Mozilla/5.0 (compatible; test-browser)",
        },
        redirect: "manual",
    });

    // Replayed sign-in states must be refused: no session, no link.
    expect(callback.headers.get("Set-Cookie") ?? "").not.toContain(
        "better-auth.session_token",
    );
    expect(
        await db
            .select()
            .from(accountTable)
            .where(eq(accountTable.providerId, "discord")),
    ).toEqual([]);

    // A state without a code (provider-side denial) is unaffected.
    const denialUrl = new URL(
        "http://localhost:3000/api/auth/callback/discord",
    );
    denialUrl.searchParams.set("error", "access_denied");
    denialUrl.searchParams.set("state", state);
    const denial = await SELF.fetch(denialUrl.toString(), {
        headers: {
            Accept: "text/html,application/xhtml+xml",
            Cookie: stateCookie,
            "User-Agent": "Mozilla/5.0 (compatible; test-browser)",
        },
        redirect: "manual",
    });
    expect(denial.status).toBe(302);
    expect(sessionToken).toBeTruthy();
});

test("a Discord callback still completes an authenticated link-social flow", async ({
    mocks,
    sessionToken,
}) => {
    await mocks.enable("discord", "tinybird");

    // Attacker's Discord profile carries the victim's email, unverified;
    // the explicit link flow must still work for the signed-in user.
    mocks.discord.state.email = "attacker@example.com";
    mocks.discord.state.emailVerified = false;

    const linkResponse = await SELF.fetch(
        "http://localhost:3000/api/auth/link-social",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Cookie: `better-auth.session_token=${sessionToken}`,
                Origin: "http://localhost:3000",
            },
            body: JSON.stringify({
                provider: "discord",
                callbackURL: "/account",
            }),
        },
    );
    expect(linkResponse.status).toBe(200);
    const { url } = (await linkResponse.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    const stateCookie = linkResponse.headers.get("Set-Cookie");
    if (!state || !stateCookie) throw new Error("Expected OAuth state");

    const callbackUrl = new URL(
        "http://localhost:3000/api/auth/callback/discord",
    );
    callbackUrl.searchParams.set("code", "discord-test-code");
    callbackUrl.searchParams.set("state", state);
    const callback = await SELF.fetch(callbackUrl.toString(), {
        headers: {
            Accept: "text/html,application/xhtml+xml",
            Cookie: `better-auth.session_token=${sessionToken}; ${stateCookie}`,
            "User-Agent": "Mozilla/5.0 (compatible; test-browser)",
        },
        redirect: "manual",
    });

    expect(callback.status).toBe(302);
    expect(callback.headers.get("Location")).toBe("/account");

    const db = drizzle(env.DB);
    const [victim] = await db.select().from(userTable).limit(1);
    if (!victim) throw new Error("Expected fixture user");
    const discordAccount = (await db.select().from(accountTable)).find(
        (account) => account.providerId === "discord",
    );
    expect(discordAccount).toMatchObject({
        accountId: mocks.discord.state.userId,
        userId: victim.id,
    });
});

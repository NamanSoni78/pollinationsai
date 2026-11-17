import { user as userTable } from "@shared/db/better-auth.ts";
import { env, SELF } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { expect } from "vitest";
import { createApiKeyViaApi, test } from "../fixtures.ts";

test("revoking a paid x402 prepaid key removes it and invalidates the raw key", async ({
    mocks,
    accountToken,
}) => {
    mocks.enable("github", "tinybird");

    // The fixture user stands in for the x402 holding user: it is the ONLY
    // account whose credential can pass the revoke route's referenceId check.
    const db = drizzle(env.DB);
    const [holdingUser] = await db.select().from(userTable).limit(1);
    expect(holdingUser).toBeTruthy();

    // Real key creation, exactly as preparePurchase does for a paid purchase
    // (type secret, budget 0 at creation, credited on settlement).
    const created = await createApiKeyViaApi(accountToken, {
        name: "x402 p2",
        type: "secret",
        pollenBudget: 0,
    });

    // Settlement credit funds the key; the purchase row is written by
    // preparePurchase with the exact statement it uses in production.
    await env.DB.prepare("UPDATE apikey SET pollen_balance = 2 WHERE id = ?")
        .bind(created.id)
        .run();
    await env.DB.prepare(
        `INSERT INTO x402_key_purchase
             (payment_id, user_id, key_id, pack_key, encrypted_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
    )
        .bind(
            "0xdeadbeef",
            holdingUser.id,
            created.id,
            "p2",
            "v1:enc",
            Date.now(),
        )
        .run();

    // The key is live and funded before the incident.
    const before = await env.DB.prepare(
        "SELECT enabled, pollen_balance FROM apikey WHERE id = ?",
    )
        .bind(created.id)
        .first<{ enabled: number; pollen_balance: number }>();
    expect(before?.enabled).toBe(1);
    expect(before?.pollen_balance).toBe(2);

    // INCIDENT: the key leaks; the holding user revokes it through the real route.
    const revoke = await SELF.fetch(
        `http://localhost:3000/api/account/keys/${created.id}`,
        {
            method: "DELETE",
            headers: { Authorization: `Bearer ${accountToken}` },
        },
    );
    expect(revoke.status).toBe(200);

    // The key row and its purchase rows are gone.
    const after = await env.DB.prepare(
        "SELECT id FROM apikey WHERE id = ?",
    )
        .bind(created.id)
        .first();
    expect(after).toBeNull();
    const purchases = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM x402_key_purchase WHERE key_id = ?",
    )
        .bind(created.id)
        .first<{ n: number }>();
    expect(purchases?.n).toBe(0);

    // ...and the leaked raw key no longer authenticates through the real stack.
    const check = await SELF.fetch("http://localhost:3000/api/account/key", {
        headers: { "x-api-key": created.key },
    });
    expect(check.status).toBe(401);
});

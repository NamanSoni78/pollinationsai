import {
    atomicAdjustApiKeyBalance,
    atomicReserveApiKeyBalance,
} from "@shared/billing/deduction.ts";
import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { expect, it } from "vitest";

const db = drizzle(env.DB);

async function seedKey(id: string, balance: number) {
    await env.DB.prepare(
        "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, 'T', ?, 1, ?, ?)",
    )
        .bind(id, `${id}@t.test`, Date.now(), Date.now())
        .run();
    await env.DB.prepare(
        "INSERT INTO apikey (id, name, `key`, start, prefix, user_id, created_at, updated_at, enabled, pollen_balance) VALUES (?, 't', 'h', 'sk_t', 'sk', ?, ?, ?, 1, ?)",
    )
        .bind(id, id, Date.now(), Date.now(), balance)
        .run();
}

async function readBalance(id: string) {
    const row = await env.DB.prepare(
        "SELECT pollen_balance AS b FROM apikey WHERE id = ?",
    )
        .bind(id)
        .first<{ b: number }>();
    return row?.b ?? null;
}

it("the reserve path still rejects unaffordable amounts", async () => {
    await seedKey("floor-guard", 0.01);
    const rejected = await atomicReserveApiKeyBalance(db, "floor-guard", 0.19);
    expect(rejected.ok).toBe(false);
    expect(rejected.reserved).toBe(0);
    expect(await readBalance("floor-guard")).toBe(0.01);
});

it("a settle larger than the remaining budget floors at zero (Tinybird-cold estimate)", async () => {
    await seedKey("floor-k1", 0.01);
    // Estimate 0 (Tinybird cold) -> nothing held; the full bill settles at once.
    const reserved = await atomicReserveApiKeyBalance(db, "floor-k1", 0);
    expect(reserved).toMatchObject({ ok: true, reserved: 0 });
    const settled = await atomicAdjustApiKeyBalance(db, "floor-k1", 2.7);
    expect(settled.ok).toBe(true);
    // Pre-fix this left the key at -2.69; the budget is finite, so it floors.
    expect(await readBalance("floor-k1")).toBe(0);
});

it("a 28x under-reserved bill floors at zero too", async () => {
    await seedKey("floor-k3", 1.0);
    // One-second estimate reserved 0.97; a 30s @ 0.97/s render settles 28.13.
    const reserved = await atomicReserveApiKeyBalance(db, "floor-k3", 0.97);
    expect(reserved.ok).toBe(true);
    expect(await readBalance("floor-k3")).toBe(0.03);
    const settled = await atomicAdjustApiKeyBalance(
        db,
        "floor-k3",
        28.13 - 0.97,
    );
    expect(settled.ok).toBe(true);
    // Pre-fix this left the key at -28.10.
    expect(await readBalance("floor-k3")).toBe(0);
});

it("the release path stays unclamped", async () => {
    await seedKey("floor-k4", 1.0);
    expect(await atomicReserveApiKeyBalance(db, "floor-k4", 0.5)).toMatchObject(
        { ok: true, reserved: 0.5 },
    );
    expect(await readBalance("floor-k4")).toBe(0.5);
    const released = await atomicAdjustApiKeyBalance(db, "floor-k4", -0.5);
    expect(released.ok).toBe(true);
    expect(await readBalance("floor-k4")).toBe(1);
});

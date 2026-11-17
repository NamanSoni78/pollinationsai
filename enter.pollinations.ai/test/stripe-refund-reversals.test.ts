import { env, SELF } from "cloudflare:test";
import { createHmac } from "node:crypto";
import { expect } from "vitest";
import { test } from "./fixtures.ts";

const stripeWebhookUrl = "http://localhost:3000/api/webhooks/stripe";

function signStripeWebhookPayload(payload: string): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", env.STRIPE_WEBHOOK_SECRET)
        .update(`${timestamp}.${payload}`, "utf8")
        .digest("hex");
    return `t=${timestamp},v1=${signature}`;
}

async function postSignedStripeWebhook(
    payloadObject: Record<string, unknown>,
): Promise<Response> {
    const payload = JSON.stringify(payloadObject);
    return SELF.fetch(stripeWebhookUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "stripe-signature": signStripeWebhookPayload(payload),
        },
        body: payload,
    });
}

async function getSeededUserId(): Promise<string> {
    const user = await env.DB.prepare("SELECT id FROM user LIMIT 1").first<{
        id: string;
    }>();
    expect(user).toBeTruthy();
    return user?.id ?? "";
}

/** A completed $55.00 pack checkout credited as 55 pollen: 5500 cents total. */
async function seedPackPurchase({
    sessionId = "cs_refund_pack",
    paymentIntentId = "pi_refund_pack",
    pollenCredited = 55,
    sessionTotalCents = 5500,
    startingBalance = 55,
}): Promise<{ userId: string }> {
    const userId = await getSeededUserId();
    await env.DB.prepare(
        "UPDATE user SET pack_balance = ?, low_balance_notified_at = NULL WHERE id = ?",
    )
        .bind(startingBalance, userId)
        .run();
    await env.DB.prepare(
        `INSERT INTO stripe_checkout_credits (
            session_id, event_id, event_type, user_id, pollen_credited, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
        .bind(
            sessionId,
            `evt_${sessionId}`,
            "checkout.session.completed",
            userId,
            pollenCredited,
            Date.now(),
        )
        .run();
    return { userId };
}

async function packBalance(userId: string): Promise<number | null> {
    const row = await env.DB.prepare(
        "SELECT pack_balance AS balance FROM user WHERE id = ?",
    )
        .bind(userId)
        .first<{ balance: number }>();
    return row?.balance ?? null;
}

function refundEvent(
    id: string,
    paymentIntentId: string,
    amountCents: number,
    status = "succeeded",
): Record<string, unknown> {
    return {
        id: `evt_${id}`,
        type: "refund.created",
        livemode: false,
        data: {
            object: {
                id,
                object: "refund",
                amount: amountCents,
                currency: "usd",
                status,
                payment_intent: paymentIntentId,
            },
        },
    };
}

function disputeClosedEvent(
    id: string,
    paymentIntentId: string,
    amountCents: number,
    status: "lost" | "won",
): Record<string, unknown> {
    return {
        id: `evt_${id}`,
        type: "charge.dispute.closed",
        livemode: false,
        data: {
            object: {
                id,
                object: "dispute",
                amount: amountCents,
                currency: "usd",
                status,
                charge: "ch_dispute",
                payment_intent: paymentIntentId,
            },
        },
    };
}

test("a completed refund reverses the credited pollen exactly once", async ({ sessionToken, mocks }) => {
    expect(sessionToken).toBeTruthy();
    await mocks.enable("stripe", "tinybird");
    const { userId } = await seedPackPurchase({});
    mocks.stripe.state.checkoutSessions.push({
        id: "cs_refund_pack",
        object: "checkout.session",
        mode: "payment",
        customer: "cus_refund_test",
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_refund_pack",
        amount_total: 5500,
        currency: "usd",
        metadata: { userId },
    });

    const response = await postSignedStripeWebhook(
        refundEvent("re_full", "pi_refund_pack", 5500),
    );
    expect(response.status).toBe(200);
    expect(await packBalance(userId)).toBe(0);

    // A duplicate delivery of the same refund (Stripe retries) must not
    // double-reverse.
    const replay = await postSignedStripeWebhook(
        refundEvent("re_full", "pi_refund_pack", 5500),
    );
    expect(replay.status).toBe(200);
    expect(await packBalance(userId)).toBe(0);
    const rows = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM stripe_refund_reversals",
    ).first<{ count: number }>();
    expect(rows?.count).toBe(1);
});

test("partial refunds scale their reversal and cannot over-reverse", async ({ sessionToken, mocks }) => {
    expect(sessionToken).toBeTruthy();
    await mocks.enable("stripe", "tinybird");
    const { userId } = await seedPackPurchase({});
    mocks.stripe.state.checkoutSessions.push({
        id: "cs_refund_pack",
        object: "checkout.session",
        mode: "payment",
        customer: "cus_refund_test",
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_refund_pack",
        amount_total: 5500,
        currency: "usd",
        metadata: { userId },
    });

    // Half the money back -> half the credited pollen.
    await postSignedStripeWebhook(
        refundEvent("re_half", "pi_refund_pack", 2750),
    );
    expect(await packBalance(userId)).toBe(27.5);

    // The other half refunds the rest...
    await postSignedStripeWebhook(
        refundEvent("re_second_half", "pi_refund_pack", 2750),
    );
    expect(await packBalance(userId)).toBe(0);

    // ...and any further refund finds nothing left to take.
    await postSignedStripeWebhook(
        refundEvent("re_over", "pi_refund_pack", 5500),
    );
    expect(await packBalance(userId)).toBe(0);
    const rows = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM stripe_refund_reversals",
    ).first<{ count: number }>();
    expect(rows?.count).toBe(2);
});

test("pending refunds and non-pack refunds reverse nothing", async ({ sessionToken, mocks }) => {
    expect(sessionToken).toBeTruthy();
    await mocks.enable("stripe", "tinybird");
    const { userId } = await seedPackPurchase({});
    mocks.stripe.state.checkoutSessions.push({
        id: "cs_refund_pack",
        object: "checkout.session",
        mode: "payment",
        customer: "cus_refund_test",
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_refund_pack",
        amount_total: 5500,
        currency: "usd",
        metadata: { userId },
    });

    // Not completed yet: money has not left.
    await postSignedStripeWebhook(
        refundEvent("re_pending", "pi_refund_pack", 5500, "pending"),
    );
    expect(await packBalance(userId)).toBe(55);

    // A refund on a payment intent that belongs to no pack checkout (an
    // invoice or subscription) has nothing to reverse.
    await postSignedStripeWebhook(
        refundEvent("re_other_pi", "pi_not_a_pack_checkout", 1000),
    );
    expect(await packBalance(userId)).toBe(55);
    const rows = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM stripe_refund_reversals",
    ).first<{ count: number }>();
    expect(rows?.count).toBe(0);
});

test("a lost dispute reverses the credit; a won dispute keeps it", async ({ sessionToken, mocks }) => {
    expect(sessionToken).toBeTruthy();
    await mocks.enable("stripe", "tinybird");
    const { userId } = await seedPackPurchase({});
    mocks.stripe.state.checkoutSessions.push({
        id: "cs_refund_pack",
        object: "checkout.session",
        mode: "payment",
        customer: "cus_refund_test",
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_refund_pack",
        amount_total: 5500,
        currency: "usd",
        metadata: { userId },
    });

    const lost = await postSignedStripeWebhook(
        disputeClosedEvent("dp_lost", "pi_refund_pack", 5500, "lost"),
    );
    expect(lost.status).toBe(200);
    expect(await packBalance(userId)).toBe(0);

    // A won dispute returns the money, so a second pack stays credited.
    const { userId: userId2 } = await seedPackPurchase({
        sessionId: "cs_won_pack",
        paymentIntentId: "pi_won_pack",
    });
    mocks.stripe.state.checkoutSessions.push({
        id: "cs_won_pack",
        object: "checkout.session",
        mode: "payment",
        customer: "cus_refund_test",
        status: "complete",
        payment_status: "paid",
        payment_intent: "pi_won_pack",
        amount_total: 5500,
        currency: "usd",
        metadata: { userId: userId2 },
    });
    await postSignedStripeWebhook(
        disputeClosedEvent("dp_won", "pi_won_pack", 5500, "won"),
    );
    expect(await packBalance(userId2)).toBe(55);
});

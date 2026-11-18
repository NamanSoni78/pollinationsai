import { SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

/**
 * Enter-wide request-body ceiling: every route that consumes a body on this
 * control plane read it unbounded before this gate — the Stripe/GitHub webhook
 * handlers buffer the raw body before the signature check, and the public
 * OAuth/device endpoints parse form/JSON bodies of any size.
 *
 * Oversized bodies must be refused 413 before any of that buffering.
 */
describe("enter /api/* request body limit", () => {
    const oversized = "x".repeat(9 * 1024 * 1024);

    test("refuses an oversized Stripe webhook body before buffering it", async () => {
        const response = await SELF.fetch(
            "https://enter.pollinations.ai/api/webhooks/stripe",
            {
                method: "POST",
                headers: { "content-type": "text/plain" },
                body: oversized,
            },
        );
        expect(response.status).toBe(413);
        expect(await response.text()).toMatch(/8 MiB/i);
    });

    test("refuses an oversized GitHub secret-scanning webhook body", async () => {
        const response = await SELF.fetch(
            "https://enter.pollinations.ai/api/webhooks/github-secret-scanning",
            {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "Github-Public-Key-Identifier": "bogus-key-id",
                    "Github-Public-Key-Signature": "bogus-signature",
                },
                body: oversized,
            },
        );
        expect(response.status).toBe(413);
    });

    test("refuses an oversized public OAuth token body", async () => {
        const response = await SELF.fetch(
            "https://enter.pollinations.ai/api/oauth/token",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: oversized,
            },
        );
        expect(response.status).toBe(413);
    });

    test("refuses an oversized public device code body", async () => {
        const response = await SELF.fetch(
            "https://enter.pollinations.ai/api/device/code",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: oversized,
            },
        );
        expect(response.status).toBe(413);
    });

    test("still reaches the Stripe signature check for normal-size bodies", async () => {
        const response = await SELF.fetch(
            "https://enter.pollinations.ai/api/webhooks/stripe",
            {
                method: "POST",
                headers: { "content-type": "text/plain" },
                body: "{}",
            },
        );
        // Unpatched behavior preserved: no signature header -> the route's
        // own 400 after a bounded read, never a 413 for a small body.
        expect(response.status).toBe(400);
        expect(await response.text()).toMatch(/Missing signature/i);
    });

    test("still parses normal-size device code bodies", async () => {
        const response = await SELF.fetch(
            "https://enter.pollinations.ai/api/device/code",
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    client_id: "definitely-unknown-client-id",
                    scope: "generate",
                }),
            },
        );
        expect(response.status).toBe(400);
        const body = (await response.json()) as { error?: string };
        expect(body.error).toBe("invalid_client");
    });
});

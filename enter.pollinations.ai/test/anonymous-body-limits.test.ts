import { SELF } from "cloudflare:test";
import { describe, expect } from "vitest";
import { test } from "./fixtures.ts";

const WEBHOOK_URL =
    "https://enter.pollinations.ai/api/webhooks/github-secret-scanning";
const DEVICE_CODE_URL = "https://enter.pollinations.ai/api/device/code";
const DEVICE_TOKEN_URL = "https://enter.pollinations.ai/api/device/token";
const OAUTH_TOKEN_URL = "https://enter.pollinations.ai/api/oauth/token";

const GITHUB_WEBHOOK_HEADERS = {
    "Content-Type": "application/json",
    "Github-Public-Key-Identifier": "test-secret-scanning-key",
    "Github-Public-Key-Signature": "AAAA",
};

describe("anonymous request body limits", () => {
    test("rejects an oversized secret-scanning webhook body before reading it", async ({
        mocks,
    }) => {
        mocks.github.state.secretScanningPublicKeys = [
            {
                key_identifier: "test-secret-scanning-key",
                key: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
            },
        ];
        await mocks.enable("github");
        // 2 MiB is twice the webhook cap; the signature is garbage so the
        // only early exit available is the body limit.
        const response = await SELF.fetch(WEBHOOK_URL, {
            method: "POST",
            headers: GITHUB_WEBHOOK_HEADERS,
            body: "x".repeat(2 * 1024 * 1024),
        });
        expect(response.status).toBe(413);
    });

    test("still verifies a small unsigned webhook body and rejects it with 401", async ({
        mocks,
    }) => {
        mocks.github.state.secretScanningPublicKeys = [
            {
                key_identifier: "test-secret-scanning-key",
                key: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
            },
        ];
        await mocks.enable("github");
        const response = await SELF.fetch(WEBHOOK_URL, {
            method: "POST",
            headers: GITHUB_WEBHOOK_HEADERS,
            body: "[]",
        });
        expect(response.status).toBe(401);
    });

    test("rejects an oversized POST /api/device/code body", async () => {
        const response = await SELF.fetch(DEVICE_CODE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                client_id: "unknown",
                filler: "x".repeat(128 * 1024),
            }),
        });
        expect(response.status).toBe(413);
    });

    test("still answers a small POST /api/device/code body normally", async () => {
        const response = await SELF.fetch(DEVICE_CODE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ client_id: "unknown" }),
        });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe("invalid_client");
    });

    test("rejects an oversized POST /api/device/token body", async () => {
        const response = await SELF.fetch(DEVICE_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `device_code=x&filler=${"x".repeat(128 * 1024)}`,
        });
        expect(response.status).toBe(413);
    });

    test("still answers a small POST /api/device/token body normally", async () => {
        const response = await SELF.fetch(DEVICE_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "device_code=x&grant_type=urn:ietf:params:oauth:grant-type:device_code",
        });
        expect(response.status).toBe(400);
    });

    test("rejects an oversized POST /api/oauth/token body", async () => {
        const response = await SELF.fetch(OAUTH_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: `grant_type=authorization_code&filler=${"x".repeat(128 * 1024)}`,
        });
        expect(response.status).toBe(413);
    });

    test("still answers a small POST /api/oauth/token body normally", async () => {
        const response = await SELF.fetch(OAUTH_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: "grant_type=authorization_code&code=x&client_id=y",
        });
        expect(response.status).toBe(400);
    });
});

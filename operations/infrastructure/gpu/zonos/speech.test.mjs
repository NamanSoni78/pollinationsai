import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, it, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const service = path.join(here, "speech.mjs");
const port = Number(process.env.ZONOS_TEST_PORT) || 19299;

/**
 * Spawns the speech service the way setup-vast.sh does (PLN_GPU_TOKEN in the
 * environment), then talks to it over loopback. The model server is never
 * needed: the backend-token gate runs before any upstream work.
 */
async function waitForServer(url, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            await fetch(url, { method: "POST" });
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    throw new Error(`speech service did not start: ${lastError}`);
}

function startService(env) {
    return spawn(process.execPath, [service], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

describe("zonos speech backend token", () => {
    let child;

    before(async () => {
        child = startService({
            PLN_GPU_TOKEN: "test-backend-token",
            ZONOS_PORT: String(port),
        });
        child.stderr.setEncoding("utf8");
        await waitForServer(`http://127.0.0.1:${port}/speech`);
    });

    after(async () => {
        child?.kill("SIGTERM");
        if (child) await once(child, "exit").catch(() => {});
    });

    it("refuses to start without PLN_GPU_TOKEN", async () => {
        const bare = startService({
            PLN_GPU_TOKEN: "",
            ZONOS_PORT: String(port + 1),
        });
        const [code] = await once(bare, "exit");
        assert.notEqual(code, 0, "service must refuse to start tokenless");
    });

    it("rejects requests without the backend token", async () => {
        const response = await fetch(`http://127.0.0.1:${port}/speech`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "Hello", format: "mp3" }),
        });
        assert.equal(response.status, 403);
    });

    it("rejects a wrong backend token", async () => {
        const response = await fetch(`http://127.0.0.1:${port}/speech`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-backend-token": "not-the-token",
            },
            body: JSON.stringify({ text: "Hello", format: "mp3" }),
        });
        assert.equal(response.status, 403);
    });

    it("accepts the backend token and reaches request validation", async () => {
        const response = await fetch(`http://127.0.0.1:${port}/speech`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-backend-token": "test-backend-token",
            },
            body: "not json",
        });
        // Authentication passed; the malformed body is a client error.
        assert.equal(response.status, 400);
    });
});

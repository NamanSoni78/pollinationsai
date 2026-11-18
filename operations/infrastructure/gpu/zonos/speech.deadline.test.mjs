import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, it, before, after } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const service = path.join(here, "speech.mjs");
const port = Number(process.env.ZONOS_TEST_PORT) || 19301;

/**
 * A model server that answers and then goes silent: it accepts the generate
 * request and either never responds (timeToFirstByte case) or streams a
 * little float32 audio and then stalls (watchdog case). This is the failure
 * shape that used to wedge one of the six GPU slots forever.
 */
function startSilentModel(mode) {
    const server = createServer((request, response) => {
        if (mode === "stall-mid-stream") {
            response.writeHead(200, {
                "x-audio-sample-rate": "24000",
                "x-audio-format": "float32",
                "x-audio-channels": "1",
            });
            // One second of real audio so the encoder emits its first
            // packets (the response turns 200 and starts flowing) before
            // the stall.
            const samples = new Float32Array(24_000).fill(0.05);
            response.write(Buffer.from(samples.buffer));
            // and then: silence, forever
        }
        // timeToFirstByte case: accept and never answer
        request.resume();
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server));
    });
}

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

/** Race a promise against "it hung" so a wedged request fails the test fast. */
function within(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(
                () => reject(new Error(`${label}: no completion within ${ms}ms`)),
                ms,
            ).unref(),
        ),
    ]);
}

describe("zonos speech deadlines", () => {
    let child;
    let model;

    before(async () => {
        model = await startSilentModel("timeToFirstByte");
        child = spawn(process.execPath, [service], {
            env: {
                ...process.env,
                ZONOS_PORT: String(port),
                ZONOS_MODEL_URL: `http://127.0.0.1:${model.address().port}/v2/generate`,
                ZONOS_TTFB_TIMEOUT_MS: "500",
                ZONOS_MAX_SPEECH_MS: "1500",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        await waitForServer(`http://127.0.0.1:${port}/speech`);
    });

    after(async () => {
        child?.kill("SIGTERM");
        if (child) await once(child, "exit").catch(() => {});
        model?.close();
    });

    it("fails fast when the model server accepts but never speaks", async () => {
        const started = Date.now();
        const response = await within(
            fetch(`http://127.0.0.1:${port}/speech`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: "Hello", format: "mp3" }),
            }),
            5000,
            "time-to-first-byte request",
        );
        const elapsed = Date.now() - started;
        assert.equal(response.status, 502);
        // The 500ms TTFB deadline must fire; 5s would mean no deadline at all.
        assert.ok(elapsed < 4000, `took ${elapsed}ms; deadline did not fire`);
    });

    it("releases the slot when the model stalls mid-stream (watchdog)", async () => {
        // Second instance against a model that streams a second of audio and
        // then stalls. Whether the encoder managed to emit its first packet
        // before the watchdog (200 + truncated stream) or not (502) depends
        // on timing; the invariant under test is that the request — and the
        // slot — settle on their own instead of waiting for the client.
        const stallModel = await startSilentModel("stall-mid-stream");
        const second = spawn(process.execPath, [service], {
            env: {
                ...process.env,
                ZONOS_PORT: String(port + 1),
                ZONOS_MODEL_URL: `http://127.0.0.1:${stallModel.address().port}/v2/generate`,
                ZONOS_TTFB_TIMEOUT_MS: "500",
                ZONOS_MAX_SPEECH_MS: "800",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        try {
            await waitForServer(`http://127.0.0.1:${port + 1}/speech`);
            const response = await within(
                fetch(`http://127.0.0.1:${port + 1}/speech`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text: "Hello", format: "pcm" }),
                }),
                5000,
                "watchdog request",
            );
            assert.ok(
                response.status === 200 || response.status === 502,
                `unexpected status ${response.status}`,
            );
            // The stream must terminate (error or end) instead of hanging.
            await within(
                response.arrayBuffer().catch(() => "terminated"),
                4000,
                "watchdog stream termination",
            );
            // And the slot must actually be free again: a fresh request is
            // served (or shed with 429) rather than never answered.
            const probe = await within(
                fetch(`http://127.0.0.1:${port + 1}/speech`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ text: "Hi", format: "pcm" }),
                }),
                4000,
                "slot reuse after watchdog",
            );
            assert.ok(
                probe.status === 200 || probe.status === 502 || probe.status === 429,
                `slot not reusable: ${probe.status}`,
            );
            probe.body?.cancel().catch(() => {});
        } finally {
            second.kill("SIGTERM");
            await once(second, "exit").catch(() => {});
            stallModel.close();
        }
    });
});

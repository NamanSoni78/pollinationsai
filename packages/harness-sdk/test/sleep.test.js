import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { sleepVia, wakeSleepers } from "../src/sleep.js";

test("timer mode resolves after the requested seconds", async () => {
    const started = Date.now();
    const wake = await sleepVia({ seconds: 0.05 });
    assert.deepEqual(wake, { wake_reason: "timer" });
    assert.ok(Date.now() - started >= 40, "actually waited");
});

test("event mode wakes on the mapped emitter event with its payload", async () => {
    const emitter = new EventEmitter();
    const pending = sleepVia(
        { until_event: "ground_artifact", max_wait_sec: 5 },
        { emitter },
    );
    setTimeout(
        () => emitter.emit("ground.artifact", { key: "app/1", version: 2 }),
        20,
    );
    const wake = await pending;
    assert.equal(wake.wake_reason, "event");
    assert.deepEqual(wake.event_payload, { key: "app/1", version: 2 });
    assert.equal(
        emitter.listenerCount("ground.artifact"),
        0,
        "listener cleaned up after the wake",
    );
});

test("event mode wakes via the registry when no emitter is wired", async () => {
    const registry = new Map();
    const pending = sleepVia(
        { until_event: "ground_reply", max_wait_sec: 5 },
        { registry },
    );
    const woken = wakeSleepers(registry, "ground.reply", {
        answer: "yes",
        status: "answered",
    });
    assert.equal(woken, 1);
    const wake = await pending;
    assert.equal(wake.wake_reason, "event");
    assert.deepEqual(wake.event_payload, { answer: "yes", status: "answered" });
    assert.equal(registry.size, 0, "registry entry cleaned up after the wake");
});

test("event mode falls back to max_wait when nothing wakes it", async () => {
    const started = Date.now();
    const wake = await sleepVia({
        until_event: "process_exit",
        max_wait_sec: 0.05,
    });
    assert.deepEqual(wake, { wake_reason: "max_wait" });
    assert.ok(Date.now() - started >= 40);
});

test("wakeSleepers with no sleepers is a no-op", () => {
    assert.equal(wakeSleepers(new Map(), "ground.artifact", {}), 0);
    assert.equal(wakeSleepers(null, "ground.artifact", {}), 0);
});

test("unknown until_event rejects", async () => {
    await assert.rejects(
        () => sleepVia({ until_event: "carrier_pigeon" }, {}),
        /unknown until_event/,
    );
});

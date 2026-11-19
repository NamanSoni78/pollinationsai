import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGround } from "../src/index.js";

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ground-bb-"));
}

async function makeGround(t) {
    const dir = tmpDir();
    const ground = await createGround({ port: 0, stateDir: dir });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return ground;
}

test("publish v1 then v2: subscriber receives ground.artifact twice; republishing v2 fails", async (t) => {
    const ground = await makeGround(t);

    const { subscription_id } = ground.subscribe({
        agent_id: "sub-1",
        artifact_keys: ["design.spec"],
    });
    assert.ok(subscription_id);

    const received = [];
    ground.events.on("ground.artifact", (evt) => received.push(evt));

    const first = ground.publishArtifact({
        key: "design.spec",
        content_type: "application/json",
        payload: { body: "v1" },
        changelog: "first draft",
        publisher: "agent-a",
    });
    assert.equal(first.artifact_uri, "ground://design.spec@1");

    const second = ground.publishArtifact({
        key: "design.spec",
        payload: { body: "v2" },
        changelog: "second draft",
        publisher: "agent-a",
    });
    assert.equal(second.artifact_uri, "ground://design.spec@2");

    assert.throws(
        () =>
            ground.publishArtifact({
                key: "design.spec",
                version: 2,
                payload: {},
                publisher: "agent-a",
            }),
        (err) => err.status === 409 && /immutable/.test(err.message),
    );

    assert.equal(received.length, 2);
    assert.deepEqual(
        { ...received[0] },
        {
            key: "design.spec",
            version: 1,
            publisher: "agent-a",
            changelog: "first draft",
            subscription_id,
            agent_id: "sub-1",
        },
    );
    assert.equal(received[1].version, 2);
    assert.equal(received[1].subscription_id, subscription_id);
});

test("publish without a matching subscription still emits one global ground.artifact", async (t) => {
    const ground = await makeGround(t);
    const received = [];
    ground.events.on("ground.artifact", (evt) => received.push(evt));

    ground.publishArtifact({
        key: "orphan.spec",
        payload: "x",
        publisher: "agent-a",
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].key, "orphan.spec");
    assert.equal("subscription_id" in received[0], false);
});

test("subscriptions match by publisher agent_ids as well as artifact_keys", async (t) => {
    const ground = await makeGround(t);
    ground.subscribe({ agent_id: "sub-2", agent_ids: ["publisher-b"] });
    const received = [];
    ground.events.on("ground.artifact", (evt) => received.push(evt));

    ground.publishArtifact({
        key: "doc",
        payload: 1,
        publisher: "publisher-c",
    });
    ground.publishArtifact({
        key: "doc",
        payload: 2,
        publisher: "publisher-b",
    });

    assert.equal(received.length, 2);
    assert.equal(
        "subscription_id" in received[0],
        false,
        "non-matching publish has no subscription_id",
    );
    assert.equal(received[1].agent_id, "sub-2");
    assert.equal(received[1].publisher, "publisher-b");
});

test("fetchArtifact returns latest or exact version; null when missing", async (t) => {
    const ground = await makeGround(t);
    ground.publishArtifact({ key: "api.md", payload: "v1", publisher: "a" });
    ground.publishArtifact({ key: "api.md", payload: "v2", publisher: "a" });
    ground.publishArtifact({ key: "api.md", payload: "v3", publisher: "a" });

    assert.equal(ground.fetchArtifact("api.md").version, 3);
    assert.equal(ground.fetchArtifact("api.md", 1).payload, "v1");
    assert.equal(ground.fetchArtifact("api.md", 2).version, 2);
    assert.equal(ground.fetchArtifact("missing"), null);
    assert.equal(ground.fetchArtifact("api.md", 99), null);
});

test("publish validation and immutability per (key, version)", async (t) => {
    const ground = await makeGround(t);
    assert.throws(
        () => ground.publishArtifact({ payload: "x" }),
        /key is required/,
    );
    assert.throws(
        () => ground.publishArtifact({ key: "k", version: 0, payload: "x" }),
        /positive integer/,
    );
    assert.throws(
        () => ground.publishArtifact({ key: "k", version: 1.5, payload: "x" }),
        /positive integer/,
    );
    ground.publishArtifact({
        key: "k",
        version: 7,
        payload: "x",
        publisher: "a",
    });
    assert.equal(ground.fetchArtifact("k").version, 7);
    ground.publishArtifact({ key: "k", payload: "y", publisher: "a" });
    assert.equal(
        ground.fetchArtifact("k").version,
        8,
        "auto version continues after an explicit version",
    );
});

test("subscribe validation", async (t) => {
    const ground = await makeGround(t);
    assert.throws(() => ground.subscribe({}), /agent_id is required/);
    assert.throws(
        () => ground.subscribe({ agent_id: "x", artifact_keys: "nope" }),
        /artifact_keys must be an array/,
    );
    assert.throws(
        () => ground.subscribe({ agent_id: "x", agent_ids: 42 }),
        /agent_ids must be an array/,
    );
    const ok = ground.subscribe({
        agent_id: "x",
        artifact_keys: ["a", "b"],
        agent_ids: ["c"],
    });
    assert.ok(ok.subscription_id);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGround } from "../src/index.js";
import { validateCard } from "../src/registry.js";

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ground-test-"));
}

function fullCard(overrides = {}) {
    return {
        agent_id: "agent-alpha",
        owner_pollinations_id: "octo-dev",
        role: "worker",
        current_goal: "ship the auth module",
        status: "working",
        stack: ["node", "express"],
        owned_paths: ["src/auth"],
        published_artifacts: [],
        preview_url: "https://alpha.example.com",
        last_summary: "wiring token validation",
        workspace: "/tmp/does-not-matter",
        ...overrides,
    };
}

test("validateCard accepts the full spec 2.5 shape and fills defaults", () => {
    const card = validateCard({
        agent_id: "a",
        owner_pollinations_id: "o",
        role: "r",
    });
    assert.equal(card.status, "booting");
    assert.deepEqual(card.stack, []);
    assert.deepEqual(card.owned_paths, []);
    assert.deepEqual(card.published_artifacts, []);
    assert.equal(card.current_goal, "");
    assert.equal(card.workspace, "");
});

test("validateCard rejects invalid cards", () => {
    assert.throws(() => validateCard({}), /agent_id is required/);
    assert.throws(
        () => validateCard({ agent_id: "a" }),
        /owner_pollinations_id is required/,
    );
    assert.throws(
        () => validateCard({ agent_id: "a", owner_pollinations_id: "o" }),
        /role is required/,
    );
    assert.throws(
        () => validateCard(fullCard({ status: "vibing" })),
        /status must be one of/,
    );
    assert.throws(
        () => validateCard(fullCard({ stack: "node" })),
        /stack must be an array/,
    );
    assert.throws(
        () => validateCard(fullCard({ preview_url: 42 })),
        /preview_url must be a string/,
    );
});

test("register + list agents with validation and filtering", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({ port: 0, stateDir: dir });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const cardEvents = [];
    ground.events.on("agent.card", (evt) => cardEvents.push(evt));

    const saved = ground.registerAgent(fullCard());
    assert.equal(saved.agent_id, "agent-alpha");
    assert.equal(saved.status, "working");
    ground.registerAgent(
        fullCard({ agent_id: "agent-beta", role: "indexer", status: "idle" }),
    );

    assert.equal(ground.listAgents().length, 2);
    assert.equal(ground.listAgents({ status: "idle" }).length, 1);
    assert.equal(
        ground.listAgents({ status: "idle" })[0].agent_id,
        "agent-beta",
    );
    assert.equal(ground.listAgents({ role: "worker" }).length, 1);

    assert.throws(
        () => ground.registerAgent({ agent_id: "bad" }),
        /owner_pollinations_id is required/,
    );
    assert.deepEqual(
        cardEvents.map((e) => e.agentId),
        ["agent-alpha", "agent-beta"],
    );
    assert.deepEqual(Object.keys(cardEvents[0]), ["agentId", "status"]);
});

test("updateCard merges patches, validates them and keeps agent_id", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({ port: 0, stateDir: dir });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    ground.registerAgent(fullCard());
    const updated = ground.updateCard("agent-alpha", {
        status: "budget_paused",
        last_summary: "paused",
    });
    assert.equal(updated.status, "budget_paused");
    assert.equal(updated.last_summary, "paused");
    assert.equal(updated.role, "worker");
    assert.throws(
        () => ground.updateCard("agent-alpha", { status: "nope" }),
        /status must be one of/,
    );
    assert.throws(
        () => ground.updateCard("ghost", { status: "idle" }),
        /unknown agent: ghost/,
    );
});

test("persistence: stop() then reboot on the same stateDir restores registry, blackboard and subscriptions", async (t) => {
    const dir = tmpDir();

    const first = await createGround({ port: 0, stateDir: dir });
    first.registerAgent(fullCard());
    first.registerAgent(fullCard({ agent_id: "agent-beta" }));
    await first.publishArtifact({
        key: "design.spec",
        payload: { v: 1 },
        publisher: "agent-alpha",
        changelog: "first",
    });
    await first.subscribe({
        agent_id: "agent-beta",
        artifact_keys: ["design.spec"],
    });
    first.broadcast({
        kind: "milestone",
        from: "agent-alpha",
        summary: "v1 done",
    });
    await first.stop();

    const state = JSON.parse(
        fs.readFileSync(path.join(dir, "state.json"), "utf8"),
    );
    assert.equal(state.agents.length, 2);
    assert.equal(Object.keys(state.artifacts).length, 1);
    assert.equal(state.subscriptions.length, 1);
    assert.ok(
        !JSON.stringify(state).includes("apiKey"),
        "state.json must never contain credentials",
    );

    const second = await createGround({ port: 0, stateDir: dir });
    t.after(async () => {
        await second.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    assert.equal(second.listAgents().length, 2);
    assert.deepEqual(second.listAgents()[0].stack, ["node", "express"]);
    const artifact = second.fetchArtifact("design.spec");
    assert.equal(artifact.version, 1);
    assert.deepEqual(artifact.payload, { v: 1 });
    // watercooler is in-memory only: nothing restored
    assert.deepEqual(second.watercooler(), []);
    // restored subscription still matches new publishes
    const received = [];
    second.events.on("ground.artifact", (evt) => received.push(evt));
    await second.publishArtifact({
        key: "design.spec",
        payload: { v: 2 },
        publisher: "agent-alpha",
        changelog: "second",
    });
    assert.equal(received.length, 1);
    assert.equal(received[0].agent_id, "agent-beta");
});

test("watercooler keeps only the last 200 broadcasts", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({ port: 0, stateDir: dir });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    for (let i = 0; i <= 204; i++) {
        ground.broadcast({
            kind: "milestone",
            from: "agent-alpha",
            summary: `m${i}`,
        });
    }
    const feed = ground.watercooler();
    assert.equal(feed.length, 200);
    assert.equal(feed[0].summary, "m5");
    assert.equal(feed[199].summary, "m204");
    assert.deepEqual(
        ground.watercooler(2).map((e) => e.summary),
        ["m203", "m204"],
    );
});

test("broadcast validates kind and emits ground.broadcast", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({ port: 0, stateDir: dir });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const seen = [];
    ground.events.on("ground.broadcast", (evt) => seen.push(evt));
    const entry = ground.broadcast({
        kind: "needs_review",
        from: "agent-alpha",
        summary: "please review",
    });
    assert.equal(entry.kind, "needs_review");
    assert.ok(entry.at);
    assert.deepEqual(seen, [
        { kind: "needs_review", from: "agent-alpha", summary: "please review" },
    ]);
    assert.throws(
        () => ground.broadcast({ kind: "gossip", from: "a", summary: "s" }),
        /kind must be one of/,
    );
    assert.throws(
        () => ground.broadcast({ kind: "blocked", summary: "s" }),
        /from is required/,
    );
});

test("requestPeerCheck: 2xx passes, 500 fails, refused connection fails", async (t) => {
    const dir = tmpDir();
    const target = http.createServer((req, res) => {
        if (req.url === "/ok") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("fine");
        } else {
            res.writeHead(500);
            res.end("boom");
        }
    });
    await new Promise((resolve) => target.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        target.closeAllConnections?.();
        target.close();
    });

    const throwaway = http.createServer();
    await new Promise((resolve) => throwaway.listen(0, "127.0.0.1", resolve));
    const refusedPort = throwaway.address().port;
    await new Promise((resolve) => throwaway.close(resolve));

    const ground = await createGround({ port: 0, stateDir: dir });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${target.address().port}`;

    const ok = await ground.requestPeerCheck({
        reviewer_agent_id: "rev",
        target_url: `${base}/ok`,
    });
    assert.equal(ok.status, "passed");
    assert.deepEqual(ok.findings, [
        { check: "http_status", ok: true, status: 200 },
    ]);

    const bad = await ground.requestPeerCheck({
        reviewer_agent_id: "rev",
        target_url: `${base}/boom`,
    });
    assert.equal(bad.status, "failed");
    assert.deepEqual(bad.findings, [
        { check: "http_status", ok: false, status: 500 },
    ]);

    const refused = await ground.requestPeerCheck({
        reviewer_agent_id: "rev",
        target_url: `http://127.0.0.1:${refusedPort + 1}/nowhere`,
    });
    assert.equal(refused.status, "failed");
    assert.equal(refused.findings[0].ok, false);
    assert.ok(refused.findings[0].error);

    await assert.rejects(
        () =>
            ground.requestPeerCheck({
                reviewer_agent_id: "rev",
                target_url: "ftp://nope",
            }),
        /target_url must be an http/,
    );
});

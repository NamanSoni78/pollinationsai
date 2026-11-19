import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createGround } from "../src/index.js";

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ground-http-"));
}

async function makeUiDir(root) {
    const uiDir = path.join(root, "ui");
    fs.mkdirSync(uiDir, { recursive: true });
    fs.writeFileSync(
        path.join(uiDir, "index.html"),
        "<!doctype html><title>ground</title>\n",
    );
    fs.writeFileSync(path.join(uiDir, "app.js"), "console.log('ground');\n");
    fs.writeFileSync(path.join(uiDir, "styles.css"), "body { margin: 0; }\n");
    return uiDir;
}

async function makeWorkspace(root) {
    const workspace = path.join(root, "agent-workspace");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(
        path.join(workspace, "src", "auth.js"),
        "// token validation lives here\n",
    );
    fs.writeFileSync(
        path.join(workspace, "WORKLOG.md"),
        "- milestone 1: booted\n",
    );
    return workspace;
}

async function call(port, method, pathname, body) {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers:
            body === undefined ? {} : { "content-type": "application/json" },
    });
    const text = await response.text();
    let data = null;
    try {
        data = JSON.parse(text);
    } catch {
        /* non-JSON body (static files) */
    }
    return { status: response.status, data, headers: response.headers, text };
}

async function startStubGen() {
    const server = http.createServer((req, res) => {
        const respond = (status, payload) => {
            const data = JSON.stringify(payload);
            res.writeHead(status, {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
            });
            res.end(data);
        };
        if (req.headers.authorization !== "Bearer polli_sk_test_fake") {
            return respond(401, { error: "bad key" });
        }
        if (req.url === "/account/profile") {
            return respond(200, { githubUsername: "octo-dev", image: null });
        }
        if (req.url === "/account/balance") {
            return respond(200, { balance: 1.91 });
        }
        respond(404, { error: "no route" });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return server;
}

test("GET /api/session assembles the full dashboard payload", async (t) => {
    const dir = tmpDir();
    const workspace = await makeWorkspace(dir);
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const empty = (await call(ground.port, "GET", "/api/session")).data;
    assert.deepEqual(Object.keys(empty).sort(), [
        "agents",
        "artifacts",
        "budget",
        "identity",
        "warden",
        "watercooler",
    ]);
    assert.equal(empty.identity, null, "identity null before auth");
    assert.equal(
        empty.budget,
        null,
        "budget null without injected budgetControl",
    );
    assert.deepEqual(empty.warden, [], "warden empty array without closeLoop");

    ground.registerAgent({
        agent_id: "a1",
        owner_pollinations_id: "octo-dev",
        role: "worker",
        workspace,
    });
    ground.broadcast({ kind: "milestone", from: "a1", summary: "started" });
    ground.publishArtifact({ key: "spec", payload: { x: 1 }, publisher: "a1" });

    const session = (await call(ground.port, "GET", "/api/session")).data;
    assert.equal(session.agents.length, 1);
    assert.equal(session.watercooler.length, 1);
    assert.equal(session.artifacts.length, 1);
    assert.equal(session.artifacts[0].key, "spec");
    assert.equal(session.artifacts[0].versions.length, 1);
    assert.equal(
        "payload" in session.artifacts[0].versions[0],
        false,
        "session artifacts are metadata-only",
    );
});

test("missing injections return 503 not_configured", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const closeLoop = await call(ground.port, "POST", "/api/close-loop", {
        answers: {},
    });
    assert.equal(closeLoop.status, 503);
    assert.deepEqual(closeLoop.data, { error: "not_configured" });

    const budget = await call(ground.port, "POST", "/api/budget", {
        maxPollen: 5,
    });
    assert.equal(budget.status, 503);
    assert.deepEqual(budget.data, { error: "not_configured" });

    const topUp = await call(ground.port, "POST", "/api/budget/topup", {
        amount: 1,
    });
    assert.equal(topUp.status, 503);

    const warden = await call(ground.port, "GET", "/api/warden");
    assert.equal(warden.status, 503);
    assert.deepEqual(warden.data, { error: "not_configured" });
});

test("injected budgetControl and closeLoop are wired through", async (t) => {
    const dir = tmpDir();
    const calls = [];
    const budgetControl = {
        setBudget(n) {
            calls.push(["set", n]);
            return { ok: true };
        },
        topUp(n) {
            calls.push(["topUp", n]);
        },
        state() {
            return { maxPollen: 5, spent: 1, pct: 20, phase: "normal" };
        },
    };
    const closeLoop = {
        start: async (answers) => ({ ran: true, answers }),
        status: () => "AUTONOMOUS_EXECUTION",
        verdicts: () => [{ approved: true, contractId: "c1" }],
    };
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
        budgetControl,
        closeLoop,
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const budget = await call(ground.port, "POST", "/api/budget", {
        maxPollen: 5,
    });
    assert.equal(budget.status, 200);
    assert.deepEqual(budget.data, { ok: true, budget: budgetControl.state() });
    const topUp = await call(ground.port, "POST", "/api/budget/topup", {
        amount: 2,
    });
    assert.equal(topUp.status, 200);
    assert.deepEqual(calls, [
        ["set", 5],
        ["topUp", 2],
    ]);
    assert.equal(
        (await call(ground.port, "POST", "/api/budget", { maxPollen: -1 }))
            .status,
        400,
    );

    const closed = await call(ground.port, "POST", "/api/close-loop", {
        answers: { q1: "a1" },
    });
    assert.equal(closed.status, 200);
    assert.deepEqual(closed.data, {
        started: true,
        result: { ran: true, answers: { q1: "a1" } },
    });

    const warden = await call(ground.port, "GET", "/api/warden");
    assert.equal(warden.status, 200);
    assert.deepEqual(warden.data, {
        verdicts: [{ approved: true, contractId: "c1" }],
    });

    const session = (await call(ground.port, "GET", "/api/session")).data;
    assert.deepEqual(session.budget, {
        maxPollen: 5,
        spent: 1,
        pct: 20,
        phase: "normal",
    });
    assert.deepEqual(session.warden, [{ approved: true, contractId: "c1" }]);
});

test("POST /api/agents registers (201) and validates (400); GET lists and filters", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const created = await call(ground.port, "POST", "/api/agents", {
        agent_id: "a1",
        owner_pollinations_id: "octo-dev",
        role: "worker",
        status: "working",
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.agent_id, "a1");
    assert.deepEqual(created.data.stack, []);

    const invalid = await call(ground.port, "POST", "/api/agents", {
        agent_id: "",
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error, "invalid_agent_card");
    assert.ok(invalid.data.message.includes("agent_id is required"));

    await call(ground.port, "POST", "/api/agents", {
        agent_id: "a2",
        owner_pollinations_id: "octo-dev",
        role: "indexer",
        status: "idle",
    });
    const all = (await call(ground.port, "GET", "/api/agents")).data;
    assert.equal(all.agents.length, 2);
    const filtered = (await call(ground.port, "GET", "/api/agents?status=idle"))
        .data;
    assert.equal(filtered.agents.length, 1);
    assert.equal(filtered.agents[0].agent_id, "a2");
});

test("GET /api/artifacts lists payloads and fetches by key/version; missing -> 404", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    ground.publishArtifact({ key: "spec", payload: { v: 1 }, publisher: "a1" });
    ground.publishArtifact({ key: "spec", payload: { v: 2 }, publisher: "a1" });

    const list = (await call(ground.port, "GET", "/api/artifacts")).data;
    assert.equal(list.artifacts.length, 2);
    assert.deepEqual(list.artifacts[0].payload, { v: 1 });

    const exact = (
        await call(ground.port, "GET", "/api/artifacts?key=spec&version=1")
    ).data;
    assert.equal(exact.version, 1);
    const latest = (await call(ground.port, "GET", "/api/artifacts?key=spec"))
        .data;
    assert.equal(latest.version, 2);
    assert.equal(
        (await call(ground.port, "GET", "/api/artifacts?key=missing")).status,
        404,
    );
    assert.equal(
        (await call(ground.port, "GET", "/api/artifacts?key=spec&version=nope"))
            .status,
        400,
    );
});

test("POST /api/ask: readonly answers, negotiate queues, unavailable -> 409", async (t) => {
    const dir = tmpDir();
    const workspace = await makeWorkspace(dir);
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    ground.registerAgent({
        agent_id: "a1",
        owner_pollinations_id: "octo-dev",
        role: "worker",
        workspace,
    });
    ground.registerAgent({
        agent_id: "gone",
        owner_pollinations_id: "octo-dev",
        role: "worker",
        workspace: "/nonexistent/ws",
    });

    const readonly = await call(ground.port, "POST", "/api/ask", {
        target_agent_id: "a1",
        question: "where is token validation?",
    });
    assert.equal(readonly.status, 200);
    assert.equal(readonly.data.status, "answered");
    assert.ok(Array.isArray(readonly.data.citations));

    const negotiate = await call(ground.port, "POST", "/api/ask", {
        target_agent_id: "a1",
        question: "add caching",
        mode: "negotiate_change",
        from: "a2",
    });
    assert.equal(negotiate.status, 200);
    assert.deepEqual(negotiate.data, { answer: null, status: "queued" });
    const inbox = JSON.parse(
        fs.readFileSync(path.join(workspace, ".agent", "inbox.json"), "utf8"),
    );
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].from, "a2");

    const unavailable = await call(ground.port, "POST", "/api/ask", {
        target_agent_id: "gone",
        question: "hello?",
        mode: "negotiate_change",
    });
    assert.equal(unavailable.status, 409);
    assert.deepEqual(unavailable.data, { answer: null, status: "unavailable" });

    const unknown = await call(ground.port, "POST", "/api/ask", {
        target_agent_id: "ghost",
        question: "?",
    });
    assert.equal(unknown.status, 404);
});

test("POST /api/broadcast validates kind; POST /api/ask with bad JSON -> 400", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const ok = await call(ground.port, "POST", "/api/broadcast", {
        kind: "deployed",
        from: "a1",
        summary: "live on pages",
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.kind, "deployed");
    assert.equal(
        (
            await call(ground.port, "POST", "/api/broadcast", {
                kind: "nope",
                from: "a",
                summary: "s",
            })
        ).status,
        400,
    );

    const response = await fetch(`http://127.0.0.1:${ground.port}/api/ask`, {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
    });
    assert.equal(response.status, 400);
    await response.text();
});

test("POST /api/auth fetches GEN profile+balance, stores identity in memory only", async (t) => {
    const dir = tmpDir();
    const stub = await startStubGen();
    t.after(() => {
        stub.closeAllConnections?.();
        stub.close();
    });
    const previousBase = process.env.POLLINATIONS_BASE_URL;
    process.env.POLLINATIONS_BASE_URL = `http://127.0.0.1:${stub.address().port}`;
    t.after(() => {
        if (previousBase === undefined)
            delete process.env.POLLINATIONS_BASE_URL;
        else process.env.POLLINATIONS_BASE_URL = previousBase;
    });

    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    // a registry mutation persists state.json, which we inspect below
    const registered = await call(ground.port, "POST", "/api/agents", {
        agent_id: "a1",
        owner_pollinations_id: "octo-dev",
        role: "worker",
    });
    assert.equal(registered.status, 201);

    const auth = await call(ground.port, "POST", "/api/auth", {
        apiKey: "polli_sk_test_fake",
    });
    assert.equal(auth.status, 200);
    assert.deepEqual(auth.data, {
        profile: { githubUsername: "octo-dev", image: null },
        balance: 1.91,
    });

    const session = (await call(ground.port, "GET", "/api/session")).data;
    assert.deepEqual(session.identity, {
        githubUsername: "octo-dev",
        name: "octo-dev",
        email: "octo-dev@users.noreply.github.com",
        image: null,
    });

    const badKey = await call(ground.port, "POST", "/api/auth", {
        apiKey: "wrong",
    });
    assert.equal(badKey.status, 502);

    const stateRaw = fs.readFileSync(
        path.join(dir, "state", "state.json"),
        "utf8",
    );
    assert.ok(
        !stateRaw.includes("polli_sk_test_fake"),
        "stateDir never stores the API key",
    );
});

test("static uiDir serving: / -> index.html, /static/* with content types, traversal blocked", async (t) => {
    const dir = tmpDir();
    const uiDir = await makeUiDir(dir);
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
        uiDir,
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const index = await call(ground.port, "GET", "/");
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type"), /text\/html/);
    assert.ok(index.text.includes("<title>ground</title>"));

    const app = await call(ground.port, "GET", "/static/app.js");
    assert.equal(app.status, 200);
    assert.match(app.headers.get("content-type"), /text\/javascript/);

    const css = await call(ground.port, "GET", "/static/styles.css");
    assert.match(css.headers.get("content-type"), /text\/css/);

    assert.equal(
        (await call(ground.port, "GET", "/static/nope.js")).status,
        404,
    );
    assert.equal(
        (await call(ground.port, "GET", "/static/../../etc/passwd")).status,
        404,
    );
    assert.equal((await call(ground.port, "GET", "/missing")).status, 404);
    assert.equal((await call(ground.port, "GET", "/api/nope")).status, 404);
    assert.equal(
        (await call(ground.port, "DELETE", "/api/session")).status,
        405,
    );
});

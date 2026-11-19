import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { shadowRead, tokenize } from "../src/ask.js";
import { createGround } from "../src/index.js";

function tmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "agent-ground-ask-"));
}

function makeWorkspace(root) {
    const workspace = path.join(root, "agent-workspace");
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    const authLines = [
        "// auth module",
        "// entry point for all login flows",
        "export function validateSession(token) {",
        "    // token validation: check signature then expiry",
        "    if (!token) return false;",
        "    return checkSignature(token) && !isExpired(token);",
        "}",
    ];
    fs.writeFileSync(
        path.join(workspace, "src", "auth.js"),
        `${authLines.join("\n")}\n`,
    );
    fs.writeFileSync(
        path.join(workspace, "src", "payments.js"),
        "// payments module\n// handles invoices and refunds\nexport function refund() {}\n",
    );
    fs.writeFileSync(
        path.join(workspace, "README.md"),
        "# demo project\nA tiny example workspace.\n",
    );
    fs.writeFileSync(
        path.join(workspace, "WORKLOG.md"),
        Array.from(
            { length: 14 },
            (_, i) => `- milestone ${i + 1}: did thing ${i + 1}`,
        ).join("\n") + "\n",
    );
    return workspace;
}

/** Non-disruptive proof snapshot: every file's path, size, mtime and content hash. */
function snapshot(dir, prefix = "", out = {}) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            snapshot(full, `${prefix}${entry.name}/`, out);
        } else {
            const stat = fs.statSync(full);
            out[`${prefix}${entry.name}`] = [
                stat.size,
                stat.mtimeMs,
                crypto
                    .createHash("sha256")
                    .update(fs.readFileSync(full))
                    .digest("hex"),
            ];
        }
    }
    return out;
}

function cardFor(workspace, overrides = {}) {
    return {
        agent_id: "agent-alpha",
        owner_pollinations_id: "octo-dev",
        role: "worker",
        current_goal: "auth module",
        status: "working",
        workspace,
        ...overrides,
    };
}

test("tokenize splits lowercase alphanumeric terms", () => {
    assert.deepEqual(tokenize("Token-Validation, 42!"), [
        "token",
        "validation",
        "42",
    ]);
});

test("readonly askAgent answers with citations + WORKLOG tail and never touches the target workspace", async (t) => {
    const dir = tmpDir();
    const workspace = makeWorkspace(dir);
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    ground.registerAgent(cardFor(workspace));

    const replies = [];
    ground.events.on("ground.reply", (evt) => replies.push(evt));

    const before = snapshot(workspace);
    const result = await ground.askAgent({
        target_agent_id: "agent-alpha",
        question: "how does token validation work?",
        mode: "readonly_query",
    });

    assert.equal(result.status, "answered");
    assert.ok(Array.isArray(result.citations), "citations array is returned");
    const authCitation = result.citations.find((c) => c.path === "src/auth.js");
    assert.ok(authCitation, "src/auth.js is cited");
    assert.equal(authCitation.line, 4, "cites the token validation line");
    assert.ok(authCitation.excerpt.includes("token validation"));
    assert.ok(
        result.answer.includes("src/auth.js:4"),
        "answer quotes path:line",
    );
    assert.ok(
        result.answer.includes("milestone 5"),
        "WORKLOG tail lines are included",
    );
    assert.ok(result.answer.includes("milestone 14"));
    assert.ok(
        !result.answer.includes("milestone 3"),
        "only the last 10 WORKLOG lines are quoted",
    );

    const after = snapshot(workspace);
    assert.deepEqual(
        after,
        before,
        "target workspace files, sizes, mtimes and hashes are unchanged",
    );

    assert.equal(replies.length, 1);
    assert.deepEqual(
        { ...replies[0] },
        {
            targetAgentId: "agent-alpha",
            question: "how does token validation work?",
            answer: result.answer,
            status: "answered",
        },
    );
});

test("readonly shadowRead is directly callable and answers with citations", () => {
    const dir = tmpDir();
    try {
        const workspace = makeWorkspace(dir);
        const { answer, citations } = shadowRead(
            workspace,
            "what handles invoices and refunds?",
        );
        assert.ok(citations.some((c) => c.path === "src/payments.js"));
        assert.ok(answer.includes("src/payments.js:"));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("readonly askAgent: unknown agent throws 404; missing workspace returns unavailable", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    ground.registerAgent(cardFor("/nonexistent/workspace-xyz"));

    await assert.rejects(
        () => ground.askAgent({ target_agent_id: "ghost", question: "?" }),
        (err) => err.status === 404,
    );
    const result = await ground.askAgent({
        target_agent_id: "agent-alpha",
        question: "?",
    });
    assert.deepEqual(result, { answer: null, status: "unavailable" });
    await assert.rejects(
        () =>
            ground.askAgent({
                target_agent_id: "agent-alpha",
                question: "?",
                mode: "sneaky",
            }),
        /mode must be/,
    );
    await assert.rejects(
        () => ground.askAgent({ target_agent_id: "agent-alpha" }),
        /question is required/,
    );
});

test("negotiate askAgent appends to .agent/inbox.json and emits ground.inbox", async (t) => {
    const dir = tmpDir();
    const workspace = makeWorkspace(dir);
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    ground.registerAgent(cardFor(workspace));

    const inboxes = [];
    ground.events.on("ground.inbox", (evt) => inboxes.push(evt));

    assert.equal(
        fs.existsSync(path.join(workspace, ".agent")),
        false,
        "no .agent dir before negotiate",
    );

    const first = await ground.askAgent({
        target_agent_id: "agent-alpha",
        question: "please add response caching",
        mode: "negotiate_change",
        from: "agent-beta",
    });
    assert.deepEqual(first, { answer: null, status: "queued" });

    const inboxPath = path.join(workspace, ".agent", "inbox.json");
    assert.equal(fs.existsSync(inboxPath), true);
    const raw = fs.readFileSync(inboxPath, "utf8");
    assert.ok(raw.endsWith("\n"), "inbox.json ends with a newline");
    const entries = JSON.parse(raw);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].from, "agent-beta");
    assert.equal(entries[0].question, "please add response caching");
    assert.equal(entries[0].status, "pending");
    assert.ok(entries[0].id);
    assert.ok(entries[0].at);

    await ground.askAgent({
        target_agent_id: "agent-alpha",
        question: "also add metrics",
        mode: "negotiate_change",
    });
    assert.equal(
        JSON.parse(fs.readFileSync(inboxPath, "utf8")).length,
        2,
        "second request appends, not replaces",
    );
    assert.equal(
        JSON.parse(fs.readFileSync(inboxPath, "utf8"))[1].from,
        "parent",
        "from defaults to parent",
    );

    assert.equal(inboxes.length, 2);
    assert.deepEqual(inboxes[0], {
        agentId: "agent-alpha",
        from: "agent-beta",
        request: "please add response caching",
    });
    assert.deepEqual(inboxes[1], {
        agentId: "agent-alpha",
        from: "parent",
        request: "also add metrics",
    });
});

test("negotiate askAgent with a missing workspace returns unavailable", async (t) => {
    const dir = tmpDir();
    const ground = await createGround({
        port: 0,
        stateDir: path.join(dir, "state"),
    });
    t.after(async () => {
        await ground.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    });
    ground.registerAgent(cardFor("/nonexistent/workspace-xyz"));
    const result = await ground.askAgent({
        target_agent_id: "agent-alpha",
        question: "change something",
        mode: "negotiate_change",
    });
    assert.deepEqual(result, { answer: null, status: "unavailable" });
});

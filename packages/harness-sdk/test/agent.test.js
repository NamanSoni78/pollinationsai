import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentRuntime } from "../src/agent.js";
import { compileContext } from "../src/context.js";

// The git binary is driven inside temp workspaces only (allowed & required).
const run = (workspace, args) =>
    execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
const mkWorkspace = () => mkdtempSync(join(tmpdir(), "harness-agent-"));

const fakeGround = () => {
    const ground = {
        events: new EventEmitter(),
        calls: { register: [], cards: [], broadcasts: [] },
    };
    ground.registerAgent = (card) => ground.calls.register.push(card);
    ground.updateCard = (id, patch) => ground.calls.cards.push({ id, patch });
    ground.broadcast = (message) => ground.calls.broadcasts.push(message);
    return ground;
};

test("createAgentRuntime initializes workspace git, card and ground registration", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const ground = fakeGround();
    const runtime = createAgentRuntime({
        agentId: "a-1",
        role: "worker",
        workspace,
        ownedPaths: ["src/"],
        ground,
        identity: { username: "octo", email: "octo@example.com" },
        currentGoal: "ship the demo",
    });
    assert.equal(runtime.card.agent_id, "a-1");
    assert.equal(runtime.card.owner_pollinations_id, "octo");
    assert.equal(runtime.card.status, "booting");
    assert.equal(runtime.card.current_goal, "ship the demo");
    assert.deepEqual(runtime.card.owned_paths, ["src/"]);
    assert.deepEqual(runtime.card.stack, []);
    assert.equal(runtime.card.workspace, workspace);
    assert.equal(ground.calls.register.length, 1);
    assert.ok(existsSync(join(workspace, "WORKLOG.md")));
    assert.equal(
        run(workspace, ["branch", "--show-current"]),
        "agent/a-1/main",
    );
    assert.equal(run(workspace, ["config", "user.name"]), "octo");
    assert.equal(run(workspace, ["config", "user.email"]), "octo@example.com");
    assert.ok(
        run(workspace, ["log", "--format=%s"]).includes(
            "chore: agent workspace init",
        ),
    );
    assert.equal(runtime.state.telemetry.gitStatus, "on branch agent/a-1/main");
});

test("step() delivers inbox at the boundary, never mid-step (acceptance k)", async (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const runtime = createAgentRuntime({
        agentId: "a-2",
        workspace,
        ground: fakeGround(),
    });
    let inboxDuringAction = null;
    await runtime.step(() => {
        runtime.inbox({ from: "hub", request: "please integrate artifact x" });
        inboxDuringAction = runtime.state.telemetry.inbox.length;
    });
    assert.equal(inboxDuringAction, 0, "not delivered mid-step");
    assert.equal(runtime.inbox().pending.length, 1);
    assert.equal(runtime.inbox().delivered.length, 0);
    await runtime.step(() => "next step");
    assert.equal(runtime.inbox().pending.length, 0);
    assert.equal(runtime.inbox().delivered.length, 1);
    assert.equal(
        runtime.state.telemetry.inbox[0].request,
        "please integrate artifact x",
    );
    assert.equal(runtime.card.status, "idle");
    assert.equal(
        runtime.state.workingWindow.turns.length,
        2,
        "each step pushed a turn summary",
    );
});

test("requests appended to .agent/inbox.json are delivered at the next step", async (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const runtime = createAgentRuntime({ agentId: "a-5", workspace });
    writeFileSync(
        join(workspace, ".agent", "inbox.json"),
        `${JSON.stringify([{ from: "hub", request: "negotiate change" }])}\n`,
    );
    await runtime.step(() => "work");
    assert.equal(runtime.state.telemetry.inbox.length, 1);
    assert.equal(runtime.state.telemetry.inbox[0].request, "negotiate change");
    assert.deepEqual(
        JSON.parse(
            readFileSync(join(workspace, ".agent", "inbox.json"), "utf8"),
        ),
        [],
        "queue file drained",
    );
});

test("step() auto-compacts past 70% of the working window and archives", async (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const runtime = createAgentRuntime({
        agentId: "a-3",
        workspace,
        contextBudgetTokens: 400,
    });
    const result = await runtime.step(() => `big output ${"x".repeat(6000)}`);
    assert.ok(result.includes("big output"));
    assert.equal(
        runtime.state.workingWindow.turns.length,
        0,
        "window compacted",
    );
    assert.ok(
        readdirSync(join(workspace, ".agent", "logs")).length >= 2,
        "spill + compaction archive on disk",
    );
    assert.ok(
        readFileSync(join(workspace, "WORKLOG.md"), "utf8").includes(
            "compaction:",
        ),
    );
    assert.equal(runtime.state.messages.length, 0);
});

test("user messages pushed into state survive compaction verbatim (Layer 3 invariant)", async (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const runtime = createAgentRuntime({
        agentId: "a-3b",
        workspace,
        contextBudgetTokens: 400,
    });
    const userMessages = [
        "build the landing page",
        "add auth",
        "write tests",
        "deploy",
        "document",
    ];
    for (const message of userMessages) {
        runtime.state.messages.push({ role: "user", content: message });
    }
    await runtime.step(() => `${"y".repeat(6000)}`);
    const compiled = compileContext(runtime.state);
    for (const message of userMessages) {
        assert.ok(compiled.layers.userIntentAnchor.includes(message));
    }
});

test("milestone() updates WORKLOG, card, git and broadcasts (acceptance k)", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const ground = fakeGround();
    const runtime = createAgentRuntime({ agentId: "a-4", workspace, ground });
    const outcome = runtime.milestone("m1", "implemented the payments flow");
    assert.ok(outcome.sha);
    assert.equal(outcome.broadcasted, true);
    assert.ok(
        readFileSync(join(workspace, "WORKLOG.md"), "utf8").includes(
            "m1: implemented the payments flow",
        ),
    );
    assert.ok(
        runtime.state.worklog.includes("m1: implemented the payments flow"),
    );
    assert.equal(runtime.card.last_summary, "implemented the payments flow");
    assert.equal(ground.calls.cards.length, 1);
    assert.equal(ground.calls.cards[0].id, "a-4");
    assert.equal(ground.calls.broadcasts.length, 1);
    assert.equal(ground.calls.broadcasts[0].kind, "milestone");
    assert.equal(ground.calls.broadcasts[0].from, "a-4");
    assert.ok(run(workspace, ["log", "--format=%s"]).includes("milestone: m1"));
});

test("milestone() is a no-op broadcast without ground", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const runtime = createAgentRuntime({ agentId: "a-4b", workspace });
    const outcome = runtime.milestone("m0", "silent work");
    assert.equal(outcome.broadcasted, false);
    assert.ok(outcome.sha);
});

test("tools.git_checkpoint commits workspace changes", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const runtime = createAgentRuntime({ agentId: "a-6", workspace });
    writeFileSync(join(workspace, "feature.txt"), "hello");
    const { sha, committed } = runtime.tools.git_checkpoint({
        message: "feat: thing",
    });
    assert.equal(committed, true);
    assert.ok(sha);
    assert.ok(run(workspace, ["log", "--format=%s"]).includes("feat: thing"));
});

test("tools.request_warden_approval requires an injected warden", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const bare = createAgentRuntime({ agentId: "a-7", workspace });
    assert.throws(
        () => bare.tools.request_warden_approval({ proof: "tests" }),
        (error) => error.code === "warden_not_configured",
    );
    const warded = createAgentRuntime({
        agentId: "a-7b",
        workspace: mkWorkspace(),
        warden: {
            requestWardenApproval: (evidence) => ({ received: evidence }),
        },
    });
    t.after(() =>
        rmSync(warded.state.workspace, { recursive: true, force: true }),
    );
    assert.deepEqual(warded.tools.request_warden_approval({ proof: "tests" }), {
        received: { proof: "tests" },
    });
});

test("askUser always throws human_input_disabled", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const runtime = createAgentRuntime({ agentId: "a-8", workspace });
    assert.throws(
        () => runtime.askUser(),
        (error) => error.code === "human_input_disabled",
    );
});

test("skills tools move bodies in and out of Layer 2", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    mkdirSync(join(workspace, "skills", "demo"), { recursive: true });
    writeFileSync(
        join(workspace, "skills", "demo", "SKILL.md"),
        "---\nname: demo\ndescription: demo skill\n---\n\nDEMO-BODY-TEXT\n",
    );
    const runtime = createAgentRuntime({ agentId: "a-9", workspace });
    const listed = runtime.tools.list_skills();
    const demo = listed.find((entry) => entry.name === "demo");
    assert.equal(demo.loaded, false);
    assert.ok(
        listed.some((entry) => entry.name === "ponytail"),
        "repo skills are in the catalog too",
    );
    runtime.tools.load_skill({ name: "demo" });
    assert.ok(runtime.compile().layers.activeSkills.includes("DEMO-BODY-TEXT"));
    assert.equal(
        runtime.tools.list_skills().find((entry) => entry.name === "demo")
            .loaded,
        true,
    );
    assert.deepEqual(runtime.tools.unload_skill({ name: "demo" }), {
        unloaded: true,
    });
    assert.equal(runtime.compile().layers.activeSkills, "(no active skills)");
    assert.throws(
        () => runtime.tools.load_skill({ name: "missing" }),
        (error) => error.code === "skill_not_found",
    );
});

test("tools.rag_search indexes the workspace on demand", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
        join(workspace, "src", "thing.js"),
        "export function findThing() {\n    // flibbertigibbet target\n    return 42;\n}\n",
    );
    const runtime = createAgentRuntime({ agentId: "a-10", workspace });
    const { results } = runtime.tools.rag_search({ query: "flibbertigibbet" });
    assert.equal(results[0].file, "src/thing.js");
    assert.ok(existsSync(join(workspace, ".agent", "rag", "index.json")));
});

test("consult_expert is deterministic offline: structured packet, zero pollen", async (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
        join(workspace, "src", "app.js"),
        "export function build() {\n    throw new Error('boom');\n}\n",
    );
    const runtime = createAgentRuntime({ agentId: "a-11", workspace });
    const result = await runtime.tools.consult_expert({
        question: "why does the build fail",
        file_paths: ["src/app.js"],
        failed_attempts: ["npm run build"],
    });
    assert.equal(result.mode, "deterministic");
    assert.equal(result.pollen_cost, 0);
    assert.ok(result.guidance.includes("why does the build fail"));
    assert.ok(result.guidance.includes("throw new Error('boom');"));
    assert.ok(result.guidance.includes("npm run build"));
});

test("spawn_subagent: readonly research and sandbox branch modes", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
        join(workspace, "src", "rare.js"),
        "// the flibbertigibbet research target\n",
    );
    const runtime = createAgentRuntime({ agentId: "a-12", workspace });
    const readonly = runtime.tools.spawn_subagent({
        goal: "find the flibbertigibbet target",
    });
    assert.equal(readonly.mode, "readonly");
    assert.deepEqual(readonly.artifacts, []);
    assert.ok(readonly.summary.includes("flibbertigibbet"));
    assert.equal(readonly.results[0].file, "src/rare.js");

    const branched = runtime.tools.spawn_subagent({
        goal: "try a refactor",
        mode: "sandbox_branch",
    });
    assert.equal(branched.mode, "sandbox_branch");
    assert.ok(branched.branch.startsWith("subagent/a-12"));
    assert.equal(run(workspace, ["branch", "--show-current"]), branched.branch);
});

test("tools.sleep wraps sleepVia with the ground emitter", async (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const ground = fakeGround();
    const runtime = createAgentRuntime({ agentId: "a-13", workspace, ground });
    const timerWake = await runtime.tools.sleep({ seconds: 0.02 });
    assert.deepEqual(timerWake, { wake_reason: "timer" });
    const pending = runtime.tools.sleep({
        until_event: "ground_artifact",
        max_wait_sec: 5,
    });
    ground.events.emit("ground.artifact", { key: "art/1" });
    const eventWake = await pending;
    assert.equal(eventWake.wake_reason, "event");
    assert.deepEqual(eventWake.event_payload, { key: "art/1" });
});

test("step() returns the action result and compiles through tools.summarize_context", async (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const runtime = createAgentRuntime({ agentId: "a-14", workspace });
    const value = await runtime.step(() => ({ done: true }));
    assert.deepEqual(value, { done: true });
    const summary = runtime.tools.summarize_context();
    assert.ok(summary.tokenEstimate > 0);
    assert.ok(summary.layerTokens.userIntentAnchor >= 0);
    assert.ok(summary.text.includes("[Layer 3 — USER INTENT ANCHOR]"));
    assert.ok(runtime.compile().text.includes("[Layer 6 — WORKING WINDOW]"));
});

test("createAgentRuntime validates required options", () => {
    assert.throws(
        () => createAgentRuntime({ workspace: "/tmp/x" }),
        /requires agentId/,
    );
    assert.throws(
        () => createAgentRuntime({ agentId: "x" }),
        /requires workspace/,
    );
});

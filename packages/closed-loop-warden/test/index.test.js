import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { askUser, createClosedLoop } from "../src/index.js";

const workspaces = [];
const makeWorkspace = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clw-index-"));
    workspaces.push(dir);
    return dir;
};
after(() => {
    for (const dir of workspaces) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const commandReq = (description = "command passes") => ({
    description,
    verification_type: "command",
    must_pass: true,
    params: { command: ["node", "-e", "process.exit(0)"] },
});
const markerReq = (file, pattern) => ({
    description: "marker text present",
    verification_type: "file_contains",
    must_pass: true,
    params: { file, pattern },
});

test("(a) happy path: 3 passing requirements -> approved, COMPLETED, warden.verdict emitted", async () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(path.join(workspace, "index.html"), "<h1>hello</h1>\n");
    fs.writeFileSync(path.join(workspace, "notes.md"), "real content only\n");
    const loop = createClosedLoop({
        workspace,
        plan: [
            async function buildPage() {
                return "built the page";
            },
            async function verifyContent() {
                return "checked the page";
            },
        ],
    });
    const verdictEvents = [];
    loop.events.on("warden.verdict", (event) => verdictEvents.push(event));

    const questions = loop.startInterview();
    assert.ok(Array.isArray(questions) && questions.length >= 5);
    assert.equal(loop.phase(), "PREFLIGHT_INTERVIEW");

    const contract = loop.freezeContract({
        deploy_target: "none",
        requirements: [
            commandReq(),
            markerReq("index.html", "hello"),
            {
                description: "sources are clean of stub markers",
                verification_type: "no_stubs",
                must_pass: true,
            },
        ],
    });
    assert.deepEqual(
        contract.requirements.map((r) => r.id),
        ["REQ-1", "REQ-2", "REQ-3"],
    );
    const contractRaw = fs.readFileSync(
        path.join(workspace, "CONTRACT.json"),
        "utf8",
    );
    assert.ok(contractRaw.endsWith("\n"));
    assert.deepEqual(JSON.parse(contractRaw), contract);
    assert.equal(loop.phase(), "AUTONOMOUS_EXECUTION");

    const ticks = [];
    const verdict = await loop.run((phase) => ticks.push(phase));
    assert.equal(verdict.approved, true);
    assert.deepEqual(
        verdict.results.map((r) => r.status),
        ["PASS", "PASS", "PASS"],
    );
    assert.equal(loop.phase(), "COMPLETED");
    assert.deepEqual(verdict.required_actions, []);
    assert.equal(loop.verdicts().length, 1);
    assert.deepEqual(
        ticks.filter((p) => p === "AUTONOMOUS_EXECUTION").length,
        2,
    );
    assert.equal(ticks[ticks.length - 1], "COMPLETED");
    assert.equal(verdictEvents.length, 1);
    assert.deepEqual(verdictEvents[0], {
        type: "warden.verdict",
        at: verdictEvents[0].at,
        approved: true,
        contractId: contract.contract_id,
    });
    assert.equal(typeof verdictEvents[0].at, "string");
});

test("(b) reject -> fix -> approve with a req_id-keyed fixer", async () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(path.join(workspace, "feature.txt"), "draft\n");
    let fixCalls = 0;
    const loop = createClosedLoop({
        workspace,
        fixers: {
            "REQ-1": async () => {
                fixCalls += 1;
                fs.writeFileSync(
                    path.join(workspace, "feature.txt"),
                    "draft\nSHIPPED-FEATURE\n",
                );
            },
        },
    });
    loop.startInterview();
    loop.freezeContract({
        requirements: [markerReq("feature.txt", "SHIPPED-FEATURE")],
    });

    const verdict = await loop.run();
    assert.equal(verdict.approved, true);
    assert.equal(fixCalls, 1);
    assert.equal(loop.phase(), "COMPLETED");

    const history = loop.verdicts();
    assert.equal(history.length, 2);
    assert.equal(history[0].approved, false);
    assert.deepEqual(history[0].required_actions[0].req_id, "REQ-1");
    assert.match(
        history[0].required_actions[0].action,
        /^Fix requirement REQ-1: /,
    );
    assert.equal(history[1].approved, true);
    assert.equal(loop.state.rejected_count["REQ-1"], 0);
});

test("(c) double reject: third queued item is the consult_expert escalation packet", async () => {
    const workspace = makeWorkspace();
    const loop = createClosedLoop({ workspace });
    loop.startInterview();
    loop.freezeContract({ requirements: [markerReq("final.txt", "SHIPPED")] });

    const first = await loop.submitEvidence({ git_diff_stat: null });
    assert.equal(first.approved, false);
    assert.equal(loop.phase(), "AUTONOMOUS_EXECUTION");
    assert.equal(loop.state.rejected_count["REQ-1"], 1);
    assert.equal(loop.state.queue.length, 1);
    assert.equal(loop.state.queue[0].kind, "fix");

    const second = await loop.submitEvidence({ git_diff_stat: null });
    assert.equal(second.approved, false);
    assert.equal(loop.state.rejected_count["REQ-1"], 2);
    assert.equal(loop.phase(), "AUTONOMOUS_EXECUTION");

    const top = loop.state.queue[0];
    assert.equal(top.kind, "consult_expert");
    assert.deepEqual(Object.keys(top.packet).sort(), [
        "critique",
        "defect",
        "req_id",
        "required_actions",
    ]);
    assert.equal(top.packet.req_id, "REQ-1");
    assert.match(top.packet.defect, /final\.txt/);
    assert.equal(top.packet.required_actions.length, 1);
    assert.match(top.packet.required_actions[0], /^Fix requirement REQ-1: /);
    assert.equal(top.packet.critique, second.summary);

    assert.equal(loop.state.queue[1].kind, "fix");
    assert.equal(loop.state.queue[1].req_id, "REQ-1");
    // Across the two rejections the queue received: fix, fix, then the
    // escalation packet (injected at the top for the next round).
    assert.deepEqual(
        loop.state.queueLog.map((entry) => `${entry.kind}:${entry.req_id}`),
        ["fix:REQ-1", "fix:REQ-1", "consult_expert:REQ-1"],
    );
});

test("(j) warden exhaustion after maxWardenRounds; consult_expert packet delivered to the runtime", async () => {
    const workspace = makeWorkspace();
    const consults = [];
    const milestones = [];
    const runtime = {
        card: { agent_id: "agent-xyz" },
        milestone: async (id, summary) => {
            milestones.push({ id, summary });
        },
        tools: {
            consult_expert: async (packet) => {
                consults.push(packet);
            },
        },
    };
    const loop = createClosedLoop({
        workspace,
        runtime,
        maxWardenRounds: 3,
    });
    loop.startInterview();
    loop.freezeContract({ requirements: [markerReq("final.txt", "SHIPPED")] });

    await assert.rejects(
        () => loop.run(),
        (err) =>
            err.code === "warden_exhausted" &&
            err.verdict.approved === false &&
            err.verdict.round === 3,
    );
    assert.equal(loop.phase(), "AUTONOMOUS_EXECUTION");
    assert.equal(loop.verdicts().length, 3);
    assert.equal(consults.length, 1);
    assert.equal(consults[0].req_id, "REQ-1");
    assert.ok(consults[0].defect.includes("final.txt"));
    assert.ok(milestones.some((m) => m.id === "consult-REQ-1"));
    assert.ok(milestones.some((m) => m.id === "fix-REQ-1"));
    assert.equal(loop.state.fixLog.length, 2);
    assert.equal(loop.state.escalations.length, 1);
});

test("(e) invalid transitions throw with from/to", async () => {
    const loop = createClosedLoop({ workspace: makeWorkspace() });
    await assert.rejects(
        () => loop.submitEvidence({}),
        (err) =>
            err.code === "invalid_transition" &&
            err.from === "IM_CHAT" &&
            err.to === "WARDEN_AUDIT",
    );
    await assert.rejects(
        () => loop.run(),
        (err) =>
            err.code === "invalid_transition" &&
            err.from === "IM_CHAT" &&
            err.to === "AUTONOMOUS_EXECUTION",
    );
    assert.throws(
        () => loop.freezeContract({ requirements: [commandReq()] }),
        (err) =>
            err.code === "invalid_transition" &&
            err.from === "IM_CHAT" &&
            err.to === "AUTONOMOUS_EXECUTION",
    );

    loop.startInterview();
    assert.throws(
        () => loop.startInterview(),
        (err) =>
            err.code === "invalid_transition" &&
            err.from === "PREFLIGHT_INTERVIEW" &&
            err.to === "PREFLIGHT_INTERVIEW",
    );

    assert.throws(
        () =>
            loop.freezeContract({
                deploy_target: "vercel",
                requirements: [commandReq()],
            }),
        (err) => err.code === "invalid_contract",
    );
    assert.equal(loop.phase(), "PREFLIGHT_INTERVIEW");
    assert.throws(
        () => loop.freezeContract({}),
        (err) =>
            err.code === "invalid_contract" &&
            err.errors.some((e) => e.field === "requirements"),
    );
    assert.equal(loop.phase(), "PREFLIGHT_INTERVIEW");

    loop.freezeContract({ requirements: [commandReq()] });
    await loop.run();
    assert.equal(loop.phase(), "COMPLETED");
    await assert.rejects(
        () => loop.run(),
        (err) => err.code === "invalid_transition" && err.from === "COMPLETED",
    );
});

test("(f) durability: mid-run crash + fresh instance resumes at the right phase", async () => {
    const workspace = makeWorkspace();
    const loop1 = createClosedLoop({
        workspace,
        plan: [
            async function firstMilestone() {
                return "ok";
            },
            async function explodingMilestone() {
                throw new Error("simulated crash");
            },
        ],
    });
    loop1.startInterview();
    const contract1 = loop1.freezeContract({ requirements: [commandReq()] });
    await assert.rejects(() => loop1.run(), /simulated crash/);

    const loop2 = createClosedLoop({ workspace });
    const snap = loop2.resumeFromDisk();
    assert.equal(loop2.phase(), "AUTONOMOUS_EXECUTION");
    assert.equal(snap.phase, "AUTONOMOUS_EXECUTION");
    assert.equal(loop2.state.contract.contract_id, contract1.contract_id);
    assert.deepEqual(loop2.state.rejected_count, {});
    assert.deepEqual(snap.queue, [
        { type: "milestone", id: "explodingMilestone" },
    ]);
});

test("(f2) rejected_count persists across instances and drives escalation after restart", async () => {
    const workspace = makeWorkspace();
    const loopA = createClosedLoop({ workspace });
    loopA.startInterview();
    loopA.freezeContract({ requirements: [markerReq("out.txt", "SHIPPED")] });
    await loopA.submitEvidence({ git_diff_stat: null });

    const loopB = createClosedLoop({ workspace });
    const snap = loopB.resumeFromDisk();
    assert.equal(snap.rejected_count["REQ-1"], 1);
    assert.equal(loopB.phase(), "AUTONOMOUS_EXECUTION");
    await loopB.submitEvidence({ git_diff_stat: null });
    assert.equal(loopB.state.rejected_count["REQ-1"], 2);
    assert.equal(loopB.state.queue[0].kind, "consult_expert");
    assert.equal(loopB.state.queue[0].packet.req_id, "REQ-1");
});

test("(g) budget cutoff pauses run, budget.resumed returns to AUTONOMOUS and finishes", async () => {
    const workspace = makeWorkspace();
    const proxyEvents = new EventEmitter();
    const proxy = { events: proxyEvents };
    const loop = createClosedLoop({
        workspace,
        proxy,
        plan: [
            async function spendUntilCutoff() {
                proxyEvents.emit("budget.cutoff", { pct: 100 });
            },
        ],
    });
    const pausedEvents = [];
    loop.events.on("budget.paused", (event) => pausedEvents.push(event));
    loop.startInterview();
    loop.freezeContract({ requirements: [commandReq()] });

    const result = await loop.run();
    assert.deepEqual(result, { approved: false, paused: true });
    assert.equal(loop.phase(), "BUDGET_PAUSED");
    assert.equal(pausedEvents.length, 1);
    assert.equal(pausedEvents[0].type, "budget.paused");
    assert.equal(typeof pausedEvents[0].at, "string");
    assert.equal(pausedEvents[0].gitSha, null);
    assert.equal(
        pausedEvents[0].statePath,
        path.join(workspace, ".agent", "state.json"),
    );
    const persisted = JSON.parse(
        fs.readFileSync(path.join(workspace, ".agent", "state.json"), "utf8"),
    );
    assert.equal(persisted.phase, "BUDGET_PAUSED");

    proxyEvents.emit("budget.resumed", { maxPollen: 5 });
    assert.equal(loop.phase(), "AUTONOMOUS_EXECUTION");

    const verdict = await loop.run();
    assert.equal(verdict.approved, true);
    assert.equal(loop.phase(), "COMPLETED");
});

test("evidence bundle records a real git diff stat (git driven in a temp workspace)", async () => {
    const workspace = makeWorkspace();
    const git = (args) =>
        execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "agent@example.com"]);
    git(["config", "user.name", "Agent Ground"]);
    fs.writeFileSync(path.join(workspace, "base.txt"), "one\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "initial"]);

    const loop = createClosedLoop({
        workspace,
        plan: [
            function addFeatureFile() {
                fs.writeFileSync(
                    path.join(workspace, "feature-b.txt"),
                    "two\n",
                );
                execFileSync("git", ["add", "feature-b.txt"], {
                    cwd: workspace,
                });
                execFileSync("git", ["commit", "-q", "-m", "feature b"], {
                    cwd: workspace,
                });
            },
        ],
    });
    loop.startInterview();
    loop.freezeContract({ requirements: [commandReq()] });
    const verdict = await loop.run();
    assert.equal(verdict.approved, true);
    const evidence = loop.state.lastEvidence;
    assert.equal(evidence.preview_url, null);
    assert.deepEqual(evidence.test_outputs, []);
    assert.equal(typeof evidence.git_diff_stat, "string");
    assert.match(evidence.git_diff_stat, /feature-b\.txt/);
});

test("resumeFromDisk returns null without state and rejects unknown phases", () => {
    const empty = createClosedLoop({ workspace: makeWorkspace() });
    assert.equal(empty.resumeFromDisk(), null);

    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace, ".agent"), { recursive: true });
    fs.writeFileSync(
        path.join(workspace, ".agent", "state.json"),
        `${JSON.stringify({ phase: "SLEEPING" }, null, 4)}\n`,
    );
    const loop = createClosedLoop({ workspace });
    assert.throws(
        () => loop.resumeFromDisk(),
        (err) => err.code === "unknown_phase",
    );
});

test("askUser always throws human_input_disabled", () => {
    assert.throws(
        () => askUser(),
        (err) =>
            err.code === "human_input_disabled" &&
            /human input is disabled/.test(err.message),
    );
});

test("createClosedLoop validates options and mirrors phase on state", () => {
    assert.throws(
        () => createClosedLoop({}),
        (err) => err.code === "invalid_options",
    );
    const loop = createClosedLoop({ workspace: makeWorkspace() });
    assert.equal(loop.state.phase, "IM_CHAT");
    assert.equal(loop.phase(), "IM_CHAT");
    assert.deepEqual(loop.state.queue, []);
    assert.deepEqual(loop.verdicts(), []);
});

test("verdicts broadcast to the ground hub best-effort (kind blocked/milestone)", async () => {
    const broadcasts = [];
    const ground = {
        broadcast: (payload) => {
            broadcasts.push(payload);
        },
    };
    const runtime = { card: { agent_id: "agent-bc" } };
    const loop = createClosedLoop({
        workspace: makeWorkspace(),
        ground,
        runtime,
    });
    loop.startInterview();
    loop.freezeContract({ requirements: [commandReq()] });
    await loop.run();
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].kind, "milestone");
    assert.equal(broadcasts[0].from, "agent-bc");
    assert.match(broadcasts[0].summary, /approved/);
});

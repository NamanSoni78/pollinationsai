import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { persist, restore, STATE_FILE, statePath } from "../src/durable.js";

const workspaces = [];
const makeWorkspace = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clw-durable-"));
    workspaces.push(dir);
    return dir;
};
after(() => {
    for (const dir of workspaces) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function buildIt() {
    return "done";
}

test("persist writes the exact spec schema with a trailing newline", () => {
    const workspace = makeWorkspace();
    const body = persist(workspace, {
        phase: "AUTONOMOUS_EXECUTION",
        contract: { contract_id: "c1" },
        git_sha: "abc123",
        rejected_count: { "REQ-1": 2 },
        queue: [
            buildIt,
            { kind: "fix", req_id: "REQ-1", action: "make it pass" },
            {
                kind: "consult_expert",
                packet: { req_id: "REQ-1", defect: "d" },
            },
        ],
    });
    assert.equal(body.phase, "AUTONOMOUS_EXECUTION");
    const raw = fs.readFileSync(statePath(workspace), "utf8");
    assert.ok(raw.endsWith("\n"));
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed).sort(), [
        "active_skills",
        "contract",
        "git_sha",
        "ground_subscriptions",
        "phase",
        "pollen_ledger",
        "queue",
        "rejected_count",
        "savedAt",
    ]);
    assert.deepEqual(parsed.queue, [
        { type: "milestone", id: "buildIt" },
        { type: "fix", req_id: "REQ-1", action: "make it pass" },
        { type: "consult_expert", packet: { req_id: "REQ-1", defect: "d" } },
    ]);
    assert.deepEqual(parsed.rejected_count, { "REQ-1": 2 });
    assert.ok(!fs.existsSync(`${statePath(workspace)}.tmp`));
});

test("persist fills defaults for missing keys", () => {
    const workspace = makeWorkspace();
    const body = persist(workspace, { phase: "IM_CHAT" });
    assert.deepEqual(body.active_skills, []);
    assert.deepEqual(body.pollen_ledger, []);
    assert.deepEqual(body.ground_subscriptions, []);
    assert.deepEqual(body.queue, []);
    assert.deepEqual(body.rejected_count, {});
    assert.equal(body.contract, null);
    assert.equal(body.git_sha, null);
    assert.ok(typeof body.savedAt === "string");
});

test("restore round-trips what persist wrote", () => {
    const workspace = makeWorkspace();
    persist(workspace, {
        phase: "WARDEN_AUDIT",
        rejected_count: { "REQ-2": 1 },
    });
    const snap = restore(workspace);
    assert.equal(snap.phase, "WARDEN_AUDIT");
    assert.deepEqual(snap.rejected_count, { "REQ-2": 1 });
});

test("restore returns null for missing or corrupt state", () => {
    const workspace = makeWorkspace();
    assert.equal(restore(workspace), null);
    fs.mkdirSync(path.join(workspace, ".agent"), { recursive: true });
    fs.writeFileSync(statePath(workspace), "{not json");
    assert.equal(restore(workspace), null);
});

test("statePath points at .agent/state.json inside the workspace", () => {
    assert.equal(statePath("/tmp/w"), path.join("/tmp/w", STATE_FILE));
    assert.equal(STATE_FILE, ".agent/state.json");
});

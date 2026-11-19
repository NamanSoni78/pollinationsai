import assert from "node:assert/strict";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileContext, estTokens, maybeCompact } from "../src/context.js";

const mkWorkspace = () => mkdtempSync(join(tmpdir(), "harness-ctx-"));

const baseState = (workspace, overrides = {}) => ({
    agentId: "a-1",
    role: "worker",
    messages: [
        { role: "user", content: "Build the payments page." },
        { role: "assistant", content: "On it." },
        { role: "user", content: "Reuse the existing Button component." },
    ],
    worklog: "- [t0] boot: workspace ready\n",
    skills: [{ name: "pony", body: "Be lazy.", tokens: 2 }],
    telemetry: {
        gitStatus: "clean",
        lastCommits: ["abc123"],
        contractProgress: null,
        inbox: [],
        budgetPct: 10,
        directives: [],
    },
    workingWindow: { turns: [{ at: "t1", summary: "ran tests" }] },
    contextBudgetTokens: 100000,
    workspace,
    ...overrides,
});

test("compileContext renders all six layers in order with exact headers", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const compiled = compileContext(baseState(workspace));
    const headers = [...compiled.text.matchAll(/\[Layer \d — [A-Z ]+\]/g)].map(
        (match) => match[0],
    );
    assert.deepEqual(headers, [
        "[Layer 1 — STATIC PREFIX]",
        "[Layer 2 — ACTIVE SKILLS]",
        "[Layer 3 — USER INTENT ANCHOR]",
        "[Layer 4 — WORKLOG]",
        "[Layer 5 — TELEMETRY]",
        "[Layer 6 — WORKING WINDOW]",
    ]);
    assert.ok(compiled.text.includes("Build the payments page."));
    assert.ok(compiled.text.includes("### skill: pony"));
    assert.ok(compiled.text.includes("[t1] ran tests"));
    assert.equal(compiled.tokenEstimate, estTokens(compiled.text));
});

test("Layer 3 keeps user messages verbatim and excludes assistant turns", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { layers } = compileContext(baseState(workspace));
    assert.ok(layers.userIntentAnchor.includes("Build the payments page."));
    assert.ok(
        layers.userIntentAnchor.includes(
            "Reuse the existing Button component.",
        ),
    );
    assert.ok(!layers.userIntentAnchor.includes("On it."));
});

test("compileContext is deterministic regardless of telemetry key order", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const a = baseState(workspace, {
        telemetry: { directives: [], budgetPct: 10, inbox: [] },
    });
    const b = baseState(workspace, {
        telemetry: { inbox: [], budgetPct: 10, directives: [] },
    });
    assert.equal(compileContext(a).text, compileContext(b).text);
});

test("maybeCompact is a no-op below 70% of the working-window budget", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const state = baseState(workspace);
    const result = maybeCompact(state);
    assert.equal(result.compacted, false);
    assert.equal(state.workingWindow.turns.length, 1);
    assert.equal(result.archivePath, null);
});

test("maybeCompact archives at ~70%, grows WORKLOG, and never drops Layer 3 (acceptance a+b)", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    writeFileSync(join(workspace, "WORKLOG.md"), "# Worklog\n- [t0] boot\n");
    const userMessages = [
        "First: build the landing page.",
        "Second: add authentication.",
        "Third: write the test suite.",
        "Fourth: deploy to production.",
        "Fifth: write the documentation.",
    ];
    const state = baseState(workspace, {
        messages: userMessages.map((content) => ({ role: "user", content })),
        contextBudgetTokens: 300,
        workingWindow: {
            turns: Array.from({ length: 6 }, (_, i) => ({
                at: `t${i}`,
                summary: `turn ${i} `.repeat(60),
            })),
        },
    });
    const result = maybeCompact(state);
    assert.equal(result.compacted, true);
    assert.ok(result.archivePath, "archive path must be set");
    assert.ok(existsSync(result.archivePath));
    assert.ok(result.archivePath.startsWith(join(workspace, ".agent", "logs")));
    assert.equal(result.archivedTurns, 6);
    assert.equal(state.workingWindow.turns.length, 0);
    const worklogFile = readFileSync(join(workspace, "WORKLOG.md"), "utf8");
    assert.ok(
        worklogFile.includes("- [t0] boot"),
        "existing WORKLOG content preserved",
    );
    assert.ok(
        worklogFile.includes("compaction: archived 6 turn(s)"),
        "WORKLOG grew with the compaction milestone",
    );
    assert.ok(state.worklog.includes("compaction:"));
    const compiled = compileContext(state);
    for (const message of userMessages) {
        assert.ok(
            compiled.layers.userIntentAnchor.includes(message),
            `Layer 3 lost: ${message}`,
        );
    }
    assert.equal(state.messages.length, 5, "state.messages untouched");
});

test("maybeCompact compacts in memory when no workspace is set", () => {
    const state = baseState(null, {
        contextBudgetTokens: 200,
        workingWindow: { turns: [{ at: "t1", summary: "x".repeat(2000) }] },
    });
    const result = maybeCompact(state);
    assert.equal(result.compacted, true);
    assert.equal(result.archivePath, null);
    assert.equal(state.workingWindow.turns.length, 0);
    assert.ok(state.worklog.includes("(in-memory)"));
});

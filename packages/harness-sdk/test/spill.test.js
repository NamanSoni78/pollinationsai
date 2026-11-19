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
import { captureOutput } from "../src/spill.js";

const mkWorkspace = () => mkdtempSync(join(tmpdir(), "harness-spill-"));

test("small output passes through untouched with no spill file", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const result = captureOutput("just some text", { workspace });
    assert.equal(result.preview, "just some text");
    assert.equal(result.path, null);
    assert.equal(existsSync(join(workspace, ".agent")), false);
});

test("threshold is strictly greater than 4096 bytes", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    assert.equal(captureOutput("a".repeat(4096), { workspace }).path, null);
    assert.ok(captureOutput("a".repeat(4097), { workspace }).path);
});

test("10KB output spills to .agent/logs with the exact preview format (acceptance c)", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const lines = Array.from(
        { length: 100 },
        (_, i) => `line-${String(i).padStart(3, "0")}-${"x".repeat(100)}`,
    );
    const text = lines.join("\n");
    const result = captureOutput(text, { workspace });
    assert.ok(result.path, "spill path must be set");
    assert.ok(result.path.startsWith(join(workspace, ".agent", "logs")));
    assert.equal(
        readFileSync(result.path, "utf8"),
        text,
        "spill file holds the full output",
    );
    const previewLines = result.preview.split("\n");
    assert.deepEqual(
        previewLines.slice(0, 25),
        lines.slice(0, 25),
        "first 25 lines verbatim",
    );
    assert.equal(previewLines[25], "… [100 lines total, 50 more] …");
    assert.deepEqual(
        previewLines.slice(26, 51),
        lines.slice(-25),
        "last 25 lines verbatim",
    );
    assert.equal(previewLines[51], `Full output: ${result.path}`);
});

test("write failure never throws: preview only, path null", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const blocker = join(workspace, "blocker");
    writeFileSync(blocker, "not a directory");
    const result = captureOutput("y".repeat(5000), {
        workspace: join(blocker, "sub"),
    });
    assert.equal(result.path, null);
    assert.ok(result.preview.includes("… [1 lines total, 0 more] …"));
    assert.ok(result.preview.includes("Full output: unavailable"));
});

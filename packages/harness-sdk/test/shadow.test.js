import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { shadowRead } from "../src/shadow.js";

const mkWorkspace = () => mkdtempSync(join(tmpdir(), "harness-shadow-"));

const hashTree = (root) => {
    const hash = createHash("sha256");
    const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
            (a, b) => a.name.localeCompare(b.name),
        )) {
            hash.update(entry.name);
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else hash.update(readFileSync(full));
        }
    };
    walk(root);
    return hash.digest("hex");
};

const seedTarget = (workspace) => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(
        join(workspace, "src", "payments.js"),
        "export function retryPaymentZebra(order) {\n    // retries the payment with exponential backoff\n    return order.attempt + 1;\n}\n",
    );
    writeFileSync(
        join(workspace, "src", "auth.js"),
        "export function login(user) {\n    return user;\n}\n",
    );
    writeFileSync(
        join(workspace, "WORKLOG.md"),
        "# Worklog\n\n- [t1] milestone: payments retry added\n- [t2] milestone: auth tests green\n",
    );
    return workspace;
};

test("shadowRead answers with file:line citations and a WORKLOG tail, zero writes (acceptance h)", (t) => {
    const target = seedTarget(mkWorkspace());
    t.after(() => rmSync(target, { recursive: true, force: true }));
    const before = hashTree(target);
    const result = shadowRead(
        target,
        "how does the payment retry with backoff work?",
    );
    assert.equal(result.status, "answered");
    assert.ok(result.citations.length >= 1);
    assert.ok(
        result.citations[0].startsWith("src/payments.js:"),
        `citation format file:line — got ${result.citations[0]}`,
    );
    assert.ok(
        result.answer.includes("`src/payments.js:1-4`"),
        "answer quotes the excerpt block with its citation",
    );
    assert.ok(
        result.answer.includes("retries the payment with exponential backoff"),
    );
    assert.ok(
        result.answer.includes("milestone: auth tests green"),
        "WORKLOG tail is included",
    );
    assert.equal(
        hashTree(target),
        before,
        "target workspace content is untouched",
    );
    assert.equal(
        existsSync(join(target, ".agent")),
        false,
        "no index or state written into the target",
    );
});

test("shadowRead over an empty workspace answers without citations and still writes nothing", (t) => {
    const target = mkWorkspace();
    t.after(() => rmSync(target, { recursive: true, force: true }));
    const before = hashTree(target);
    const result = shadowRead(target, "anything at all");
    assert.equal(result.status, "answered");
    assert.deepEqual(result.citations, []);
    assert.ok(result.answer.includes("No relevant content found"));
    assert.equal(hashTree(target), before);
});

test("shadowRead requires a target workspace", () => {
    assert.throws(
        () => shadowRead(null, "question"),
        /requires targetWorkspace/,
    );
});

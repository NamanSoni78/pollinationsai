import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
    gitBranchExperiment,
    gitCheckpoint,
    gitRollback,
    initWorkspaceGit,
    secretScan,
} from "../src/git.js";

// The git binary is driven inside temp workspaces only (allowed & required).
const run = (workspace, args) =>
    execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim();
const mkWorkspace = () => mkdtempSync(join(tmpdir(), "harness-git-"));

test("initWorkspaceGit creates branch, guard .gitignore, identity and initial commit", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const result = initWorkspaceGit(workspace, {
        agentId: "a-9",
        task: "payments",
        identity: { name: "octocat", email: "octo@example.com" },
    });
    assert.equal(result.branch, "agent/a-9/payments");
    assert.equal(
        run(workspace, ["branch", "--show-current"]),
        "agent/a-9/payments",
    );
    assert.equal(
        readFileSync(join(workspace, ".gitignore"), "utf8"),
        ".env\n.agent/logs/\nnode_modules/\ndist/\n",
    );
    assert.equal(run(workspace, ["config", "user.name"]), "octocat");
    assert.equal(run(workspace, ["config", "user.email"]), "octo@example.com");
    assert.ok(
        run(workspace, ["log", "--format=%s"]).includes(
            "chore: agent workspace init",
        ),
    );
    assert.ok(result.sha);
    const again = initWorkspaceGit(workspace, {
        agentId: "a-9",
        task: "payments",
        identity: { name: "octocat", email: "octo@example.com" },
    });
    assert.equal(
        again.committed,
        false,
        "re-init with nothing new does not create a second commit",
    );
});

test("secretScan detects all six patterns and ignores lookalikes", () => {
    const findings = secretScan([
        { path: "a.js", content: `token = "sk_${"A".repeat(20)}"` },
        { path: "b.js", content: `pk_${"B".repeat(20)}` },
        {
            path: "c.js",
            content: "const url = query('github_pat_11EXAMPLE000000');",
        },
        { path: "d.js", content: `ghp_${"D".repeat(24)}` },
        { path: "e.js", content: "const aws = 'AKIAIOSFODNN7EXAMPLE';" },
        { path: "f.js", content: "-----BEGIN RSA PRIVATE KEY-----" },
        {
            path: "g.js",
            content: "const task_secretary = 1; const sk_short = 2;",
        },
    ]);
    assert.deepEqual(
        findings.map((finding) => finding.file),
        ["a.js", "b.js", "c.js", "d.js", "e.js", "f.js"],
    );
    assert.deepEqual(
        findings.map((finding) => finding.line),
        [1, 1, 1, 1, 1, 1],
    );
    assert.ok(findings[0].pattern.startsWith("sk_"));
    assert.ok(findings[5].pattern.startsWith("-----BEGIN"));
});

test("gitCheckpoint commits pending changes (acceptance g)", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    initWorkspaceGit(workspace, { agentId: "ck" });
    writeFileSync(join(workspace, "feature.txt"), "hello");
    const result = gitCheckpoint(workspace, { message: "feat: add feature" });
    assert.equal(result.committed, true);
    assert.ok(result.sha);
    assert.ok(
        run(workspace, ["log", "--format=%s"]).includes("feat: add feature"),
    );
    const noop = gitCheckpoint(workspace, { message: "nothing" });
    assert.equal(noop.committed, false);
});

test("gitCheckpoint blocks secrets, workspace stays clean and secret never committed (acceptance g)", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    initWorkspaceGit(workspace, { agentId: "sec" });
    const secret = `sk_${"Z".repeat(30)}`;
    mkdirSync(join(workspace, "newdir"), { recursive: true });
    writeFileSync(
        join(workspace, "newdir", "leak.js"),
        `const key = "${secret}";\n`,
    );
    assert.throws(
        () => gitCheckpoint(workspace, { message: "leak" }),
        (error) => {
            assert.equal(error.code, "secret_detected");
            assert.ok(
                error.message.includes("newdir/leak.js:1"),
                `message lists file:line — got: ${error.message}`,
            );
            assert.ok(error.message.includes("sk_"));
            assert.equal(error.findings[0].file, "newdir/leak.js");
            assert.equal(error.findings[0].line, 1);
            return true;
        },
    );
    assert.ok(
        !run(workspace, ["ls-files"]).includes("leak.js"),
        "secret file never staged",
    );
    assert.ok(
        !run(workspace, ["log", "--all", "-p"]).includes(secret),
        "secret never committed anywhere",
    );
    assert.ok(
        run(workspace, [
            "status",
            "--porcelain",
            "--untracked-files=all",
        ]).includes("newdir/leak.js"),
        "file remains as a pending change",
    );
});

test("gitRollback restores a previous checkpoint (acceptance g)", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    initWorkspaceGit(workspace, { agentId: "rb" });
    const file = join(workspace, "state.txt");
    writeFileSync(file, "one");
    const v1 = gitCheckpoint(workspace, { message: "v1" });
    writeFileSync(file, "two");
    gitCheckpoint(workspace, { message: "v2" });
    const rollback = gitRollback(workspace, { ref: v1.sha });
    assert.equal(rollback.restored_sha, v1.sha);
    assert.equal(readFileSync(file, "utf8"), "one");
});

test("gitBranchExperiment isolates work on its own branch (acceptance g)", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    initWorkspaceGit(workspace, { agentId: "br" });
    writeFileSync(join(workspace, "base.txt"), "base");
    gitCheckpoint(workspace, { message: "base" });
    const { branch } = gitBranchExperiment(workspace, { name: "exp/one" });
    assert.equal(branch, "exp/one");
    assert.equal(run(workspace, ["branch", "--show-current"]), "exp/one");
    writeFileSync(join(workspace, "exp-only.txt"), "exp");
    gitCheckpoint(workspace, { message: "experiment work" });
    gitRollback(workspace, { ref: "agent/br/main" });
    assert.equal(
        existsSync(join(workspace, "exp-only.txt")),
        false,
        "experiment file is isolated to the branch",
    );
    assert.equal(readFileSync(join(workspace, "base.txt"), "utf8"), "base");
});

test("git errors surface with stderr context", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    initWorkspaceGit(workspace, { agentId: "err" });
    assert.throws(
        () => gitRollback(workspace, { ref: "no-such-ref" }),
        /git checkout failed/,
    );
});

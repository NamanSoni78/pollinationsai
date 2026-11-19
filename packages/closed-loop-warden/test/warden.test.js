import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { buildContract, validateContract } from "../src/contract.js";
import { runWardenAudit } from "../src/warden.js";

const workspaces = [];
const makeWorkspace = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clw-warden-"));
    workspaces.push(dir);
    return dir;
};
after(() => {
    for (const dir of workspaces) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

let server;
let baseUrl;
before(async () => {
    server = http.createServer((req, res) => {
        if (req.url === "/missing") {
            res.writeHead(404, { "content-type": "text/plain" });
            res.end("nope");
            return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
    server.close();
});

const req = (overrides) => ({
    description: "check",
    verification_type: "command",
    must_pass: true,
    params: { command: ["node", "-e", "process.exit(0)"] },
    ...overrides,
});

test("command: exit 0 passes, non-zero fails with the stderr tail", async () => {
    const workspace = makeWorkspace();
    const ok = await runWardenAudit(
        buildContract({ requirements: [req({})] }),
        workspace,
        {},
        {},
    );
    assert.equal(ok.approved, true);
    assert.equal(ok.results[0].status, "PASS");
    assert.match(ok.results[0].evidence, /command exited 0/);

    const bad = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "explodes",
                    params: {
                        command: [
                            "node",
                            "-e",
                            "process.stderr.write('kaboom'); process.exit(3)",
                        ],
                    },
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(bad.approved, false);
    assert.equal(bad.results[0].status, "FAIL");
    assert.match(bad.results[0].defect, /kaboom/);
    assert.match(bad.results[0].defect, /3/);
    assert.match(bad.required_actions[0].action, /^Fix requirement REQ-1: /);
});

test("command runs with cwd = workspace", async () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(path.join(workspace, "cwd-probe.txt"), "here\n");
    const verdict = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "can see workspace files",
                    params: {
                        command: [
                            "node",
                            "-e",
                            "require('fs').readFileSync('cwd-probe.txt','utf8')",
                        ],
                    },
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(verdict.approved, true);
});

test("live_url_check: local 2xx passes, 404 fails (offline: local server)", async () => {
    const workspace = makeWorkspace();
    const verdict = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "live site answers",
                    verification_type: "live_url_check",
                    params: { url: `${baseUrl}/` },
                }),
                req({
                    description: "missing route",
                    verification_type: "live_url_check",
                    params: { url: `${baseUrl}/missing` },
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(verdict.approved, false);
    assert.equal(verdict.results[0].status, "PASS");
    assert.match(verdict.results[0].evidence, /HTTP 200/);
    assert.equal(verdict.results[1].status, "FAIL");
    assert.match(verdict.results[1].defect, /HTTP 404/);
});

test("file_contains: pass, pattern miss, missing file (path escapes are rejected at contract validation)", async () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
        path.join(workspace, "index.html"),
        "<h1>hello world</h1>\n",
    );
    const verdict = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "greeting",
                    verification_type: "file_contains",
                    params: { file: "index.html", pattern: "hello" },
                }),
                req({
                    description: "missing pattern",
                    verification_type: "file_contains",
                    params: { file: "index.html", pattern: "goodbye" },
                }),
                req({
                    description: "missing file",
                    verification_type: "file_contains",
                    params: { file: "gone.html", pattern: "x" },
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(verdict.approved, false);
    assert.equal(verdict.results[0].status, "PASS");
    assert.equal(verdict.results[1].status, "FAIL");
    assert.match(verdict.results[1].defect, /not found in index\.html/);
    assert.match(verdict.results[2].defect, /file not found: gone\.html/);
    // "../" paths never reach the warden: contract validation rejects them
    // (see contract.test.js); safeJoin stays as defense in depth.
    const escaping = buildContract({
        requirements: [
            req({
                description: "escape",
                verification_type: "file_contains",
                params: { file: "../secrets.txt", pattern: "x" },
            }),
        ],
    });
    assert.equal(validateContract(escaping).valid, false);
});

test("no_stubs: flags TODO comments with file and line", async () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(
        path.join(workspace, "src", "app.js"),
        "a();\n// TODO: finish this\nb();\n",
    );
    const verdict = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "clean sources",
                    verification_type: "no_stubs",
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(verdict.approved, false);
    assert.equal(verdict.results[0].status, "FAIL");
    assert.match(verdict.results[0].defect, /src[\\/]app\.js/);
    assert.match(verdict.results[0].defect, /TODO/);
    const hits = JSON.parse(
        verdict.results[0].defect.replace(/^stub markers found: /, ""),
    );
    assert.equal(hits[0].line, 2);
});

test("no_stubs: clean workspace passes and .agent is excluded by default", async () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
        path.join(workspace, "clean.js"),
        "console.log('done');\n",
    );
    fs.mkdirSync(path.join(workspace, ".agent"), { recursive: true });
    fs.writeFileSync(
        path.join(workspace, ".agent", "notes.txt"),
        "TODO: internal notes\n",
    );
    const verdict = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "clean tree",
                    verification_type: "no_stubs",
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(verdict.approved, true);
    assert.equal(verdict.results[0].status, "PASS");
});

test("no_stubs: explicit params.paths scope the scan; a listed missing path fails", async () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src", "a.js"), "// FIXME\n");
    fs.writeFileSync(path.join(workspace, "b.js"), "// TODO\n");
    const scoped = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "src clean",
                    verification_type: "no_stubs",
                    params: { paths: ["src/a.js"] },
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(scoped.results[0].status, "FAIL");
    assert.match(scoped.results[0].defect, /a\.js/);
    assert.ok(!scoped.results[0].defect.includes("b.js"));

    const missing = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "gone",
                    verification_type: "no_stubs",
                    params: { paths: ["gone.js"] },
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(missing.results[0].status, "FAIL");
    assert.match(missing.results[0].defect, /listed path not found/);
});

test("no_stubs prefers git-tracked files when the workspace is a repo", async () => {
    const workspace = makeWorkspace();
    const git = (args) =>
        execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "warden@example.com"]);
    git(["config", "user.name", "Warden Test"]);
    fs.writeFileSync(
        path.join(workspace, "tracked.js"),
        "// TODO: committed stub\n",
    );
    git(["add", "tracked.js"]);
    git(["commit", "-q", "-m", "initial"]);
    fs.writeFileSync(
        path.join(workspace, "untracked.js"),
        "// FIXME: never committed\n",
    );
    const verdict = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "tracked clean",
                    verification_type: "no_stubs",
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(verdict.results[0].status, "FAIL");
    assert.match(verdict.results[0].defect, /tracked\.js/);
    assert.ok(!verdict.results[0].defect.includes("untracked.js"));
});

test("e2e_browser: fails honestly without a runner, honours one when provided", async () => {
    const workspace = makeWorkspace();
    const noRunner = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "ui works",
                    verification_type: "e2e_browser",
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(noRunner.approved, false);
    assert.equal(noRunner.results[0].defect, "browser tool not configured");

    const withRunner = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "ui works",
                    verification_type: "e2e_browser",
                }),
            ],
        }),
        workspace,
        {},
        {
            browser: async () => ({
                ok: true,
                summary: "clicked through 3 flows",
            }),
        },
    );
    assert.equal(withRunner.approved, true);
    assert.equal(withRunner.results[0].evidence, "clicked through 3 flows");

    const throwing = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "ui works",
                    verification_type: "e2e_browser",
                }),
            ],
        }),
        workspace,
        {},
        {
            browser: async () => {
                throw new Error("no dom");
            },
        },
    );
    assert.equal(throwing.approved, false);
    assert.match(throwing.results[0].defect, /no dom/);
});

test("must_pass=false failures are recorded but never block approval", async () => {
    const workspace = makeWorkspace();
    const verdict = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "required ok",
                    must_pass: true,
                    params: { command: ["node", "-e", "0"] },
                }),
                req({
                    description: "optional nicety",
                    verification_type: "file_contains",
                    must_pass: false,
                    params: { file: "absent.txt", pattern: "x" },
                }),
            ],
        }),
        workspace,
        {},
        {},
    );
    assert.equal(verdict.approved, true);
    assert.equal(verdict.results[0].status, "PASS");
    assert.equal(verdict.results[1].status, "FAIL");
    assert.deepEqual(
        verdict.required_actions.map((a) => a.req_id),
        ["REQ-2"],
    );
    assert.match(verdict.summary, /all 1 must-pass requirement/);
});

test("zero-history: worker justification text in evidence never reaches the verdict", async () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(path.join(workspace, "page.html"), "<h1>hello</h1>\n");
    const justification =
        "WORKER-JUSTIFICATION-MARKER: trust me, the warden should believe this narrative";
    const evidence = {
        contract: null,
        git_diff_stat: justification,
        test_outputs: [justification],
        preview_url: justification,
        screenshots: [justification],
    };
    const verdict = await runWardenAudit(
        buildContract({
            requirements: [
                req({
                    description: "page present",
                    verification_type: "file_contains",
                    params: { file: "page.html", pattern: "hello" },
                }),
            ],
        }),
        workspace,
        evidence,
        {},
    );
    assert.equal(verdict.approved, true);
    // The warden only ever reads contract + workspace + opts (see runWardenAudit:
    // the evidence parameter is never dereferenced), so its output cannot echo
    // worker narrative. Asserting the full serialized verdict proves it.
    assert.ok(!JSON.stringify(verdict).includes("WORKER-JUSTIFICATION-MARKER"));
    assert.ok(!verdict.summary.includes("trust me"));
});

test("runWardenAudit throws invalid_contract on a malformed contract", async () => {
    const workspace = makeWorkspace();
    await assert.rejects(
        () => runWardenAudit(buildContract({}), workspace, {}, {}),
        (err) =>
            err.code === "invalid_contract" &&
            err.errors.some((e) => e.field === "requirements"),
    );
});

test("verdict carries contract_id, at, and spec-shaped results", async () => {
    const workspace = makeWorkspace();
    const contract = buildContract({
        requirements: [
            req({
                description: "trivially true",
                params: { command: ["node", "-e", "0"] },
            }),
        ],
    });
    const verdict = await runWardenAudit(contract, workspace, null, {});
    assert.equal(verdict.contract_id, contract.contract_id);
    assert.ok(!Number.isNaN(Date.parse(verdict.at)));
    assert.deepEqual(Object.keys(verdict.results[0]).sort(), [
        "evidence",
        "req_id",
        "status",
    ]);
});

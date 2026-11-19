import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
    buildContract,
    DEPLOY_TARGETS,
    interviewQuestions,
    VERIFICATION_TYPES,
    validateContract,
    writeContract,
} from "../src/contract.js";

const workspaces = [];
const makeWorkspace = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clw-contract-"));
    workspaces.push(dir);
    return dir;
};
after(() => {
    for (const dir of workspaces) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const validRequirement = {
    description: "index contains greeting",
    verification_type: "file_contains",
    must_pass: true,
    params: { file: "index.html", pattern: "hello" },
};

test("interviewQuestions returns one focused batch covering the required topics", () => {
    const questions = interviewQuestions();
    assert.ok(Array.isArray(questions) && questions.length >= 5);
    const topics = questions.map((q) => q.topic);
    for (const expected of ["design", "scope", "deployment", "constraints"]) {
        assert.ok(topics.includes(expected), `missing topic ${expected}`);
    }
    const deploy = questions.find((q) => q.id === "deploy_target");
    assert.equal(deploy.kind, "choice");
    assert.deepEqual(deploy.choices, [...DEPLOY_TARGETS]);
    for (const q of questions) {
        assert.equal(typeof q.question, "string");
        assert.ok(q.question.length > 0);
    }
});

test("interviewQuestions tailors the design prompt to interviewContext.goal", () => {
    const questions = interviewQuestions({ goal: "a landing page for bees" });
    const design = questions.find((q) => q.id === "design_direction");
    assert.match(design.question, /a landing page for bees/);
    assert.doesNotMatch(interviewQuestions().question ?? "", /bees/);
});

test("buildContract assigns REQ-1..n ids, defaults, and lock metadata", () => {
    const contract = buildContract({
        deploy_target: "cloudflare_pages",
        requirements: [
            validRequirement,
            { description: "no stub markers", verification_type: "no_stubs" },
        ],
    });
    assert.deepEqual(
        contract.requirements.map((r) => r.id),
        ["REQ-1", "REQ-2"],
    );
    assert.equal(contract.requirements[0].must_pass, true);
    assert.equal(contract.requirements[1].must_pass, true);
    assert.deepEqual(contract.requirements[1].params, {});
    assert.equal(contract.deploy_target, "cloudflare_pages");
    assert.equal(buildContract({}).deploy_target, "none");
    assert.ok(!Number.isNaN(Date.parse(contract.locked_at)));
    assert.match(contract.contract_id, /^contract-/);
});

test("validateContract accepts a well-formed contract", () => {
    const check = validateContract(
        buildContract({ requirements: [validRequirement] }),
    );
    assert.deepEqual(check, { valid: true, errors: [] });
});

test("validateContract reports field-level errors", () => {
    const base = buildContract({ requirements: [validRequirement] });

    const badTarget = { ...base, deploy_target: "vercel" };
    assert.ok(
        validateContract(badTarget).errors.some(
            (e) => e.field === "deploy_target",
        ),
    );

    const noReqs = { ...base, requirements: [] };
    assert.ok(
        validateContract(noReqs).errors.some((e) => e.field === "requirements"),
    );

    const notIso = { ...base, locked_at: "yesterday" };
    assert.ok(
        validateContract(notIso).errors.some((e) => e.field === "locked_at"),
    );

    const noId = { ...base, contract_id: "" };
    assert.ok(
        validateContract(noId).errors.some((e) => e.field === "contract_id"),
    );

    assert.equal(validateContract(null).valid, false);
    assert.equal(validateContract("nope").valid, false);
});

test("validateContract rejects malformed requirements with indexed fields", () => {
    const at = (requirements, index, field) => {
        const contract = buildContract({ requirements });
        contract.requirements = requirements;
        return validateContract(contract).errors.some(
            (e) => e.field === `requirements[${index}].${field}`,
        );
    };

    assert.ok(
        at(
            [
                {
                    description: "",
                    verification_type: "command",
                    must_pass: true,
                    params: { command: ["node", "0"] },
                },
            ],
            0,
            "description",
        ),
    );
    assert.ok(
        at(
            [{ description: "x", verification_type: "maybe", must_pass: true }],
            0,
            "verification_type",
        ),
    );
    assert.ok(
        at(
            [{ description: "x", verification_type: "command" }],
            0,
            "must_pass",
        ),
    );
    assert.ok(
        at(
            [
                {
                    description: "x",
                    verification_type: "command",
                    must_pass: "yes",
                },
            ],
            0,
            "must_pass",
        ),
    );
    assert.ok(
        at(
            [
                {
                    description: "x",
                    verification_type: "command",
                    must_pass: true,
                    params: { command: [] },
                },
            ],
            0,
            "params.command",
        ),
    );
    assert.ok(
        at(
            [
                {
                    description: "x",
                    verification_type: "command",
                    must_pass: true,
                    params: { command: "node ." },
                },
            ],
            0,
            "params.command",
        ),
    );
    assert.ok(
        at(
            [
                {
                    description: "x",
                    verification_type: "live_url_check",
                    must_pass: true,
                    params: { url: "ftp://x" },
                },
            ],
            0,
            "params.url",
        ),
    );
    assert.ok(
        at(
            [
                {
                    description: "x",
                    verification_type: "file_contains",
                    must_pass: true,
                    params: { file: "a.txt" },
                },
            ],
            0,
            "params.pattern",
        ),
    );
    assert.ok(
        at(
            [
                {
                    description: "x",
                    verification_type: "file_contains",
                    must_pass: true,
                    params: { file: "/etc/passwd", pattern: "a" },
                },
            ],
            0,
            "params.file",
        ),
    );
    assert.ok(
        at(
            [
                {
                    description: "x",
                    verification_type: "file_contains",
                    must_pass: true,
                    params: { file: "../escape.txt", pattern: "a" },
                },
            ],
            0,
            "params.file",
        ),
    );
    assert.ok(
        at(
            [
                {
                    description: "x",
                    verification_type: "no_stubs",
                    must_pass: true,
                    params: { paths: "src" },
                },
            ],
            0,
            "params.paths",
        ),
    );
});

test("validateContract rejects duplicate or malformed requirement ids", () => {
    const malformed = buildContract({ requirements: [validRequirement] });
    malformed.requirements[0].id = "req-1";
    assert.ok(
        validateContract(malformed).errors.some(
            (e) => e.field === "requirements[0].id",
        ),
    );
    const duplicate = buildContract({
        requirements: [validRequirement, validRequirement],
    });
    duplicate.requirements[0].id = "REQ-1";
    duplicate.requirements[1].id = "REQ-1";
    const dupCheck = validateContract(duplicate);
    assert.ok(dupCheck.errors.some((e) => /duplicate/.test(e.message)));
    assert.equal(dupCheck.valid, false);
});

test("validateContract accumulates multiple errors at once", () => {
    const contract = buildContract({});
    contract.deploy_target = "digitalocean";
    const check = validateContract(contract);
    assert.equal(check.valid, false);
    assert.ok(check.errors.length >= 2);
});

test("writeContract writes CONTRACT.json atomically with a trailing newline", () => {
    const workspace = makeWorkspace();
    const contract = buildContract({ requirements: [validRequirement] });
    const file = writeContract(workspace, contract);
    assert.equal(file, path.join(workspace, "CONTRACT.json"));
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(raw.endsWith("\n"));
    assert.deepEqual(JSON.parse(raw), contract);
    assert.ok(!fs.existsSync(`${file}.tmp`));
    const second = buildContract({ requirements: [validRequirement] });
    writeContract(workspace, second);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), second);
});

test("exported constants freeze the allowed vocabularies", () => {
    assert.deepEqual(DEPLOY_TARGETS, [
        "cloudflare_pages",
        "cloudflare_workers",
        "edgeone_pages",
        "none",
    ]);
    assert.deepEqual(VERIFICATION_TYPES, [
        "command",
        "live_url_check",
        "file_contains",
        "no_stubs",
        "e2e_browser",
    ]);
});

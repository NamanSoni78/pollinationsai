import assert from "node:assert/strict";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compileContext } from "../src/context.js";
import {
    listSkills,
    loadSkill,
    parseFrontmatter,
    scanSkills,
    unloadSkill,
} from "../src/skills.js";

const REPO_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
);

const mkWorkspace = () => mkdtempSync(join(tmpdir(), "harness-skills-"));

const writeSkill = (root, dir, body) => {
    const skillDir = join(root, "skills", dir);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), body);
};

const writeRepoSkill = (root, dir, body) => {
    const skillDir = join(root, ".agents", "skills", dir);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), body);
};

test("parseFrontmatter reads name, folded description and token_estimate", () => {
    const { meta, body } = parseFrontmatter(
        '---\nname: "quoted"\ndescription: >\n  A folded\n  description here.\ntoken_estimate: 42\nargument-hint: ignored\n---\n\nBODY TEXT\n',
    );
    assert.equal(meta.name, "quoted");
    assert.equal(meta.description, "A folded description here.");
    assert.equal(meta.token_estimate, 42);
    assert.ok(body.includes("BODY TEXT"));
    assert.equal(
        meta["argument-hint"],
        undefined,
        "only the three kept keys are parsed",
    );
});

test("scanSkills lists workspace and repo skills, workspace wins on clash", (t) => {
    const workspace = mkWorkspace();
    const repoRoot = mkWorkspace();
    t.after(() => {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(repoRoot, { recursive: true, force: true });
    });
    writeSkill(
        workspace,
        "alpha",
        "---\nname: alpha\ndescription: from workspace\n---\nA",
    );
    writeSkill(
        workspace,
        "beta",
        "---\nname: beta\ndescription: from workspace\n---\nB",
    );
    writeRepoSkill(
        repoRoot,
        "gamma",
        "---\nname: gamma\ndescription: from repo\n---\nC",
    );
    writeRepoSkill(
        repoRoot,
        "alpha",
        "---\nname: alpha\ndescription: from repo\n---\nD",
    );
    const catalog = scanSkills({ workspace, repoRoot });
    const names = catalog.map((entry) => entry.name);
    assert.deepEqual([...names].sort(), ["alpha", "beta", "gamma"]);
    const alpha = catalog.find((entry) => entry.name === "alpha");
    assert.equal(alpha.source, "workspace");
    assert.equal(alpha.description, "from workspace");
    assert.equal(
        catalog.find((entry) => entry.name === "gamma").source,
        "repo",
    );
});

test("load → Layer 2 contains body → unload → Layer 2 empty, tokens freed (acceptance e)", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    writeSkill(
        workspace,
        "alpha",
        "---\nname: alpha\ndescription: workspace alpha\ntoken_estimate: 123\n---\n\nBODY-ALPHA\n",
    );
    writeSkill(
        workspace,
        "beta",
        "---\nname: beta\ndescription: workspace beta\n---\n\nBODY-BETA-LONGER-BODY\n",
    );
    const state = {
        messages: [],
        skills: [],
        skillsCatalog: scanSkills({ workspace }),
    };
    let listed = listSkills(state);
    assert.equal(listed.find((entry) => entry.name === "alpha").loaded, false);
    const alpha = loadSkill(state, "alpha");
    assert.equal(alpha.tokens, 123, "token_estimate from frontmatter");
    const beta = loadSkill(state, "beta");
    assert.equal(
        beta.tokens,
        Math.ceil(beta.body.length / 4),
        "chars/4 fallback estimate",
    );
    let compiled = compileContext(state);
    assert.ok(compiled.layers.activeSkills.includes("BODY-ALPHA"));
    assert.ok(compiled.layers.activeSkills.includes("BODY-BETA-LONGER-BODY"));
    listed = listSkills(state);
    assert.equal(listed.find((entry) => entry.name === "alpha").loaded, true);
    assert.equal(listed.find((entry) => entry.name === "alpha").tokens, 123);
    assert.equal(unloadSkill(state, "alpha"), true);
    assert.equal(
        unloadSkill(state, "alpha"),
        false,
        "second unload is a no-op",
    );
    compiled = compileContext(state);
    assert.ok(!compiled.layers.activeSkills.includes("BODY-ALPHA"));
    assert.ok(compiled.layers.activeSkills.includes("BODY-BETA-LONGER-BODY"));
    unloadSkill(state, "beta");
    assert.equal(
        compileContext(state).layers.activeSkills,
        "(no active skills)",
    );
});

test("loadSkill throws a coded error for unknown skills", () => {
    const state = { skills: [], skillsCatalog: [] };
    assert.throws(
        () => loadSkill(state, "nope"),
        (error) => error.code === "skill_not_found",
    );
});

test("loads the real repo skill .agents/skills/ponytail/SKILL.md read-only (compat)", (t) => {
    const ponytailPath = join(
        REPO_ROOT,
        ".agents",
        "skills",
        "ponytail",
        "SKILL.md",
    );
    assert.ok(existsSync(ponytailPath), "repo skill must exist for this test");
    const catalog = scanSkills({ repoRoot: REPO_ROOT });
    const ponytail = catalog.find((entry) => entry.name === "ponytail");
    assert.ok(ponytail, "ponytail must be discovered by the repo scan");
    assert.equal(ponytail.source, "repo");
    assert.ok(ponytail.description.toLowerCase().includes("laz"));
    const state = { messages: [], skills: [], skillsCatalog: catalog };
    const skill = loadSkill(state, "ponytail");
    assert.ok(skill.body.includes("lazy senior developer"));
    assert.ok(skill.tokens > 0);
    assert.ok(
        compileContext(state).layers.activeSkills.includes(
            "lazy senior developer",
        ),
    );
    assert.ok(
        !existsSync(join(REPO_ROOT, ".agents", "skills", "ponytail", ".agent")),
        "repo skill dir must stay untouched",
    );
});

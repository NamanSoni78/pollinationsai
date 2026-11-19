import assert from "node:assert/strict";
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
import { buildRepoMap } from "../src/indexer.js";

const mkWorkspace = () => mkdtempSync(join(tmpdir(), "harness-indexer-"));

const seed = (workspace) => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(workspace, ".git"), { recursive: true });
    mkdirSync(join(workspace, "node_modules"), { recursive: true });
    mkdirSync(join(workspace, ".agent"), { recursive: true });
    writeFileSync(
        join(workspace, "src", "api.js"),
        'export const MAX_ITEMS = 50;\n\nexport default function boot() {\n    app.get("/api/things", listThings);\n    return "/api/status";\n}\nexport function listThings() {\n    return [];\n}\n',
    );
    writeFileSync(
        join(workspace, "src", "router.js"),
        'const ping = "/api/ping";\nrouter.post("/api/submit", submit);\nfunction submit() {}\n',
    );
    writeFileSync(join(workspace, "README.md"), "# demo\n");
    writeFileSync(join(workspace, ".git", "config"), "skip me\n");
    writeFileSync(
        join(workspace, "node_modules", "dep.js"),
        "export const skipped = true;\n",
    );
    writeFileSync(join(workspace, ".agent", "state.json"), "{}\n");
    return workspace;
};

test("buildRepoMap extracts exports and routes, skips .git/node_modules/.agent", (t) => {
    const workspace = seed(mkWorkspace());
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const map = buildRepoMap(workspace);
    const mapPath = join(workspace, ".agent", "repo_map.json");
    assert.ok(existsSync(mapPath));
    assert.ok(readFileSync(mapPath, "utf8").endsWith("\n"));
    assert.deepEqual(
        JSON.parse(readFileSync(mapPath, "utf8")),
        map,
        "repo_map.json matches the return value",
    );
    assert.ok(Number.isNaN(Number.NaN) === true); // sanity no-op
    assert.ok(
        !Number.isNaN(new Date(map.generatedAt).getTime()),
        "generatedAt is an ISO timestamp",
    );
    assert.deepEqual(
        map.files.map((file) => file.path),
        ["README.md", "src/api.js", "src/router.js"],
    );

    const api = map.files.find((file) => file.path === "src/api.js");
    assert.deepEqual(api.exports, ["MAX_ITEMS", "boot", "listThings"]);
    assert.deepEqual(api.routes, ["/api/status", "GET /api/things"]);

    const router = map.files.find((file) => file.path === "src/router.js");
    assert.deepEqual(router.routes, ["/api/ping", "POST /api/submit"]);
    assert.deepEqual(router.exports, []);

    const readme = map.files.find((file) => file.path === "README.md");
    assert.deepEqual(readme.exports, []);
    assert.deepEqual(readme.routes, []);
});

test("buildRepoMap writes a deterministic sorted tree", (t) => {
    const workspace = seed(mkWorkspace());
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { tree } = buildRepoMap(workspace);
    assert.equal(tree.type, "dir");
    const names = tree.children.map((node) => node.name);
    assert.deepEqual(names, ["README.md", "src"]);
    const src = tree.children.find((node) => node.name === "src");
    assert.equal(src.type, "dir");
    assert.deepEqual(
        src.children.map((node) => node.name),
        ["api.js", "router.js"],
    );
});

test("buildRepoMap on an empty workspace writes an empty map", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const map = buildRepoMap(workspace);
    assert.deepEqual(map.files, []);
    assert.deepEqual(map.tree.children, []);
    assert.ok(existsSync(join(workspace, ".agent", "repo_map.json")));
});

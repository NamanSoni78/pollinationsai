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
import { buildIndex, ragSearch } from "../src/rag.js";

const mkWorkspace = () => mkdtempSync(join(tmpdir(), "harness-rag-"));

const seed = (workspace) => {
    mkdirSync(join(workspace, "src"), { recursive: true });
    mkdirSync(join(workspace, "docs"), { recursive: true });
    mkdirSync(join(workspace, "node_modules"), { recursive: true });
    mkdirSync(join(workspace, ".git"), { recursive: true });
    mkdirSync(join(workspace, ".agent", "logs"), { recursive: true });
    writeFileSync(
        join(workspace, "src", "app.js"),
        'import { helper } from "./util.js";\n\nexport function computeTotalZephyr(items) {\n    return items.length;\n}\n',
    );
    writeFileSync(
        join(workspace, "src", "util.js"),
        "export const helper = () => 1;\n",
    );
    writeFileSync(
        join(workspace, "docs", "notes.md"),
        "# Notes\n\nThe quixotic deployment guide lives here.\n",
    );
    writeFileSync(
        join(workspace, "WORKLOG.md"),
        "# Worklog\n\n- [t1] milestone: xylophone refactor done\n",
    );
    writeFileSync(
        join(workspace, ".agent", "logs", "archive-9.txt"),
        "archived turn context\n\nthe umbrella treasure was found in the log\n",
    );
    writeFileSync(
        join(workspace, "node_modules", "junk.js"),
        "const zephyr = 'must not be indexed';\n",
    );
    writeFileSync(
        join(workspace, ".git", "config"),
        "zephyr in git dir must not be indexed\n",
    );
    return workspace;
};

test("buildIndex persists .agent/rag/index.json and finds code by function name (acceptance f)", (t) => {
    const workspace = seed(mkWorkspace());
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const index = buildIndex(workspace);
    const indexPath = join(workspace, ".agent", "rag", "index.json");
    assert.ok(existsSync(indexPath));
    const raw = readFileSync(indexPath, "utf8");
    assert.ok(raw.endsWith("\n"), "index JSON ends with newline");
    assert.deepEqual(JSON.parse(raw), index);
    const results = ragSearch(index, "computeTotalZephyr", {
        scope: "codebase",
    });
    assert.ok(results.length >= 1);
    assert.equal(results[0].file, "src/app.js");
    assert.equal(
        results[0].startLine,
        3,
        "blank-line chunking records start line",
    );
    assert.ok(results[0].preview.includes("computeTotalZephyr"));
    assert.ok(
        results.every(
            (entry) =>
                !entry.file.startsWith("node_modules") &&
                !entry.file.startsWith(".git/"),
        ),
    );
});

test("docs and worklogs scopes search their own files", (t) => {
    const workspace = seed(mkWorkspace());
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const index = buildIndex(workspace);
    const docs = ragSearch(index, "quixotic deployment", { scope: "docs" });
    assert.ok(docs.length >= 1);
    assert.equal(docs[0].file, "docs/notes.md");
    const worklogs = ragSearch(index, "umbrella treasure", {
        scope: "worklogs",
    });
    assert.ok(worklogs.length >= 1);
    assert.equal(worklogs[0].file, ".agent/logs/archive-9.txt");
    const worklogHit = ragSearch(index, "xylophone", { scope: "worklogs" });
    assert.ok(worklogHit.length >= 1);
    assert.equal(worklogHit[0].file, "WORKLOG.md");
    assert.equal(
        ragSearch(index, "quixotic", { scope: "codebase" }).length,
        0,
        "docs content is not in codebase scope",
    );
});

test("all scope spans every scope and top_k defaults to 5", (t) => {
    const workspace = seed(mkWorkspace());
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    for (let i = 0; i < 6; i++) {
        writeFileSync(
            join(workspace, `src`, `shared-${i}.js`),
            `// needleshard common block ${i}\n`,
        );
    }
    const index = buildIndex(workspace);
    const defaults = ragSearch(index, "needleshard");
    assert.equal(defaults.length, 5, "default top_k is 5");
    const capped = ragSearch(index, "needleshard", { top_k: 3 });
    assert.equal(capped.length, 3);
    assert.ok(capped.every((entry) => entry.preview.length <= 240));
});

test("empty or unmatched queries return no results", (t) => {
    const workspace = seed(mkWorkspace());
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const index = buildIndex(workspace);
    assert.deepEqual(ragSearch(index, ""), []);
    assert.deepEqual(ragSearch(index, "zzzznothingmatches"), []);
});

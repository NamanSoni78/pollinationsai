// Loads the "harness-tools" MCP adapter with real deps (CI installs first)
// and verifies the tool surface constructs against the actual SDK. Skips
// gracefully when the MCP dependencies are not installed yet.

import assert from "node:assert/strict";
import { test } from "node:test";

test("harness-tools MCP adapter loads against the real SDK", async (t) => {
    let mcp;
    let zod;
    try {
        mcp = await import("../src/mcp.js");
        zod = (await import("zod")).z;
    } catch (error) {
        return t.skip(
            `MCP deps not installed yet: ${error.code ?? error.message}`,
        );
    }
    assert.ok(Array.isArray(mcp.harnessTools) && mcp.harnessTools.length >= 12);
    for (const [name, description, schema, handler] of mcp.harnessTools) {
        assert.equal(typeof name, "string", `tool name: ${name}`);
        assert.equal(typeof description, "string");
        assert.equal(typeof schema, "object");
        assert.equal(typeof handler, "function");
    }
    const server = await mcp.buildHarnessServer();
    assert.ok(server, "buildHarnessServer constructs an McpServer");
    const names = mcp.harnessTools.map(([name]) => name);
    for (const expected of [
        "summarize_context",
        "consult_expert",
        "spawn_subagent",
        "rag_search",
        "list_skills",
        "load_skill",
        "unload_skill",
        "sleep",
        "git_checkpoint",
        "git_branch_experiment",
        "git_rollback",
        "build_repo_map",
    ]) {
        assert.ok(names.includes(expected), `missing tool: ${expected}`);
    }
    const zCheck = zod?.string ?? null;
    assert.ok(typeof zCheck === "function");
});

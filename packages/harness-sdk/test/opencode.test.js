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
import { configureOpenCodeAgent } from "../src/opencode.js";

const mkWorkspace = () => mkdtempSync(join(tmpdir(), "harness-opencode-"));

test("writes the pollinations provider block in the polli-cli shape (acceptance j)", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { configPath, config } = configureOpenCodeAgent({
        proxyBase: "http://127.0.0.1:8878",
        workspace,
    });
    assert.equal(configPath, join(workspace, ".opencode", "opencode.json"));
    assert.ok(existsSync(configPath));
    const raw = readFileSync(configPath, "utf8");
    assert.ok(raw.endsWith("\n"), "config JSON ends with a newline");
    assert.deepEqual(JSON.parse(raw), config);

    const provider = config.provider.pollinations;
    assert.equal(provider.npm, "@ai-sdk/openai-compatible");
    assert.equal(provider.name, "Pollinations");
    assert.equal(provider.options.baseURL, "http://127.0.0.1:8878/v1");
    assert.equal(provider.options.apiKey, "byop-proxy");

    assert.deepEqual(Object.keys(provider.models).sort(), [
        "openai/gpt-5.4-nano",
        "openai/gpt-6-sol",
        "openai/gpt-6.1-sol",
        "openai/gpt-6.1-terra",
    ]);
    for (const [id, entry] of Object.entries(provider.models)) {
        assert.equal(entry.name, id);
        assert.equal(entry.tool_call, true);
        assert.deepEqual(entry.limit, { context: 262144, output: 32768 });
        assert.deepEqual(entry.modalities, {
            input: ["text"],
            output: ["text"],
        });
    }
    assert.equal(config.model, "pollinations/openai/gpt-6-sol");

    const servers = config.mcp.servers;
    assert.deepEqual(Object.keys(servers).sort(), [
        "agent-ground",
        "harness-tools",
        "mcp-publish",
    ]);
    for (const server of Object.values(servers)) {
        assert.equal(server.command, "node");
        assert.ok(Array.isArray(server.args) && server.args.length === 1);
    }
    assert.ok(
        servers["agent-ground"].args[0].endsWith(
            join("packages", "agent-ground-mcp", "src", "mcp-cli.js"),
        ),
    );
});

test("merges into an existing config without clobbering other keys", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const configPath = join(workspace, ".opencode", "opencode.json");
    mkdirSync(join(workspace, ".opencode"), { recursive: true });
    writeFileSync(
        configPath,
        JSON.stringify(
            { provider: { other: { npm: "x" } }, custom: true },
            null,
            4,
        ),
    );
    const { config } = configureOpenCodeAgent({
        proxyBase: "http://localhost:9999",
        workspace,
    });
    assert.deepEqual(config.provider.other, { npm: "x" });
    assert.equal(config.custom, true);
    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.equal(
        config.provider.pollinations.options.baseURL,
        "http://localhost:9999/v1",
    );
});

test("custom models, model default and mcpServers overrides", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const { config } = configureOpenCodeAgent({
        proxyBase: "http://127.0.0.1:8878",
        workspace,
        models: ["openai/gpt-5.4-nano"],
        model: "openai/gpt-5.4-nano",
        mcpServers: {
            "agent-ground": { command: "node", args: ["/custom/mcp-cli.js"] },
        },
    });
    assert.deepEqual(Object.keys(config.provider.pollinations.models), [
        "openai/gpt-5.4-nano",
    ]);
    assert.equal(config.model, "pollinations/openai/gpt-5.4-nano");
    assert.deepEqual(config.mcp.servers["agent-ground"], {
        command: "node",
        args: ["/custom/mcp-cli.js"],
    });
    assert.ok(
        config.mcp.servers["mcp-publish"],
        "non-overridden defaults survive the merge",
    );
});

test("requires proxyBase and workspace", (t) => {
    const workspace = mkWorkspace();
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    assert.throws(
        () => configureOpenCodeAgent({ workspace }),
        /requires proxyBase/,
    );
    assert.throws(
        () => configureOpenCodeAgent({ proxyBase: "http://x" }),
        /requires workspace/,
    );
});

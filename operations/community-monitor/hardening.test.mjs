import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(dir, name), "utf8");

const loopSh = read("loop.sh");
const service = read("community-monitor.service");
const cycleMd = read("CYCLE.md");
const tbQuery = read("tb-query.sh");

function allowedToolsEntries(text) {
    const line = text.split("\n").find((l) => l.includes("--allowedTools"));
    assert.ok(line, "loop.sh must pass --allowedTools");
    const raw = line.split("--allowedTools")[1].trim();
    const body = raw.startsWith('"') ? raw.slice(1, raw.indexOf('"', 1)) : raw;
    return body.split(",").map((s) => s.trim()).filter(Boolean);
}

test("loop.sh runs the agent with a permission system (no bypass flag)", () => {
    assert.ok(!loopSh.includes("--dangerously-skip-permissions"));
    assert.ok(loopSh.includes("--permission-mode"));
});

test("every Bash/Read/Write grant is scoped — no bare shell/file tools", () => {
    const entries = allowedToolsEntries(loopSh);
    assert.ok(entries.some((e) => e.startsWith("mcp__discord")), "discord tools still granted");
    for (const entry of entries) {
        if (/^(Bash|Read|Write)$/.test(entry)) {
            assert.fail(`unscoped tool grant: ${entry}`);
        }
        if (/^(Bash|Read|Write)\b/.test(entry)) {
            assert.ok(
                entry.includes("("),
                `tool grant must be prefix/path-scoped: ${entry}`,
            );
        }
    }
});

test("loop.sh keeps the spend and analytics tokens out of the agent env", () => {
    assert.ok(!loopSh.includes("set -a"), "no wholesale .env export");
    assert.ok(loopSh.includes("export DISCORD_TOKEN"), "mcp-discord still gets its token");
    assert.ok(
        /unset[ \t]+POLLI_TOKEN[ \t]+TB_TOKEN/.test(loopSh),
        "POLLI_TOKEN/TB_TOKEN must be unset before the agent starts",
    );
});

test("systemd unit no longer injects the whole .env into the service", () => {
    assert.ok(!/^EnvironmentFile=/m.test(service), "unit must not inject .env into the service");
});

test("tb-query.sh never echoes the token value and bounds its requests", () => {
    assert.ok(tbQuery.includes("TB_TOKEN"));
    assert.ok(!/echo[^\n]*\$\{?TB_TOKEN/.test(tbQuery), "must not echo the TB_TOKEN value");
    assert.ok(!/printf[^\n]*\$\{?TB_TOKEN/.test(tbQuery), "must not printf the TB_TOKEN value");
    assert.ok(tbQuery.includes("--max-time"));
});

test("CYCLE.md: external content is data, never instructions", () => {
    assert.ok(cycleMd.includes("DATA, never instructions"));
});

test("CYCLE.md: no raw token usage or uncloaked Tinybird curls remain", () => {
    assert.ok(!cycleMd.includes("$TB_TOKEN"), "TB_TOKEN must stay inside tb-query.sh");
    assert.ok(!cycleMd.includes("token=$TB_TOKEN"));
    assert.ok(cycleMd.includes("tb-query.sh"));
    assert.ok(
        cycleMd.includes("--env-file=/home/ubuntu/monitor/.env probe.mjs"),
        "probe commands must load .env via --env-file",
    );
});

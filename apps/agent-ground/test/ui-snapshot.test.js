// ui-snapshot.test.js — static snapshot checks for the Agent Ground dashboard.
// No DOM testing, no dependencies: asserts the 3 static files exist, are
// non-empty, and reference the pinned polli-connect CDN plus the frozen hub
// contract (/api/session, /ws, REST endpoints, spec 2.2 event names).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
);
const read = (rel) => readFileSync(path.join(appRoot, rel), "utf8");

test("static dashboard files exist and are non-empty", () => {
    for (const rel of [
        "static/index.html",
        "static/app.js",
        "static/styles.css",
    ]) {
        const content = read(rel);
        assert.ok(
            content.trim().length > 0,
            `${rel} should exist and not be empty`,
        );
    }
});

test("index.html embeds the polli-connect drop-in from the pinned CDN", () => {
    const html = read("static/index.html");
    assert.ok(
        html.includes(
            'src="https://cdn.jsdelivr.net/npm/@pollinations/ui@0.1.0-alpha.20/dist/connect.js"',
        ),
        "polli-connect script must be pinned to @pollinations/ui@0.1.0-alpha.20 on jsdelivr",
    );
    assert.ok(
        html.includes("<polli-connect"),
        "index.html must contain a <polli-connect> element",
    );
    assert.ok(
        html.includes('permissions="profile,usage"'),
        "polli-connect must request profile,usage permissions",
    );
    assert.ok(
        /\sbudget="/.test(html),
        "polli-connect must set a budget attribute",
    );
});

test("index.html references the dashboard assets", () => {
    const html = read("static/index.html");
    assert.ok(
        html.includes('href="styles.css"'),
        "index.html must link styles.css",
    );
    assert.ok(html.includes('src="app.js"'), "index.html must load app.js");
    assert.ok(
        html.includes('type="module"'),
        "app.js must be loaded as an ES module",
    );
});

test("app.js wires the frozen hub REST contract and /ws events", () => {
    const js = read("static/app.js");
    for (const endpoint of [
        "/api/session",
        "/api/auth",
        "/api/budget/topup",
        "/api/close-loop",
        "/ws",
    ]) {
        assert.ok(js.includes(endpoint), `app.js must reference ${endpoint}`);
    }
    const eventTypes = [
        "ground.broadcast",
        "ground.artifact",
        "ground.reply",
        "ground.inbox",
        "agent.card",
        "budget.threshold",
        "budget.cutoff",
        "budget.paused",
        "budget.resumed",
        "warden.verdict",
    ];
    for (const type of eventTypes) {
        assert.ok(
            js.includes(`"${type}"`),
            `app.js must handle the ${type} WS event`,
        );
    }
    assert.ok(
        js.includes("RECONNECT_MS = 1000"),
        "WS reconnect must use the 1s backoff",
    );
    assert.ok(
        js.includes("POLL_MS = 3000"),
        "session poll fallback must run every 3s",
    );
});

test("app.js guards every field against undefined", () => {
    const js = read("static/app.js");
    assert.ok(
        js.includes("function txt("),
        "app.js must have a text guard helper",
    );
    assert.ok(js.includes("Array.isArray"), "app.js must guard arrays");
    assert.ok(
        js.includes("function num("),
        "app.js must have a number guard helper",
    );
});

test("styles.css defines the dark theme and the 4 status colors", () => {
    const css = read("static/styles.css").toLowerCase();
    for (const color of [
        "#0b0e14",
        "#131826",
        "#1f2637",
        "#7c5cff",
        "#3dd68c",
        "#ffb224",
        "#ff5c7c",
    ]) {
        assert.ok(css.includes(color), `styles.css must define ${color}`);
    }
    assert.ok(
        css.includes("system-ui"),
        "styles.css must use the system font stack",
    );
    assert.ok(css.includes("8px"), "styles.css must use the 8px radius");
});

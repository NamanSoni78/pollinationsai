#!/usr/bin/env node
/**
 * Agent Ground platform server: composes the BYOP proxy, the ground hub
 * (HTTP + WS + static dashboard), and the closed-loop controller for the
 * active project workspace. Run: `npm start --prefix apps/agent-ground`
 * (or `node server.mjs`). See README.md for the full walkthrough.
 */
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composePlatform, loadEnv } from "./lib/compose.mjs";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
loadEnv(join(APP_DIR, ".env"));

const groundPort =
    Number.parseInt(process.env.AGENT_GROUND_PORT ?? "", 10) || 8877;
const proxyPort =
    Number.parseInt(process.env.AGENT_BYOP_PORT ?? "", 10) || 8878;
const workspace = resolve(
    process.env.AGENT_GROUND_WORKSPACE ?? join(APP_DIR, ".ground", "project"),
);
const stateDir = resolve(
    process.env.AGENT_GROUND_STATE_DIR ?? join(APP_DIR, ".ground"),
);
const apiKey = process.env.POLLINATIONS_KEY || null;
const live = process.env.LIVE_CLOSE_LOOP === "1" && Boolean(apiKey);
mkdirSync(workspace, { recursive: true });

const platform = await composePlatform({
    workspace,
    stateDir,
    uiDir: join(APP_DIR, "static"),
    groundPort,
    proxyPort,
    apiKey,
    baseUrl: process.env.POLLINATIONS_BASE_URL,
    maxPollenBudget:
        Number.parseFloat(process.env.MAX_POLLEN_BUDGET ?? "") || undefined,
    live,
    workerAgentId: "agent-worker-01",
    interviewContext: { goal: "the active project workspace" },
});

console.log(
    `Agent Ground — hub      http://127.0.0.1:${platform.ground.port} (dashboard + /api + /ws)`,
);
if (platform.proxy) {
    console.log(
        `Agent Ground — BYOP     http://127.0.0.1:${platform.proxy.port} (metering proxy, phase ${platform.proxy.state.phase})`,
    );
    console.log(
        `Agent Ground — identity ${platform.identity?.username ?? "unknown"} <${platform.identity?.email ?? "unknown"}>`,
    );
} else {
    console.log(
        "Agent Ground — no POLLINATIONS_KEY set: metering proxy off (set it in apps/agent-ground/.env; see .env.example)",
    );
}

let shuttingDown = false;
const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
        await platform.ground.stop();
        await platform.proxy?.stop?.();
    } finally {
        process.exit(0);
    }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

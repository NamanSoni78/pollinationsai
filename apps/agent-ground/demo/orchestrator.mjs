#!/usr/bin/env node
/**
 * Agent Ground end-to-end demo. One narrative, one wiring (the same the
 * dashboard uses): two child VM agents discover each other on the Ground,
 * collaborate (sleep/wake, Shadow Reader shoulder tap, negotiate change,
 * artifact blackboard), then the user closes the loop: pre-flight interview
 * → frozen CONTRACT.json → unattended autonomous execution with a REAL
 * Pollen budget cutoff + Top-Up & Resume → adversarial Warden REJECT →
 * worker self-fix → Warden APPROVE → COMPLETED.
 *
 * Modes:
 *   scripted (default) — offline: a local stub GEN serves real HTTP shapes so
 *     the BYOP proxy meters REAL calls (usage × pricing) without network.
 *   --live — real gen.pollinations.ai through your BYOP key (POLLINATIONS_KEY);
 *     file content still uses deterministic fixtures, plus one real expert call.
 *   --serve — keep the hub + dashboard alive after the run for inspection.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGround } from "../../../packages/agent-ground-mcp/src/index.js";
import { createClosedLoop } from "../../../packages/closed-loop-warden/src/index.js";
import {
    buildRepoMap,
    captureOutput,
    createAgentRuntime,
    trackCall,
} from "../../../packages/harness-sdk/src/index.js";
import { createByopProxy } from "../../../packages/pollinations-byop-proxy/src/index.js";
import {
    budgetControlFor,
    closeLoopBroker,
    forwardLoopEvents,
    identityFor,
} from "../lib/compose.mjs";
import { STUB_CALL_COST, startStubGen } from "./stub-gen.mjs";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const hash = (text) => createHash("sha256").update(text).digest("hex");

/** Deterministic content hash of a directory (skips .git/.agent) — the
 * non-disruptive proof for Shadow Reader queries. */
function hashDir(root) {
    const entries = [];
    const walk = (dir, rel = "") => {
        for (const name of readdirSync(dir)) {
            if (name === ".git" || name === ".agent" || name === ".ground")
                continue;
            const full = join(dir, name);
            const relName = rel ? `${rel}/${name}` : name;
            if (statSync(full).isDirectory()) walk(full, relName);
            else entries.push([relName, readFileSync(full, "utf8")]);
        }
    };
    walk(root);
    entries.sort(([a], [b]) => a.localeCompare(b));
    return hash(entries.map(([p, c]) => `${p}\n${c}`).join("\u0000"));
}

/** One Worker-model "generation" (metered). Scripted mode: the stub returns
 * deterministic fixture content per call. Live mode: file content comes from
 * the same fixtures (deterministic build) while a REAL model call rides along
 * for metering — the transcript records its real output. A 402 (budget
 * cutoff) resolves to null so plan items can defer cleanly. */
async function genViaProxy(
    proxy,
    fixtureName,
    { live = false, liveLog = null } = {},
) {
    const base = `http://127.0.0.1:${proxy.port}`;
    const prompt = live
        ? `Review this build step for a plain HTML/CSS/JS pollen dashboard. Reply with one short sentence of concrete advice only: step=${fixtureName}`
        : `fixture:${fixtureName}`;
    const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: "Bearer byop-proxy",
        },
        body: JSON.stringify({
            model: "openai/gpt-6-sol",
            messages: [{ role: "user", content: prompt }],
        }),
    });
    if (response.status === 402) return null;
    const data = await response.json();
    const modelText = data?.choices?.[0]?.message?.content ?? null;
    if (live) {
        if (liveLog)
            liveLog.push({
                step: fixtureName,
                model: data?.model ?? null,
                advice: modelText?.slice(0, 200) ?? null,
            });
        return readFileSync(
            join(APP_DIR, "demo", "fixtures", `${fixtureName}.txt`),
            "utf8",
        );
    }
    return modelText;
}

/** Layer 5 telemetry sync: budget pct + conservation directives. */
function syncBudget(runtime, proxy) {
    runtime.state.telemetry.budgetPct = proxy.state.pct;
    if (
        proxy.state.phase === "conservation" &&
        !runtime.state.telemetry.directives.includes("budget-conservation")
    ) {
        runtime.state.telemetry.directives.push("budget-conservation");
    }
}

export async function runDemo(options = {}) {
    const mode = options.mode ?? "scripted";
    const live = mode === "live";
    const runDir =
        options.runDir ?? join(APP_DIR, ".demo-runs", `run-${Date.now()}`);
    mkdirSync(runDir, { recursive: true });
    const backendWs = join(runDir, "backend");
    const frontendWs = join(runDir, "frontend");
    const narrating =
        typeof options.narrate === "boolean" ? options.narrate : true;
    const say = (line) => {
        if (narrating) console.log(`· ${line}`);
    };
    const transcript = {
        mode,
        runDir,
        hub: null,
        proxy: null,
        identity: null,
        agents: [],
        liveCalls: [],
        subscribe: null,
        sleep: null,
        readonly: null,
        negotiate: null,
        sdk: null,
        closeLoop: null,
        publish: {
            skipped: true,
            reason: "cloudflare credentials not configured",
        },
        pausedEvents: [],
        topUps: [],
        resumed: false,
    };

    // ---- 1. Inference base: stub GEN (scripted) or real GEN (live) ----------
    let stub = null;
    let baseUrl;
    let apiKey;
    let maxPollenBudget;
    if (live) {
        apiKey = process.env.POLLINATIONS_KEY;
        if (!apiKey)
            throw new Error(
                "--live requires POLLINATIONS_KEY (see .env.example)",
            );
        baseUrl =
            process.env.POLLINATIONS_BASE_URL ?? "https://gen.pollinations.ai";
        maxPollenBudget =
            Number.parseFloat(process.env.MAX_POLLEN_BUDGET ?? "") || 0.5;
    } else {
        stub = await startStubGen({ port: 0, startBalance: 2 });
        baseUrl = stub.url;
        apiKey = "sk_demo_stub_not_a_real_key";
        // 3 stub calls cross 100% (spent 0.003 >= 0.0027): cutoff fires mid-plan;
        // after Top-Up to 0.012 the remaining 5 calls land at 66.7% (no re-cutoff).
        maxPollenBudget = 0.0027;
    }

    say(`mode=${mode} run=${runDir}`);
    // ---- 2. The Parent: BYOP proxy + Ground hub ------------------------------
    const proxy = await createByopProxy({
        apiKey,
        port: 0,
        baseUrl,
        maxPollenBudget,
    });
    const bus = new EventEmitter();
    const broker = closeLoopBroker({
        live,
        proxy,
        resumeWaitMs: options.resumeWaitMs ?? 30000,
    });
    const ground = await createGround({
        port: options.groundPort ?? 0,
        stateDir: join(runDir, ".ground"),
        emitters: [proxy.events, bus],
        closeLoop: {
            start: broker.start,
            status: broker.status,
            verdicts: broker.verdicts,
        },
        budgetControl: budgetControlFor(proxy),
    });
    transcript.hub = {
        port: ground.port,
        url: `http://127.0.0.1:${ground.port}`,
    };
    transcript.proxy = {
        port: proxy.port,
        url: `http://127.0.0.1:${proxy.port}`,
    };
    const identity = identityFor(proxy);
    transcript.identity = identity;
    say(
        `hub up :${ground.port}  proxy :${proxy.port}  identity ${identity?.username} <${identity?.email}>`,
    );

    // ---- 3. The Children: two concurrent VM agents ----------------------------
    const backend = createAgentRuntime({
        agentId: "agent-backend-01",
        role: "Backend & API Engineer",
        workspace: backendWs,
        ownedPaths: ["api/**"],
        stack: ["Node", "OpenAPI"],
        ground,
        proxy,
        identity,
        live,
        currentGoal: "Ship the session API + OpenAPI spec",
    });
    const frontend = createAgentRuntime({
        agentId: "agent-frontend-01",
        role: "Frontend Web UI",
        workspace: frontendWs,
        ownedPaths: ["web/**"],
        stack: ["HTML", "CSS", "Vanilla JS"],
        ground,
        proxy,
        identity,
        live,
        currentGoal:
            "Build the Pollen Pulse dashboard from the backend contract",
    });
    // A pinned user message (Layer 3 must keep it verbatim forever).
    frontend.state.messages.push({
        role: "user",
        content:
            "Build me a live pollen-budget dashboard called Pollen Pulse. Keep it plain HTML/CSS/JS.",
    });

    // ---- 4. Collaboration ----------------------------------------------------
    // 4a. Frontend subscribes to the openapi spec, then sleeps until the backend
    // publishes (proving sleep/until_event + artifact wake-up).
    const frontendStep = frontend.step(async (rt) => {
        const sub = ground.subscribe({
            agent_id: "agent-frontend-01",
            artifact_keys: ["openapi-spec"],
        });
        transcript.subscribe = sub;
        const startedAt = Date.now();
        const wake = await rt.tools.sleep({
            until_event: "ground_artifact",
            max_wait_sec: live ? 45 : 10,
        });
        transcript.sleep = {
            wakeReason: wake.wake_reason,
            eventKey: wake.event_payload?.key ?? null,
            waitedMs: Date.now() - startedAt,
        };
        return `woke on ${wake.wake_reason}: ${wake.event_payload?.key ?? "nothing"}`;
    });
    say(
        "children: agent-backend-01 + agent-frontend-01 registered on the Ground",
    );
    // 4b. Backend scaffolds its API and publishes the contract (wakes frontend).
    await backend.step(async () => {
        syncBudget(backend, proxy);
        const spec = await genViaProxy(proxy, "backend-openapi-json", {
            live,
            liveLog: transcript.liveCalls,
        });
        const server = await genViaProxy(proxy, "backend-server-js", {
            live,
            liveLog: transcript.liveCalls,
        });
        if (!spec || !server)
            throw new Error("backend generation failed (unexpected 402)");
        mkdirSync(join(backendWs, "api"), { recursive: true });
        writeFileSync(join(backendWs, "api", "openapi.json"), spec);
        writeFileSync(join(backendWs, "api", "server.js"), server);
        ground.publishArtifact({
            key: "openapi-spec",
            version: 1,
            content_type: "json",
            payload: spec,
            changelog: "session API: GET /api/session + 401 shape",
            publisher: "agent-backend-01",
        });
        backend.milestone(
            "api-scaffold",
            "openapi v1 published; session API mock ready",
        );
        return "backend scaffold complete";
    });
    say(
        `frontend woke: ${transcript.sleep?.wakeReason} on ${transcript.sleep?.eventKey}`,
    );
    await frontendStep;

    // 4c. Shoulder tap — readonly (Shadow Reader): the backend is mid-flight,
    // its files and context stay untouched.
    const backendHashBefore = hashDir(backendWs);
    const readonlyAnswer = await ground.askAgent({
        target_agent_id: "agent-backend-01",
        question:
            "Where does the session API return an unauthorized 401, and with what exact JSON shape? Cite files.",
        mode: "readonly_query",
        from: "agent-frontend-01",
    });
    const readonlyUntouched = hashDir(backendWs) === backendHashBefore;
    say(
        `shoulder tap readonly: ${readonlyAnswer.status}, citations=${readonlyAnswer.citations?.length ?? 0}, untouched=${readonlyUntouched}`,
    );
    transcript.readonly = {
        answer: readonlyAnswer.answer,
        citations: readonlyAnswer.citations,
        status: readonlyAnswer.status,
        untouched: readonlyUntouched,
    };

    // 4d. Shoulder tap — negotiate: queued into the backend's inbox, delivered
    // at its NEXT step boundary.
    const queuedAt = Date.now();
    const negotiate = await ground.askAgent({
        target_agent_id: "agent-backend-01",
        question:
            "Add CORS (Access-Control-Allow-Origin) for my preview origin to the API spec, please.",
        mode: "negotiate_change",
        from: "agent-frontend-01",
    });
    let frontendArtifactEvents = 0;
    ground.events.on("ground.artifact", (event) => {
        if (
            event.agent_id === "agent-frontend-01" ||
            event.agentId === "agent-frontend-01"
        )
            frontendArtifactEvents += 1;
    });
    await backend.step(async (rt) => {
        const delivered = rt.state.telemetry.inbox;
        transcript.negotiate = {
            queuedAt,
            status: negotiate.status,
            question:
                "Add CORS (Access-Control-Allow-Origin) for my preview origin to the API spec, please.",
            deliveredCount: delivered.length,
            deliveredAfterMs: Date.now() - queuedAt,
        };
        // Accept the change: enable CORS in the spec and republish v2 (the
        // frontend subscription fires another ground.artifact event).
        const specPath = join(backendWs, "api", "openapi.json");
        const spec = JSON.parse(readFileSync(specPath, "utf8"));
        spec["x-cors"] = {
            enabled: true,
            allowOrigin: "https://pollen-pulse.pages.dev",
            note: "accepted negotiate_change from agent-frontend-01",
        };
        writeFileSync(specPath, `${JSON.stringify(spec, null, 4)}\n`);
        ground.publishArtifact({
            key: "openapi-spec",
            version: 2,
            content_type: "json",
            payload: JSON.stringify(spec),
            changelog: "enable CORS for the frontend preview origin",
            publisher: "agent-backend-01",
        });
        rt.milestone(
            "cors-accepted",
            "openapi v2: CORS enabled for frontend preview",
        );
        return "negotiate_change accepted at step boundary";
    });
    // Give the hub a tick to dispatch the v2 event to the frontend subscription.
    // v1 was consumed by the sleep wake-up; this counts the v2 notification.
    await new Promise((tick) => setTimeout(tick, 50));
    transcript.negotiate.artifactEventsForFrontend = frontendArtifactEvents;
    transcript.agents = ground.listAgents();

    // ---- 5. SDK surface checks (deterministic, unmetered) ---------------------
    const beforeLayers = frontend.compile();
    frontend.tools.load_skill({ name: "ponytail" });
    const withPonytail = frontend.compile();
    frontend.tools.unload_skill({ name: "ponytail" });
    const withoutPonytail = frontend.compile();
    const spill = captureOutput(
        `${"line\n".repeat(120)} (10KB tail) ${"x".repeat(9000)}`,
        { workspace: frontendWs },
    );
    const doom = { signature: null };
    for (let i = 0; i < 3; i += 1) {
        const outcome = trackCall(
            frontend.state,
            "shell",
            { command: "npm test" },
            new Error("ELIFECYCLE Command failed"),
        );
        doom.signature = outcome.signature;
        doom.intervene = outcome.intervene ?? null;
    }
    const repoMap = buildRepoMap(backendWs);
    transcript.sdk = {
        skillsAvailable: frontend.tools.list_skills().map((s) => s.name),
        ponytailLayer2: /Ponytail/.test(withPonytail.layers.activeSkills),
        layer2AfterUnload: withoutPonytail.layers.activeSkills,
        userAnchorPreserved:
            withoutPonytail.layers.userIntentAnchor.includes(
                "Build me a live pollen-budget dashboard",
            ) &&
            beforeLayers.layers.userIntentAnchor.includes(
                "Build me a live pollen-budget dashboard",
            ),
        contextHeaders: Object.keys(withoutPonytail.layers),
        spill: { path: spill.path, preview: spill.preview },
        doomloop: doom,
        repoMap: {
            files: repoMap?.files?.length ?? 0,
            path: join(backendWs, ".agent", "repo_map.json"),
        },
    };

    say(
        `sdk checks: ponytail layer2=${transcript.sdk?.ponytailLayer2} anchor=${transcript.sdk?.userAnchorPreserved} doom=${transcript.sdk?.doomloop?.intervene}`,
    );
    // ---- 6. Close the loop ------------------------------------------------------
    const hasCloudflare = Boolean(
        process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID,
    );
    const deployTarget = hasCloudflare ? "cloudflare_pages" : "none";
    say(
        `close the loop: deploy_target=${deployTarget}${hasCloudflare ? "" : " (set CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID to publish live)"}`,
    );
    const answers = {
        project_goal:
            "Pollen Pulse: a live pollen-budget dashboard for Agent Ground users",
        required_features:
            "budget meter, session facts, agent list; plain HTML/CSS/JS",
        edge_cases: "401 unauthorized shape, empty balance state",
        deploy_target: deployTarget,
        constraints: "no runtime deps; no frameworks; responsive to 390px",
        requirements: [
            {
                description:
                    "Smoke check passes end to end (site scaffold coherent)",
                verification_type: "command",
                must_pass: true,
                params: { command: ["node", "smoke.mjs"] },
            },
            {
                description:
                    "The dashboard renders the pollen budget meter element",
                verification_type: "file_contains",
                must_pass: true,
                params: { file: "web/index.html", pattern: "pollen-meter" },
            },
            {
                description: "Web sources carry no unfinished-work markers",
                verification_type: "no_stubs",
                must_pass: true,
                params: {
                    paths: [
                        "web/app.js",
                        "web/index.html",
                        "web/styles.css",
                        "web/api-client.js",
                    ],
                },
            },
            ...(deployTarget === "cloudflare_pages"
                ? [
                      {
                          description:
                              "Live deployment returns HTTP 200 on the public URL",
                          verification_type: "live_url_check",
                          must_pass: true,
                          params: {
                              url: "https://pollen-pulse-demo.pages.dev",
                          },
                      },
                  ]
                : []),
        ],
    };

    const plan = [
        async function scaffoldIndex() {
            syncBudget(frontend, proxy);
            const content = await genViaProxy(proxy, "web-index-html", {
                live,
                liveLog: transcript.liveCalls,
            });
            if (content === null) return "deferred (budget cutoff)";
            mkdirSync(join(frontendWs, "web"), { recursive: true });
            writeFileSync(join(frontendWs, "web", "index.html"), content);
            return "wrote web/index.html";
        },
        async function scaffoldApp() {
            syncBudget(frontend, proxy);
            const content = await genViaProxy(proxy, "web-app-js", {
                live,
                liveLog: transcript.liveCalls,
            });
            if (content === null) return "deferred (budget cutoff)";
            writeFileSync(join(frontendWs, "web", "app.js"), content);
            return "wrote web/app.js";
        },
        async function scaffoldStyles() {
            syncBudget(frontend, proxy);
            const content = await genViaProxy(proxy, "web-styles-css", {
                live,
                liveLog: transcript.liveCalls,
            });
            if (content === null) return "deferred (budget cutoff)";
            writeFileSync(join(frontendWs, "web", "styles.css"), content);
            return "wrote web/styles.css";
        },
        async function scaffoldApiClient() {
            syncBudget(frontend, proxy);
            const content = await genViaProxy(proxy, "web-api-client-js", {
                live,
                liveLog: transcript.liveCalls,
            });
            if (content === null) return "deferred (budget cutoff)";
            writeFileSync(join(frontendWs, "web", "api-client.js"), content);
            return "wrote web/api-client.js";
        },
        async function writeSmoke() {
            syncBudget(frontend, proxy);
            const content = await genViaProxy(proxy, "smoke-mjs", {
                live,
                liveLog: transcript.liveCalls,
            });
            if (content === null) return "deferred (budget cutoff)";
            writeFileSync(join(frontendWs, "smoke.mjs"), content);
            return "wrote smoke.mjs";
        },
        async function writeReadme() {
            syncBudget(frontend, proxy);
            const content = await genViaProxy(proxy, "readme-md", {
                live,
                liveLog: transcript.liveCalls,
            });
            if (content === null) return "deferred (budget cutoff)";
            writeFileSync(join(frontendWs, "README.md"), content);
            return "wrote README.md";
        },
    ];
    if (deployTarget === "cloudflare_pages") {
        plan.push(async function deploySite() {
            const { deployPages } = await import(
                "../../../packages/mcp-publish/src/cloudflare.js"
            );
            const outcome = await deployPages({
                token: process.env.CLOUDFLARE_API_TOKEN,
                accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
                project: "pollen-pulse-demo",
                directory: join(frontendWs, "web"),
            });
            transcript.publish =
                outcome?.configured === false
                    ? {
                          skipped: true,
                          reason: "cloudflare credentials rejected",
                      }
                    : {
                          deployed: true,
                          url: outcome.url,
                          verification: outcome.verification,
                      };
            if (outcome?.url && outcome.configured !== false) {
                ground.publishArtifact({
                    key: "site-url",
                    version: 1,
                    content_type: "url",
                    payload: outcome.url,
                    changelog: "first deploy",
                    publisher: "agent-frontend-01",
                });
                ground.broadcast({
                    kind: "deployed",
                    summary: `live: ${outcome.url}`,
                    from: "agent-frontend-01",
                });
            }
            return outcome?.configured === false
                ? "deploy skipped (credentials)"
                : `deployed ${outcome.url}`;
        });
    }
    const fixers = {
        "REQ-3": async () => {
            const file = join(frontendWs, "web", "app.js");
            const cleaned = readFileSync(file, "utf8")
                .split("\n")
                .filter((line) => !line.includes("TODO:"))
                .join("\n");
            writeFileSync(file, cleaned);
        },
    };

    const loop = createClosedLoop({
        workspace: frontendWs,
        ground: { broadcast: (message) => ground.broadcast(message) },
        proxy,
        runtime: frontend,
        live,
        plan,
        fixers,
        interviewContext: { goal: "the Pollen Pulse dashboard" },
        previewUrl:
            deployTarget === "cloudflare_pages"
                ? "https://pollen-pulse-demo.pages.dev"
                : null,
    });
    broker.attach(loop);
    forwardLoopEvents(loop, bus);
    // The "user" side of Top-Up & Resume: on budget.paused, top up after a beat.
    loop.events.on("budget.paused", (event) => {
        transcript.pausedEvents.push(event);
        setTimeout(() => {
            const amount = live ? 0.5 : 0.0093;
            proxy.topUp(amount);
            transcript.topUps.push({ amount, at: new Date().toISOString() });
        }, 120);
    });
    proxy.events.on("budget.resumed", () => {
        transcript.resumed = true;
    });

    // The single "click Close the Loop" call — same path as POST /api/close-loop.
    say("autonomous execution started (human input disabled)");
    const closeLoopResult = await ground.startCloseLoop(answers);
    say(
        `closed loop finished: phase=${loop.phase()} rounds=${loop.state.rounds}`,
    );
    transcript.closeLoop = {
        phase: loop.phase(),
        rounds: loop.state.rounds,
        verdicts: loop.verdicts(),
        contract: closeLoopResult.contract,
        finalVerdict: closeLoopResult.verdict,
        pausedOnce: transcript.pausedEvents.length === 1,
    };
    transcript.agents = ground.listAgents();
    transcript.proxy = {
        ...transcript.proxy,
        state: proxy.state,
        ledger: proxy.ledger(),
        stubBalance: stub ? stub.balance() : null,
        callCost: STUB_CALL_COST,
    };
    if (deployTarget === "none") {
        transcript.publish = {
            skipped: true,
            reason: "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set — deploy tools are wired and unit-tested; set them in .env to publish live",
        };
    }

    // ---- 7. Wrap up ------------------------------------------------------------
    if (!options.keepHub) {
        await ground.stop();
        await proxy.stop();
        await stub?.stop();
    }
    return transcript;
}

const argv = new Set(process.argv.slice(2));

export { hashDir };

if (process.argv[1]?.endsWith("orchestrator.mjs")) {
    const mode = argv.has("--live") ? "live" : "scripted";
    const keepHub = argv.has("--serve");
    console.log(
        `Agent Ground demo — mode=${mode}${keepHub ? " (hub kept alive)" : ""}\n`,
    );
    runDemo({ mode, keepHub, groundPort: 8877 })
        .then((t) => {
            console.log("──────────────────────────────────────────────");
            console.log(
                `identity     ${t.identity?.username} <${t.identity?.email}>`,
            );
            console.log(`hub          ${t.hub.url}  (dashboard at /)`);
            console.log(
                `byop proxy   ${t.proxy.url}  phase=${t.proxy.state?.phase}  spent=${t.proxy.state?.spent}`,
            );
            console.log(
                `agents        ${t.agents.map((a) => a.agent_id).join(", ")}`,
            );
            console.log(
                `sleep         ${t.sleep?.wakeReason} on ${t.sleep?.eventKey} (waited ${t.sleep?.waitedMs}ms)`,
            );
            console.log(
                `shoulder tap  readonly=${t.readonly?.status} untouched=${t.readonly?.untouched} citations=${t.readonly?.citations?.length}`,
            );
            console.log(
                `negotiate     ${t.negotiate?.status}, delivered=${t.negotiate?.deliveredCount}, artifact events=${t.negotiate?.artifactEventsForFrontend}`,
            );
            console.log(
                `budget        paused=${t.pausedEvents.length}x  topups=${t.topUps.length}  resumed=${t.resumed}`,
            );
            console.log(
                `warden        rounds=${t.closeLoop?.rounds}  final=${t.closeLoop?.phase}`,
            );
            for (const [index, verdict] of (
                t.closeLoop?.verdicts ?? []
            ).entries()) {
                console.log(
                    `  round ${index + 1}: approved=${verdict.approved} — ${verdict.summary}`,
                );
                for (const result of verdict.results ?? []) {
                    console.log(
                        `    ${result.req_id}: ${result.status} ${result.evidence ?? result.defect ?? ""}`.slice(
                            0,
                            110,
                        ),
                    );
                }
            }
            console.log(
                `publish       ${t.publish.skipped ? `skipped — ${t.publish.reason}` : `live at ${t.publish.url} (verified ${t.publish.verification?.ok})`}`,
            );
            console.log(`run dir       ${t.runDir}`);
            process.exitCode = t.closeLoop?.phase === "COMPLETED" ? 0 : 1;
        })
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}

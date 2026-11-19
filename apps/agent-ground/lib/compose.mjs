/**
 * Shared composition layer for Agent Ground: one wiring used by BOTH the
 * dashboard server (server.mjs) and the end-to-end demo (demo/orchestrator.mjs),
 * so the demo proves the exact stack users drive from the UI.
 *
 * Composition order (breaks the ground→loop→runtime cycle):
 *   proxy (optional) → ground hub (with a lazily-attached closed-loop broker)
 *   → child runtimes → closed loop attached to the broker.
 */
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGround } from "../../../packages/agent-ground-mcp/src/index.js";
import {
    buildContract,
    DEPLOY_TARGETS,
    VERIFICATION_TYPES,
    validateContract,
} from "../../../packages/closed-loop-warden/src/contract.js";
import { createClosedLoop } from "../../../packages/closed-loop-warden/src/index.js";
import {
    createAgentRuntime,
    resolveGitIdentity,
} from "../../../packages/harness-sdk/src/index.js";
import { createByopProxy } from "../../../packages/pollinations-byop-proxy/src/index.js";

/** Minimal .env loader: KEY=VALUE lines, comments with #; never overrides existing env. */
export function loadEnv(file) {
    if (!existsSync(file)) return {};
    let text = "";
    try {
        text = readFileSync(file, "utf8");
    } catch {
        return {};
    }
    const loaded = {};
    for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 1) continue;
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed
            .slice(eq + 1)
            .trim()
            .replace(/^["']|["']$/g, "");
        if (!process.env[key]) process.env[key] = value;
        loaded[key] = value;
    }
    return loaded;
}

/**
 * Compile interview answers into contract answers.
 * Structured `answers.requirements[]` passes through; free text is compiled by
 * the Worker model in live mode; otherwise a precise error (never a guess).
 */
export async function compileAnswers(
    answers = {},
    { live = false, proxy = null } = {},
) {
    const src = answers ?? {};
    if (Array.isArray(src.requirements) && src.requirements.length > 0) {
        const deploy_target = DEPLOY_TARGETS.includes(src.deploy_target)
            ? src.deploy_target
            : "none";
        return { deploy_target, requirements: src.requirements };
    }
    const base =
        proxy?.baseUrl ??
        (proxy?.port ? `http://127.0.0.1:${proxy.port}` : null);
    if (!live || !base) {
        return {
            error: {
                code: "free_text_contract_requires_live_mode",
                hint: "Pass answers.requirements[] (machine-verifiable specs), or start the platform with a BYOP key and LIVE_CLOSE_LOOP=1 so the Worker model compiles the contract.",
            },
        };
    }
    const prompt = [
        "You are compiling a Task Contract for an autonomous build. Reply with ONLY JSON, no prose:",
        `{"deploy_target": one of ${DEPLOY_TARGETS.join("|")}, "requirements": [{"description": string, "verification_type": one of ${VERIFICATION_TYPES.join("|")}, "must_pass": boolean, "params": object}]}`,
        "Params per type — command: {command: string[]}; live_url_check: {url}; file_contains: {file, pattern}; no_stubs: {paths?}; e2e_browser: {}.",
        "Interview answers:",
        JSON.stringify(src, null, 2),
    ].join("\n");
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const response = await fetch(`${base}/v1/chat/completions`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: "Bearer byop-proxy",
                },
                body: JSON.stringify({
                    model: "openai/gpt-6-sol",
                    messages: [
                        {
                            role: "user",
                            content:
                                attempt === 0
                                    ? prompt
                                    : `${prompt}\n\nYour previous output was invalid. Fix it.`,
                        },
                    ],
                }),
            });
            const data = await response.json();
            const text = data?.choices?.[0]?.message?.content ?? "";
            const json = text
                .replace(/^```(?:json)?\s*/m, "")
                .replace(/```\s*$/m, "")
                .trim();
            const parsed = JSON.parse(
                json.substring(json.indexOf("{"), json.lastIndexOf("}") + 1),
            );
            const candidate = buildContract(parsed);
            if (validateContract(candidate).valid) {
                return {
                    deploy_target: candidate.deploy_target,
                    requirements: candidate.requirements,
                };
            }
        } catch {
            // fall through to the retry (or the final error below)
        }
    }
    return {
        error: {
            code: "contract_compilation_failed",
            hint: "The Worker model could not produce a valid contract; pass structured answers.requirements[] instead.",
        },
    };
}

/** Shared start: interview → freeze → autonomous run. If the budget hits the
 * hard cutoff mid-run, waits for a Top-Up & Resume (polls the phase) and
 * continues — one call maps to the whole "click and sleep" UX. */
export async function closeLoopStart(
    loop,
    answers,
    {
        live = false,
        proxy = null,
        resumeWaitMs = 120000,
        onPaused = null,
        onResumed = null,
    } = {},
) {
    const compiled = await compileAnswers(answers, { live, proxy });
    if (compiled.error) {
        throw Object.assign(
            new Error(compiled.error.hint ?? compiled.error.code),
            {
                code: compiled.error.code,
                details: compiled.error,
            },
        );
    }
    loop.startInterview();
    const contract = loop.freezeContract(compiled);
    let verdict = await loop.run();
    let waits = 0;
    // Top-Up & Resume: the daemon holds until the phase leaves BUDGET_PAUSED.
    while (verdict?.paused && waits < 10) {
        onPaused?.(verdict);
        const deadline = Date.now() + resumeWaitMs;
        while (loop.phase() === "BUDGET_PAUSED" && Date.now() < deadline) {
            await new Promise((sleep) => setTimeout(sleep, 25));
        }
        if (loop.phase() === "BUDGET_PAUSED") {
            return { contract, verdict, paused: true, timedOut: true }; // no top-up within the wait window
        }
        onResumed?.(verdict);
        verdict = await loop.run();
        waits += 1;
    }
    return { contract, verdict };
}

/**
 * The hub's closeLoop controller. The loop is attached lazily with attach():
 * until then /api/close-loop answers 503 not_configured (matches hub semantics).
 */
export function closeLoopBroker({
    live = false,
    proxy = null,
    resumeWaitMs = 120000,
} = {}) {
    const broker = {
        current: null,
        async start(answers) {
            if (!broker.current) {
                throw Object.assign(new Error("close-loop not configured"), {
                    code: "not_configured",
                });
            }
            return closeLoopStart(broker.current, answers, {
                live,
                proxy,
                resumeWaitMs,
            });
        },
        status() {
            if (!broker.current) return null;
            const loop = broker.current;
            return {
                phase: loop.phase(),
                contract: loop.state.contract,
                rounds: loop.state.rounds,
            };
        },
        verdicts() {
            return broker.current ? broker.current.verdicts() : [];
        },
        attach(loopToAttach) {
            broker.current = loopToAttach;
            return broker;
        },
    };
    return broker;
}

/** Budget control surface backed by the BYOP proxy (null when no proxy). */
export function budgetControlFor(proxy) {
    if (!proxy) return null;
    return {
        setBudget: (maxPollen) => proxy.setBudget(maxPollen),
        topUp: (amount) => proxy.topUp(amount),
        state: () => proxy.state,
    };
}

/** Forward loop events onto the hub's fan-out bus. */
export function forwardLoopEvents(loop, bus) {
    for (const type of ["warden.verdict", "budget.paused"]) {
        loop.events.on(type, (event) => bus.emit(type, event));
    }
}

/** Identity for child VMs: proxy identity (live) or a provided profile. */
export function identityFor(proxy, profile = null) {
    if (proxy?.identity?.()) {
        const id = proxy.identity();
        return { username: id.username, email: id.email, name: id.username };
    }
    if (profile) {
        return {
            ...resolveGitIdentity(profile),
            username: profile.githubUsername ?? profile.name,
            name: profile.githubUsername ?? profile.name,
        };
    }
    return null;
}

/** The closed-loop Worker runtime (one per workspace). */
export function createWorkerRuntime({
    workspace,
    ground,
    proxy,
    identity,
    live = false,
    agentId = "agent-worker-01",
    ownedPaths = ["**"],
}) {
    return createAgentRuntime({
        agentId,
        role: "Worker (Primary)",
        workspace,
        ownedPaths,
        ground,
        proxy,
        identity,
        live,
        currentGoal:
            "Fulfil the frozen CONTRACT.json; the Warden verifies every requirement.",
    });
}

/**
 * Compose the whole platform (server.mjs path). Returns everything started.
 * plan/fixers may come from options or from `<workspace>/plan.mjs` /
 * `<workspace>/fixers.mjs` default exports (documented in the README).
 */
export async function composePlatform(options = {}) {
    const workspace = options.workspace;
    if (!workspace)
        throw new Error("composePlatform requires options.workspace");
    let proxy = options.proxy ?? null;
    if (!proxy && options.apiKey) {
        proxy = await createByopProxy({
            apiKey: options.apiKey,
            port: options.proxyPort ?? undefined,
            baseUrl: options.baseUrl ?? undefined,
            maxPollenBudget: options.maxPollenBudget ?? undefined,
        });
    }
    const bus = new EventEmitter();
    const broker = closeLoopBroker({ live: options.live ?? false, proxy });
    const ground = await createGround({
        port: options.groundPort ?? undefined,
        stateDir: options.stateDir,
        uiDir: options.uiDir ?? undefined,
        emitters: [proxy?.events, bus].filter(Boolean),
        closeLoop: {
            start: broker.start,
            status: broker.status,
            verdicts: broker.verdicts,
        },
        budgetControl: budgetControlFor(proxy),
    });
    const identity = identityFor(proxy, options.profile ?? null);
    const runtime =
        options.runtime ??
        createWorkerRuntime({
            workspace,
            ground,
            proxy,
            identity,
            live: options.live ?? false,
            agentId: options.workerAgentId,
        });
    const plan =
        options.plan ??
        (existsSync(join(workspace, "plan.mjs"))
            ? (await import(join(workspace, "plan.mjs"))).default
            : []);
    const fixers =
        options.fixers ??
        (existsSync(join(workspace, "fixers.mjs"))
            ? (await import(join(workspace, "fixers.mjs"))).default
            : {});
    const loop = createClosedLoop({
        workspace,
        ground: { broadcast: (message) => ground.broadcast(message) },
        proxy,
        runtime,
        live: options.live ?? false,
        interviewContext: options.interviewContext,
        plan,
        fixers,
        previewUrl: options.previewUrl ?? null,
    });
    broker.attach(loop);
    forwardLoopEvents(loop, bus);
    return { proxy, ground, bus, broker, loop, runtime, workspace, identity };
}

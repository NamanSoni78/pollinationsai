import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { askAgent } from "./ask.js";
import { createBlackboard } from "./blackboard.js";
import { createRequestHandler } from "./http.js";
import { createRegistry } from "./registry.js";
import { attachWs, fanOut } from "./ws.js";

const DEFAULT_PORT = 8877;
const WATERCOOLER_MAX = 200;
const BROADCAST_KINDS = ["milestone", "blocked", "needs_review", "deployed"];
const GEN_BASE_URL = "https://gen.pollinations.ai";

function badRequest(message, code = "invalid_input") {
    const err = new Error(message);
    err.status = 400;
    err.code = code;
    return err;
}

function notConfigured() {
    const err = new Error("not_configured");
    err.status = 503;
    err.code = "not_configured";
    return err;
}

function portFromEnv() {
    const parsed = Number.parseInt(process.env.AGENT_GROUND_PORT ?? "", 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PORT;
}

/** Spec 2.4 identity: name = githubUsername, email fallback to noreply. */
function identityFromProfile(profile) {
    const username =
        typeof profile?.githubUsername === "string"
            ? profile.githubUsername
            : "unknown";
    return {
        githubUsername: username,
        name: username,
        email: profile?.email ?? `${username}@users.noreply.github.com`,
        image: profile?.image ?? null,
    };
}

/**
 * Create the Agent Ground hub (spec 3.2): registry + blackboard + subscriptions
 * persisted atomically to `stateDir/state.json`, watercooler in-memory (200),
 * HTTP REST + WebSocket on one server, event fan-out to WS.
 *
 * @param {{port?: number, stateDir?: string, uiDir?: string, emitters?: import("node:events").EventEmitter[], closeLoop?: {start: Function, status?: Function, verdicts: Function}, budgetControl?: {setBudget: Function, topUp: Function, state: Function}}} options
 * @returns {Promise<object>} ground
 */
export async function createGround(options = {}) {
    const port = options.port ?? portFromEnv();
    const stateDir = path.resolve(
        options.stateDir ??
            process.env.AGENT_GROUND_STATE_DIR ??
            path.join(process.cwd(), ".ground"),
    );
    const uiDir = options.uiDir ? path.resolve(options.uiDir) : null;
    const closeLoop = options.closeLoop ?? null;
    const budgetControl = options.budgetControl ?? null;

    const events = new EventEmitter();
    const registry = createRegistry();
    const blackboard = createBlackboard();
    const ring = [];
    let authSession = null;
    const statePath = path.join(stateDir, "state.json");

    function persist() {
        fs.mkdirSync(stateDir, { recursive: true });
        const snapshot = blackboard.toJSON();
        const state = {
            version: 1,
            agents: registry.toJSON(),
            artifacts: snapshot.artifacts,
            subscriptions: snapshot.subscriptions,
        };
        const tmp = `${statePath}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
        fs.renameSync(tmp, statePath);
    }

    function loadState() {
        if (!fs.existsSync(statePath)) return;
        let parsed;
        try {
            parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
        } catch (err) {
            throw new Error(
                `agent-ground: cannot parse ${statePath}: ${err.message}`,
            );
        }
        registry.load(parsed.agents ?? []);
        blackboard.load(parsed.artifacts ?? {}, parsed.subscriptions ?? []);
    }

    loadState();

    const ground = {
        port,
        server: null,
        events,
        registerAgent(card) {
            const saved = registry.register(card);
            persist();
            events.emit("agent.card", {
                agentId: saved.agent_id,
                status: saved.status,
            });
            return saved;
        },
        listAgents(filter) {
            return registry.list(filter);
        },
        updateCard(id, patch) {
            const saved = registry.update(id, patch);
            persist();
            events.emit("agent.card", {
                agentId: saved.agent_id,
                status: saved.status,
            });
            return saved;
        },
        async askAgent(input) {
            return askAgent({ getCard: registry.get, events, input });
        },
        publishArtifact(input) {
            const { artifact, subscribers } = blackboard.publish(input ?? {});
            persist();
            const payload = {
                key: artifact.key,
                version: artifact.version,
                publisher: artifact.publisher,
                changelog: artifact.changelog,
            };
            if (subscribers.length === 0) {
                events.emit("ground.artifact", { ...payload });
            } else {
                for (const subscription of subscribers) {
                    events.emit("ground.artifact", {
                        ...payload,
                        subscription_id: subscription.subscription_id,
                        agent_id: subscription.agent_id,
                    });
                }
            }
            return {
                artifact_uri: `ground://${artifact.key}@${artifact.version}`,
            };
        },
        fetchArtifact(key, version) {
            return blackboard.fetch(key, version);
        },
        subscribe(subscription) {
            const created = blackboard.subscribe(subscription ?? {});
            persist();
            return { subscription_id: created.subscription_id };
        },
        broadcast(input) {
            const { kind, from, summary, details } = input ?? {};
            if (!BROADCAST_KINDS.includes(kind)) {
                throw badRequest(
                    `kind must be one of: ${BROADCAST_KINDS.join(", ")}`,
                );
            }
            if (typeof from !== "string" || from.trim() === "")
                throw badRequest("from is required");
            if (typeof summary !== "string" || summary.trim() === "")
                throw badRequest("summary is required");
            const entry = {
                kind,
                from,
                summary,
                details: details ?? null,
                at: new Date().toISOString(),
            };
            ring.push(entry);
            if (ring.length > WATERCOOLER_MAX) ring.shift();
            events.emit("ground.broadcast", { kind, from, summary });
            return { ...entry };
        },
        async requestPeerCheck(input) {
            const { reviewer_agent_id, target_url, checks } = input ?? {};
            if (
                typeof reviewer_agent_id !== "string" ||
                reviewer_agent_id.trim() === ""
            ) {
                throw badRequest("reviewer_agent_id is required");
            }
            if (
                typeof target_url !== "string" ||
                !/^https?:\/\//.test(target_url)
            ) {
                throw badRequest("target_url must be an http(s) URL");
            }
            const wanted =
                Array.isArray(checks) && checks.length > 0
                    ? checks
                    : ["http_status"];
            const findings = [];
            let passed = true;
            for (const check of wanted) {
                if (check !== "http_status") {
                    findings.push({
                        check,
                        ok: false,
                        error: "unsupported_check",
                    });
                    passed = false;
                    continue;
                }
                try {
                    const response = await fetch(target_url, {
                        redirect: "follow",
                    });
                    findings.push({
                        check,
                        ok: response.ok,
                        status: response.status,
                    });
                    if (!response.ok) passed = false;
                } catch (err) {
                    findings.push({
                        check,
                        ok: false,
                        status: 0,
                        error: err.message,
                    });
                    passed = false;
                }
            }
            return { status: passed ? "passed" : "failed", findings };
        },
        watercooler(n = WATERCOOLER_MAX) {
            const count =
                Number.isInteger(n) && n > 0
                    ? Math.min(n, WATERCOOLER_MAX)
                    : WATERCOOLER_MAX;
            return ring.slice(-count).map((entry) => ({ ...entry }));
        },
        session() {
            return {
                identity: authSession ? authSession.identity : null,
                budget: budgetControl ? budgetControl.state() : null,
                agents: registry.list(),
                artifacts: blackboard.list(),
                watercooler: ground.watercooler(),
                warden: closeLoop ? closeLoop.verdicts() : [],
            };
        },
        async auth(apiKey) {
            if (typeof apiKey !== "string" || apiKey.trim() === "")
                throw badRequest("apiKey is required");
            const base = (
                process.env.POLLINATIONS_BASE_URL || GEN_BASE_URL
            ).replace(/\/+$/, "");
            const headers = { Authorization: `Bearer ${apiKey}` };
            let profileResponse;
            let balanceResponse;
            try {
                [profileResponse, balanceResponse] = await Promise.all([
                    fetch(`${base}/account/profile`, { headers }),
                    fetch(`${base}/account/balance`, { headers }),
                ]);
            } catch (err) {
                const error = new Error(
                    `agent-ground: cannot reach ${base}: ${err.message}`,
                );
                error.status = 502;
                error.code = "upstream_error";
                throw error;
            }
            if (!profileResponse.ok || !balanceResponse.ok) {
                const error = new Error(
                    "agent-ground: upstream rejected the API key",
                );
                error.status = 502;
                error.code = "upstream_error";
                throw error;
            }
            const profile = await profileResponse.json();
            const balanceBody = await balanceResponse.json();
            // API key is kept in memory only; NEVER persisted to stateDir.
            authSession = {
                apiKey,
                identity: identityFromProfile(profile),
                profile,
            };
            return { profile, balance: balanceBody.balance ?? null };
        },
        setBudget(maxPollen) {
            if (!budgetControl) throw notConfigured();
            return budgetControl.setBudget(maxPollen);
        },
        topUp(amount) {
            if (!budgetControl) throw notConfigured();
            return budgetControl.topUp(amount);
        },
        budgetState() {
            return budgetControl ? budgetControl.state() : null;
        },
        async startCloseLoop(answers) {
            if (!closeLoop) throw notConfigured();
            return closeLoop.start(answers);
        },
        wardenVerdicts() {
            if (!closeLoop) throw notConfigured();
            return closeLoop.verdicts();
        },
        artifactsAll() {
            return blackboard.all();
        },
        async stop() {
            persist();
            ws.closeAll();
            await new Promise((resolve) => {
                if (!server.listening) {
                    resolve();
                    return;
                }
                server.close(() => resolve());
                server.closeAllConnections?.();
            });
        },
    };

    const server = http.createServer(createRequestHandler({ ground, uiDir }));
    ground.server = server;
    const ws = attachWs(server);
    fanOut(ws, [
        events,
        ...(Array.isArray(options.emitters) ? options.emitters : []),
    ]);

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
            server.off("error", reject);
            ground.port = server.address().port;
            resolve();
        });
    });

    return ground;
}

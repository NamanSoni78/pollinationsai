/**
 * AgentRuntime: binds the 6-layer context, skills, RAG, git, sleep, the role
 * router and the ground hub into one runtime that lives inside a child VM.
 * Deterministic by default (no LLM); `live: true` routes consult_expert
 * through the BYOP proxy. Human input is always disabled (`askUser` throws).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    atomicWriteJson,
    compileContext,
    estTokens,
    maybeCompact,
} from "./context.js";
import {
    gitBranchExperiment,
    gitCheckpoint,
    gitRollback,
    initWorkspaceGit,
} from "./git.js";
import { buildIndex, ragSearch } from "./rag.js";
import { roleRouter } from "./router.js";
import { listSkills, loadSkill, scanSkills, unloadSkill } from "./skills.js";
import { sleepVia } from "./sleep.js";
import { captureOutput } from "./spill.js";

const REPO_ROOT = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
);
const INBOX_CAP = 50;
const EXPERT_FILES = 3;

/** Ground adapter calls must never break the runtime (promise or throw). */
const fireAndForget = (callable) => {
    try {
        const returned = callable();
        if (returned && typeof returned.catch === "function")
            returned.catch(() => {});
    } catch {
        // ground adapters must not break the runtime
    }
};

const ensureTrailingNewline = (text) =>
    text.endsWith("\n") ? text : `${text}\n`;

/**
 * Create an AgentRuntime.
 *
 * @param {{agentId: string, role?: string, workspace: string, ownedPaths?: string[],
 *   stack?: string[], ground?: object|null, proxy?: object|null, identity?: object|null,
 *   warden?: object|null, live?: boolean, task?: string, currentGoal?: string,
 *   contextBudgetTokens?: number}} options
 *   `ground` needs any of: registerAgent(card), updateCard(id, patch),
 *   broadcast(msg), events (EventEmitter). `warden` needs
 *   requestWardenApproval(evidence). `proxy` needs baseUrl or port (live mode).
 * @returns {{card: object, state: object, inbox: Function, step: Function,
 *   compile: Function, tools: object, milestone: Function, askUser: Function}}
 */
export function createAgentRuntime(options = {}) {
    const {
        agentId,
        role = "worker",
        workspace,
        ownedPaths = [],
        stack = [],
        ground = null,
        proxy = null,
        identity = null,
        warden = null,
        live = false,
        task = "main",
        currentGoal = null,
        contextBudgetTokens = 100000,
    } = options;
    if (!agentId) throw new Error("createAgentRuntime requires agentId");
    if (!workspace) throw new Error("createAgentRuntime requires workspace");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(join(workspace, ".agent"), { recursive: true });

    const worklogPath = join(workspace, "WORKLOG.md");
    const inboxPath = join(workspace, ".agent", "inbox.json");
    const router = roleRouter();
    // Identity may arrive as a resolved git identity ({name, email}) or as a
    // profile-like object ({username|githubUsername, email}); normalize once.
    const identityName =
        identity?.name ?? identity?.username ?? identity?.githubUsername;
    const gitIdentity = identityName
        ? { name: identityName, email: identity?.email }
        : undefined;

    const state = {
        agentId,
        role,
        workspace,
        messages: [],
        worklog: "",
        skills: [],
        skillsCatalog: [],
        telemetry: {
            gitStatus: null,
            lastCommits: [],
            contractProgress: null,
            inbox: [],
            budgetPct: 0,
            directives: [],
        },
        workingWindow: { turns: [] },
        contextBudgetTokens,
        pendingInbox: [],
        doomLoop: { signature: null, consecutive: 0 },
        currentGoal,
    };

    // WORKLOG.md is the Layer 4 source; create it so milestones always append.
    if (existsSync(worklogPath)) {
        state.worklog = readFileSync(worklogPath, "utf8");
    } else {
        state.worklog = `# Worklog — ${agentId}\n`;
        appendFileSync(worklogPath, state.worklog);
    }

    // Workspace git: branch + identity + guard .gitignore + initial commit.
    const gitInfo = initWorkspaceGit(workspace, {
        agentId,
        task,
        identity: gitIdentity,
    });
    state.telemetry.gitStatus = `on branch ${gitInfo.branch}`;
    state.telemetry.lastCommits = [gitInfo.sha].filter(Boolean);

    // Dynamic skills catalog: workspace skills win over repo skills.
    try {
        state.skillsCatalog = scanSkills({ workspace, repoRoot: REPO_ROOT });
    } catch {
        state.skillsCatalog = [];
    }

    const card = {
        agent_id: agentId,
        owner_pollinations_id:
            identity?.username ??
            identity?.githubUsername ??
            identityName ??
            null,
        role,
        current_goal: currentGoal,
        status: "booting",
        stack,
        owned_paths: ownedPaths,
        published_artifacts: [],
        preview_url: null,
        last_summary: null,
        workspace,
    };

    const wakeRegistry = new Map();

    const takeInboxFile = () => {
        try {
            if (!existsSync(inboxPath)) return [];
            const queued = JSON.parse(readFileSync(inboxPath, "utf8"));
            if (!Array.isArray(queued) || !queued.length) return [];
            atomicWriteJson(inboxPath, []);
            return queued;
        } catch {
            return []; // corrupt inbox stays on disk for inspection
        }
    };

    /**
     * Queue a request (or inspect the queue). Queued requests are delivered
     * into `state.telemetry.inbox` at the NEXT step boundary, never mid-step.
     */
    function inbox(request) {
        if (request === undefined) {
            return {
                pending: [...state.pendingInbox],
                delivered: [...state.telemetry.inbox],
            };
        }
        state.pendingInbox.push(request);
        return { queued: true, pending: state.pendingInbox.length };
    }

    /** Run one step: deliver inbox → run action → summarize turn → compact. */
    async function step(action) {
        const delivered = [
            ...state.pendingInbox.splice(0, state.pendingInbox.length),
            ...takeInboxFile(),
        ];
        if (delivered.length) {
            state.telemetry.inbox.push(...delivered);
            if (state.telemetry.inbox.length > INBOX_CAP) {
                state.telemetry.inbox.splice(
                    0,
                    state.telemetry.inbox.length - INBOX_CAP,
                );
            }
        }
        card.status = "working";
        let result;
        try {
            result = action ? await action(runtime) : undefined;
        } finally {
            card.status = "idle";
        }
        const summary =
            result === undefined
                ? `(step completed ${new Date().toISOString()})`
                : typeof result === "string"
                  ? result
                  : JSON.stringify(result);
        const { preview } = captureOutput(summary, { workspace });
        state.workingWindow.turns.push({
            at: new Date().toISOString(),
            summary: preview,
        });
        maybeCompact(state);
        return result;
    }

    /** Compile the current 6-layer context (pure). */
    function compile() {
        return compileContext(state);
    }

    const excerpt = (relativePath, maxLines = 40) => {
        const full = join(workspace, relativePath);
        if (!existsSync(full)) return `(file not found: ${relativePath})`;
        return readFileSync(full, "utf8")
            .split("\n")
            .slice(0, maxLines)
            .join("\n");
    };

    const expertPacket = ({
        question,
        file_paths = [],
        failed_attempts = [],
    }) =>
        [
            "# Expert consultation request",
            `## Question\n${String(question ?? "")}`,
            ...(file_paths.length
                ? [
                      "## File excerpts",
                      ...file_paths
                          .slice(0, EXPERT_FILES)
                          .flatMap((path) => [`### ${path}`, excerpt(path)]),
                  ]
                : []),
            ...(failed_attempts.length
                ? [
                      "## Failed attempts",
                      ...failed_attempts.map(
                          (attempt, index) =>
                              `${index + 1}. ${typeof attempt === "string" ? attempt : JSON.stringify(attempt)}`,
                      ),
                  ]
                : []),
            "## Request\nAnalyze the question against the excerpts and failed attempts; propose the minimal next action.",
        ].join("\n");

    const liveExpertCall = async (prompt) => {
        const base =
            proxy?.baseUrl ??
            (proxy?.port ? `http://127.0.0.1:${proxy.port}` : null);
        if (!base) {
            const error = new Error(
                "live consult_expert requires a proxy (baseUrl or port)",
            );
            error.code = "proxy_not_configured";
            throw error;
        }
        const model = router.resolve("EXPERT").model;
        const response = await fetch(`${base}/v1/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: "Bearer byop-proxy",
            },
            body: JSON.stringify({
                model,
                messages: [{ role: "user", content: prompt }],
            }),
        });
        if (!response.ok)
            throw new Error(`expert call failed: HTTP ${response.status}`);
        const data = await response.json();
        return {
            guidance: data?.choices?.[0]?.message?.content ?? "",
            mode: "live",
            model,
            usage: data?.usage ?? null,
        };
    };

    const tools = {
        summarize_context() {
            const compiled = compileContext(state);
            const layerTokens = Object.fromEntries(
                Object.entries(compiled.layers).map(([key, value]) => [
                    key,
                    estTokens(value),
                ]),
            );
            return {
                tokenEstimate: compiled.tokenEstimate,
                layerTokens,
                text: compiled.text,
            };
        },
        async consult_expert({ question, file_paths, failed_attempts } = {}) {
            const packet = expertPacket({
                question,
                file_paths,
                failed_attempts,
            });
            if (live) return liveExpertCall(packet);
            return { guidance: packet, pollen_cost: 0, mode: "deterministic" };
        },
        spawn_subagent({ goal, mode = "readonly", max_pollen } = {}) {
            if (mode === "sandbox_branch") {
                const { branch } = gitBranchExperiment(workspace, {
                    name: `subagent/${agentId}`,
                });
                return {
                    summary: `Sandbox branch \`${branch}\` created for goal: ${goal}`,
                    artifacts: [],
                    mode,
                    branch,
                    max_pollen: max_pollen ?? 0,
                    pollen_cost: 0,
                };
            }
            const results = ragSearch(
                buildIndex(workspace),
                String(goal ?? ""),
                { scope: "all", top_k: 5 },
            );
            const summary = [
                `Readonly subagent research for: ${goal}`,
                ...results.map(
                    (entry) =>
                        `- ${entry.file}:${entry.startLine}-${entry.endLine} (score ${entry.score}) ${entry.preview.slice(0, 120)}`,
                ),
            ].join("\n");
            return {
                summary,
                artifacts: [],
                mode: "readonly",
                pollen_cost: 0,
                results,
            };
        },
        rag_search({ query, scope = "all", top_k = 5 } = {}) {
            return {
                results: ragSearch(buildIndex(workspace), String(query ?? ""), {
                    scope,
                    top_k,
                }),
            };
        },
        list_skills: () => listSkills(state),
        load_skill: ({ name } = {}) => loadSkill(state, name),
        unload_skill: ({ name } = {}) => ({
            unloaded: unloadSkill(state, name),
        }),
        sleep: (sleepOptions = {}) =>
            sleepVia(sleepOptions, {
                emitter: ground?.events ?? null,
                registry: wakeRegistry,
            }),
        git_checkpoint: ({ message } = {}) =>
            gitCheckpoint(workspace, {
                message: message ?? `checkpoint ${agentId}`,
            }),
        git_branch_experiment: ({ name } = {}) =>
            gitBranchExperiment(workspace, { name }),
        git_rollback: ({ ref } = {}) => gitRollback(workspace, { ref }),
        request_warden_approval(evidence) {
            if (!warden?.requestWardenApproval) {
                const error = new Error(
                    "request_warden_approval: no warden injected",
                );
                error.code = "warden_not_configured";
                throw error;
            }
            return warden.requestWardenApproval(evidence);
        },
    };

    /**
     * Record a milestone: WORKLOG append + git checkpoint + card update +
     * ground broadcast (ground parts are no-ops when ground is absent).
     */
    function milestone(id, summary) {
        const line = `- [${new Date().toISOString()}] ${id}: ${summary}\n`;
        state.worklog = `${ensureTrailingNewline(state.worklog || "")}${line}`;
        appendFileSync(worklogPath, line);
        const { sha } = gitCheckpoint(workspace, {
            message: `milestone: ${id}`,
        });
        state.telemetry.lastCommits = [
            sha,
            ...state.telemetry.lastCommits,
        ].slice(0, 5);
        card.last_summary = summary;
        if (card.status === "booting") card.status = "idle";
        if (ground?.updateCard) {
            fireAndForget(() =>
                ground.updateCard(agentId, {
                    last_summary: summary,
                    status: card.status,
                }),
            );
        }
        let broadcasted = false;
        if (ground?.broadcast) {
            fireAndForget(() =>
                ground.broadcast({ kind: "milestone", summary, from: agentId }),
            );
            broadcasted = true;
        }
        return { id, sha, broadcasted };
    }

    /** Human input is disabled in autonomous mode — always throws. */
    function askUser() {
        const error = new Error("human input is disabled in autonomous mode");
        error.code = "human_input_disabled";
        throw error;
    }

    const runtime = {
        card,
        state,
        inbox,
        step,
        compile,
        tools,
        milestone,
        askUser,
    };

    if (ground?.registerAgent) fireAndForget(() => ground.registerAgent(card));

    return runtime;
}

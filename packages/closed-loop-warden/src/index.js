// createClosedLoop: the durable daemon wiring FSM + contract freeze +
// zero-history Warden + escalation + budget pause/resume into one loop.
//
// Loop shape (spec 3.4):
//   IM_CHAT -> PREFLIGHT_INTERVIEW -> AUTONOMOUS_EXECUTION <=> WARDEN_AUDIT
//   WARDEN_AUDIT -> COMPLETED | (rejected) back to AUTONOMOUS_EXECUTION
//   AUTONOMOUS_EXECUTION -> BUDGET_PAUSED -> AUTONOMOUS_EXECUTION

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
    buildContract,
    interviewQuestions,
    validateContract,
    writeContract,
} from "./contract.js";
import * as durable from "./durable.js";
import { escalateOnDoubleReject } from "./escalation.js";
import { createFsm, PHASES } from "./fsm.js";
import { runWardenAudit } from "./warden.js";

export { escalateOnDoubleReject } from "./escalation.js";
export { PHASES } from "./fsm.js";
export { runWardenAudit } from "./warden.js";

/**
 * Human input is disabled in closed-loop mode. This helper always throws so
 * the runtime layer can wire it wherever an agent might reach for a human.
 *
 * @throws {{code: "human_input_disabled"}} always
 */
export function askUser() {
    throw Object.assign(
        new Error(
            "Closed-loop mode: human input is disabled; resolve autonomously.",
        ),
        { code: "human_input_disabled" },
    );
}

/**
 * Create the closed-loop daemon for one child VM workspace.
 *
 * @param {{
 *   workspace: string,
 *   ground?: object,                      // hub: best-effort verdict broadcasts
 *   proxy?: {events?: EventEmitter, port?: number, ledger?: Function},
 *   runtime?: object,                     // harness AgentRuntime (duck-typed)
 *   wardenModel?: string,                 // e.g. openai/gpt-6.1-terra
 *   live?: boolean,                       // enable the (untested) LLM pass
 *   interviewContext?: {goal?: string},
 *   plan?: Array<Function>,               // milestone functions (ctx) => done
 *   fixers?: Record<string, Function>,    // req_id -> async fix function
 *   maxWardenRounds?: number,             // default 3
 *   previewUrl?: string | null,
 *   browser?: Function,                   // e2e_browser runner for the warden
 * }} options
 * @returns {{phase: () => string, startInterview: () => Array<object>, freezeContract: (answers: object) => object, run: (onTick?: Function) => Promise<object>, submitEvidence: (evidence: object) => Promise<object>, verdicts: () => Array<object>, resumeFromDisk: () => object | null, state: object, events: EventEmitter}}
 */
export function createClosedLoop(options = {}) {
    const workspace = options.workspace;
    if (typeof workspace !== "string" || workspace.length === 0) {
        throw Object.assign(new Error("options.workspace is required"), {
            code: "invalid_options",
        });
    }
    const runtime = options.runtime ?? null;
    const proxy = options.proxy ?? null;
    const maxWardenRounds = options.maxWardenRounds ?? 3;
    const fixers = options.fixers ?? {};
    const queue = Array.isArray(options.plan) ? [...options.plan] : [];
    const events = new EventEmitter();
    const verdictLog = [];
    let running = false;
    let budgetPauseRequested = false;
    let milestoneCounter = 0;

    const fsm = createFsm("IM_CHAT");
    const state = {
        contract: null,
        questions: null,
        baseGitSha: null,
        queue,
        rejected_count: {},
        rounds: 0,
        savedAt: null,
        lastEvidence: null,
        budget: { paused: false },
        escalations: [],
        fixLog: [],
        queueLog: [],
    };
    Object.defineProperty(state, "phase", {
        get: () => fsm.phase(),
        enumerable: true,
    });

    const gitBestEffort = (args) => {
        try {
            return execFileSync("git", args, {
                cwd: workspace,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            }).trim();
        } catch {
            return null;
        }
    };
    const gitShaNow = () => gitBestEffort(["rev-parse", "HEAD"]);

    function requirePhase(expected, to) {
        if (fsm.phase() !== expected) {
            throw Object.assign(
                new Error(`invalid transition ${fsm.phase()} -> ${to}`),
                { code: "invalid_transition", from: fsm.phase(), to },
            );
        }
    }

    function snapshot() {
        return {
            phase: fsm.phase(),
            contract: state.contract,
            active_skills: skillsFromRuntime(),
            pollen_ledger: safeCall(() => proxy?.ledger?.()) ?? [],
            git_sha: gitShaNow(),
            ground_subscriptions: [],
            queue: [...queue],
            rejected_count: { ...state.rejected_count },
        };
    }

    function skillsFromRuntime() {
        const skills = runtime?.state?.skills;
        if (!Array.isArray(skills)) {
            return [];
        }
        return skills.map((s) =>
            typeof s === "string" ? s : (s?.name ?? String(s)),
        );
    }

    function safeCall(fn) {
        try {
            const out = fn();
            return out === undefined ? null : out;
        } catch {
            return null;
        }
    }

    function persist() {
        const body = durable.persist(workspace, snapshot());
        state.savedAt = body.savedAt;
        return body;
    }

    function startInterview() {
        requirePhase("IM_CHAT", "PREFLIGHT_INTERVIEW");
        fsm.transition("PREFLIGHT_INTERVIEW");
        state.questions = interviewQuestions(options.interviewContext);
        persist();
        return state.questions;
    }

    function freezeContract(answers) {
        requirePhase("PREFLIGHT_INTERVIEW", "AUTONOMOUS_EXECUTION");
        const contract = buildContract(answers);
        const check = validateContract(contract);
        if (!check.valid) {
            throw Object.assign(new Error("contract failed validation"), {
                code: "invalid_contract",
                errors: check.errors,
            });
        }
        writeContract(workspace, contract);
        state.contract = contract;
        state.baseGitSha = gitShaNow();
        fsm.transition("AUTONOMOUS_EXECUTION");
        persist();
        return contract;
    }

    function buildEvidence() {
        let diff = state.baseGitSha
            ? gitBestEffort(["diff", "--stat", `${state.baseGitSha}..HEAD`])
            : null;
        if (!diff) {
            diff = gitBestEffort(["diff", "--stat"]);
        }
        const evidence = {
            contract: state.contract,
            git_diff_stat: diff && diff.length > 0 ? diff : null,
            test_outputs: [],
            preview_url: options.previewUrl ?? null,
            screenshots: [],
        };
        state.lastEvidence = evidence;
        return evidence;
    }

    const ctx = () => ({
        workspace,
        contract: state.contract,
        state,
        events,
        loop: closedLoop,
    });

    async function executeItem(item) {
        if (typeof item === "function") {
            const out = await item(ctx());
            milestoneCounter += 1;
            return {
                kind: "milestone",
                id: item.name || `milestone-${milestoneCounter}`,
                summary:
                    typeof out === "string"
                        ? out
                        : `completed ${item.name || "milestone"}`,
            };
        }
        if (item?.kind === "fix") {
            if (typeof item.run === "function") {
                await item.run(ctx());
            } else {
                state.fixLog.push({
                    req_id: item.req_id,
                    action: item.action,
                    note: "no fixer provided; action recorded",
                });
            }
            return {
                kind: "fix",
                id: `fix-${item.req_id}`,
                summary: item.action,
            };
        }
        if (item?.kind === "consult_expert") {
            state.escalations.push(item.packet);
            const tool = runtime?.tools?.consult_expert;
            if (typeof tool === "function") {
                // consult_expert expects {question, file_paths, failed_attempts};
                // translate the warden packet so the expert gets real content.
                await tool({
                    question: `The Warden rejected ${item.packet?.req_id} twice in a row: ${item.packet?.critique ?? "no critique given"}. Propose the minimal next action.`,
                    file_paths: [],
                    failed_attempts: (item.packet?.required_actions ?? []).map(
                        (action) =>
                            typeof action === "string"
                                ? action
                                : (action?.action ?? String(action)),
                    ),
                });
            }
            return {
                kind: "consult_expert",
                id: `consult-${item.packet?.req_id}`,
                summary: `expert escalation for ${item.packet?.req_id}`,
            };
        }
        if (
            item &&
            typeof item === "object" &&
            typeof item.run === "function"
        ) {
            await item.run(ctx());
            return {
                kind: "opaque",
                id: item.id ?? "step",
                summary: item.summary ?? "step executed",
            };
        }
        return {
            kind: "opaque",
            id: "skipped",
            summary: "unexecutable queue item skipped",
        };
    }

    async function afterStep(step, onTick) {
        if (runtime && typeof runtime.milestone === "function") {
            try {
                await runtime.milestone(step.id, step.summary);
            } catch {
                // runtime milestones are best-effort; the loop must survive them
            }
        }
        persist();
        if (typeof onTick === "function") {
            onTick(fsm.phase());
        }
    }

    function processVerdict(verdict) {
        const counts = state.rejected_count;
        for (const result of verdict.results ?? []) {
            counts[result.req_id] =
                result.status === "FAIL" ? (counts[result.req_id] ?? 0) + 1 : 0;
        }
        const fixes = (verdict.required_actions ?? []).map((action) => {
            const fixer = fixers[action.req_id];
            return {
                kind: "fix",
                req_id: action.req_id,
                action: action.action,
                run: typeof fixer === "function" ? fixer : null,
            };
        });
        queue.unshift(...fixes);
        for (const fix of fixes) {
            state.queueLog.push({
                kind: "fix",
                req_id: fix.req_id,
                action: fix.action,
            });
        }
        const escalations = [];
        for (const reqId of Object.keys(counts)) {
            const decision = escalateOnDoubleReject(counts, reqId, verdict);
            if (decision.escalate) {
                escalations.push({
                    kind: "consult_expert",
                    packet: decision.packet,
                });
            }
        }
        queue.unshift(...escalations);
        for (const escalation of escalations) {
            state.queueLog.push({
                kind: "consult_expert",
                req_id: escalation.packet.req_id,
            });
        }
    }

    async function submitEvidence(evidence) {
        requirePhase("AUTONOMOUS_EXECUTION", "WARDEN_AUDIT");
        fsm.transition("WARDEN_AUDIT");
        const verdict = await runWardenAudit(
            state.contract,
            workspace,
            evidence,
            {
                live: options.live ?? false,
                wardenModel: options.wardenModel,
                proxy,
                browser: options.browser,
            },
        );
        verdict.round = verdictLog.length + 1;
        verdictLog.push(verdict);
        events.emit("warden.verdict", {
            type: "warden.verdict",
            at: new Date().toISOString(),
            approved: verdict.approved,
            contractId: state.contract?.contract_id ?? null,
        });
        broadcastVerdict(verdict);
        if (verdict.approved) {
            fsm.transition("COMPLETED");
            // A pass breaks the "twice consecutively" chain for every req.
            for (const reqId of Object.keys(state.rejected_count)) {
                state.rejected_count[reqId] = 0;
            }
        } else {
            fsm.transition("AUTONOMOUS_EXECUTION");
            processVerdict(verdict);
        }
        persist();
        return verdict;
    }

    function broadcastVerdict(verdict) {
        const broadcast = options.ground?.broadcast;
        if (typeof broadcast !== "function") {
            return;
        }
        try {
            broadcast({
                kind: verdict.approved ? "milestone" : "blocked",
                summary: `Warden verdict: ${verdict.summary}`,
                from: runtime?.card?.agent_id ?? "closed-loop-warden",
            });
        } catch {
            // the ground hub is optional; never let it break the loop
        }
    }

    const pausedResult = () => ({ approved: false, paused: true });

    async function run(onTick) {
        if (running) {
            throw Object.assign(new Error("run() already in progress"), {
                code: "already_running",
            });
        }
        requirePhase("AUTONOMOUS_EXECUTION", "AUTONOMOUS_EXECUTION");
        running = true;
        try {
            let round = 0;
            while (true) {
                while (queue.length > 0) {
                    if (state.budget.paused) {
                        return pausedResult();
                    }
                    const item = queue.shift();
                    const step = await executeItem(item);
                    await afterStep(step, onTick);
                    if (state.budget.paused) {
                        return pausedResult();
                    }
                }
                round += 1;
                state.rounds = round;
                const verdict = await submitEvidence(buildEvidence());
                if (typeof onTick === "function") {
                    onTick(fsm.phase());
                }
                if (state.budget.paused) {
                    return pausedResult();
                }
                if (verdict.approved) {
                    return verdict;
                }
                if (
                    budgetPauseRequested &&
                    fsm.phase() === "AUTONOMOUS_EXECUTION"
                ) {
                    applyPause();
                    return pausedResult();
                }
                if (round >= maxWardenRounds) {
                    throw Object.assign(
                        new Error(
                            `warden rejected the contract ${round} time(s); giving up`,
                        ),
                        { code: "warden_exhausted", verdict },
                    );
                }
                if (queue.length === 0) {
                    throw Object.assign(
                        new Error(
                            "warden rejected but produced no actionable fixes",
                        ),
                        { code: "warden_exhausted", verdict },
                    );
                }
            }
        } finally {
            running = false;
        }
    }

    function applyPause() {
        budgetPauseRequested = false;
        try {
            runtime?.tools?.git_checkpoint?.({ message: "budget cutoff" });
        } catch {
            // best-effort checkpoint
        }
        fsm.transition("BUDGET_PAUSED");
        state.budget.paused = true;
        const gitSha = gitShaNow();
        persist();
        events.emit("budget.paused", {
            type: "budget.paused",
            at: new Date().toISOString(),
            gitSha,
            statePath: durable.statePath(workspace),
        });
    }

    function onBudgetCutoff() {
        if (fsm.phase() === "AUTONOMOUS_EXECUTION") {
            applyPause();
        } else if (fsm.phase() === "WARDEN_AUDIT") {
            budgetPauseRequested = true;
        }
    }

    function onBudgetResumed() {
        if (fsm.phase() !== "BUDGET_PAUSED") {
            return;
        }
        fsm.transition("AUTONOMOUS_EXECUTION");
        state.budget.paused = false;
        persist();
    }

    if (proxy?.events && typeof proxy.events.on === "function") {
        proxy.events.on("budget.cutoff", onBudgetCutoff);
        proxy.events.on("budget.resumed", onBudgetResumed);
    }

    function resumeFromDisk() {
        const snap = durable.restore(workspace);
        if (!snap) {
            return null;
        }
        if (!PHASES.includes(snap.phase)) {
            throw Object.assign(
                new Error(`snapshot has unknown phase: ${snap.phase}`),
                {
                    code: "unknown_phase",
                    phase: snap.phase,
                },
            );
        }
        fsm.set(snap.phase);
        state.contract = snap.contract ?? null;
        state.rejected_count = snap.rejected_count ?? {};
        state.savedAt = snap.savedAt ?? null;
        // The persisted queue is advisory metadata: milestone functions cannot
        // survive JSON. Re-supply options.plan to continue executing.
        return snap;
    }

    const closedLoop = {
        phase: () => fsm.phase(),
        startInterview,
        freezeContract,
        run,
        submitEvidence,
        verdicts: () => [...verdictLog],
        resumeFromDisk,
        state,
        events,
    };
    return closedLoop;
}

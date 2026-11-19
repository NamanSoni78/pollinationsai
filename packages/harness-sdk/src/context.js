/**
 * Layered context compiler and auto-compaction for Agent Ground child VMs.
 *
 * The six layers (deterministic order, "\n\n" separated):
 *   1 STATIC PREFIX      — identity, role, goal, operating rules
 *   2 ACTIVE SKILLS      — bodies of loaded skills
 *   3 USER INTENT ANCHOR — ALL past user messages, verbatim, never dropped
 *   4 WORKLOG            — append-only milestone log
 *   5 TELEMETRY          — git/contract/inbox/budget/directives (stable JSON)
 *   6 WORKING WINDOW     — recent turn summaries; the only compactable layer
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Token estimate: chars / 4 (documented heuristic, not a tokenizer). */
export const estTokens = (text) => Math.ceil(String(text ?? "").length / 4);

/** Atomic file write: write to `<path>.tmp` then rename (conventions §1). */
export const atomicWrite = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, text);
    renameSync(tmp, path);
};

/** Atomic JSON write; JSON files always end with a newline. */
export const atomicWriteJson = (path, data) =>
    atomicWrite(path, `${JSON.stringify(data, null, 4)}\n`);

const LAYERS = [
    ["staticPrefix", "[Layer 1 — STATIC PREFIX]"],
    ["activeSkills", "[Layer 2 — ACTIVE SKILLS]"],
    ["userIntentAnchor", "[Layer 3 — USER INTENT ANCHOR]"],
    ["worklog", "[Layer 4 — WORKLOG]"],
    ["telemetry", "[Layer 5 — TELEMETRY]"],
    ["workingWindow", "[Layer 6 — WORKING WINDOW]"],
];

const PINNED_LAYERS = [
    "staticPrefix",
    "activeSkills",
    "userIntentAnchor",
    "worklog",
    "telemetry",
];

const sortKeysDeep = (value) => {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, sortKeysDeep(value[key])]),
        );
    }
    return value;
};

const renderTurn = (turn) =>
    typeof turn === "string"
        ? turn
        : `[${turn?.at ?? ""}] ${turn?.summary ?? ""}`;

const staticPrefixOf = (state) => {
    if (
        typeof state.staticPrefix === "string" &&
        state.staticPrefix.length > 0
    ) {
        return state.staticPrefix;
    }
    const lines = ["You are an autonomous agent in an Agent Ground child VM."];
    if (state.agentId)
        lines.push(`Agent: ${state.agentId} | Role: ${state.role ?? "worker"}`);
    if (state.currentGoal) lines.push(`Current goal: ${state.currentGoal}`);
    lines.push(
        "Human input is disabled; never ask the user. Use tools, skills, RAG and the ground hub.",
    );
    return lines.join("\n");
};

const activeSkillsOf = (state) => {
    const skills = state.skills ?? [];
    if (!skills.length) return "(no active skills)";
    return skills
        .map((skill) => `### skill: ${skill.name}\n${skill.body}`)
        .join("\n\n");
};

const userIntentAnchorOf = (state) => {
    const messages = (state.messages ?? [])
        .filter((message) => message?.role === "user")
        .map((message) => String(message.content));
    return messages.length ? messages.join("\n\n") : "(no user messages yet)";
};

const telemetryOf = (state) =>
    JSON.stringify(sortKeysDeep(state.telemetry ?? {}), null, 4);

const workingWindowOf = (state) => {
    const turns = state.workingWindow?.turns ?? [];
    return turns.length
        ? turns.map(renderTurn).join("\n")
        : "(working window empty)";
};

/**
 * Compile the deterministic six-layer context.
 *
 * @param {object} state agent state (messages, skills, worklog, telemetry,
 *   workingWindow, contextBudgetTokens, ...)
 * @returns {{layers: Record<string, string>, text: string, tokenEstimate: number}}
 *   `layers` maps each layer name to its rendered string; `text` joins all
 *   layers with their headers using "\n\n" separators.
 */
export function compileContext(state = {}) {
    const layers = {
        staticPrefix: staticPrefixOf(state),
        activeSkills: activeSkillsOf(state),
        userIntentAnchor: userIntentAnchorOf(state),
        worklog: state.worklog || "(worklog empty)",
        telemetry: telemetryOf(state),
        workingWindow: workingWindowOf(state),
    };
    const text = LAYERS.map(
        ([key, header]) => `${header}\n${layers[key]}`,
    ).join("\n\n");
    return { layers, text, tokenEstimate: estTokens(text) };
}

/**
 * Auto-compact the working window once it exceeds ~70% of the tokens left to
 * it (contextBudgetTokens minus the other five layers). Archives the window
 * turns to `<workspace>/.agent/logs/<uuid>.txt`, appends a structured
 * milestone to WORKLOG.md (and `state.worklog`) and resets the window.
 * Layer 3 (all past user messages) is never touched.
 *
 * @param {object} state agent state; `workspace` is only needed to persist
 *   the archive and WORKLOG line (missing workspace compacts in memory)
 * @returns {{compacted: boolean, thresholdTokens: number, workingWindowTokens: number,
 *   archivePath: string|null, archivedTurns: number}}
 */
export function maybeCompact(state) {
    const budget = state.contextBudgetTokens ?? 100000;
    const compiled = compileContext(state);
    const otherTokens = PINNED_LAYERS.reduce(
        (total, key) => total + estTokens(compiled.layers[key]),
        0,
    );
    const windowTokens = estTokens(compiled.layers.workingWindow);
    const thresholdTokens = Math.floor(0.7 * Math.max(0, budget - otherTokens));
    if (windowTokens <= thresholdTokens) {
        return {
            compacted: false,
            thresholdTokens,
            workingWindowTokens: windowTokens,
            archivePath: null,
            archivedTurns: 0,
        };
    }
    const turns = state.workingWindow?.turns ?? [];
    const archiveText = turns.map(renderTurn).join("\n\n");
    let archivePath = null;
    if (state.workspace) {
        try {
            archivePath = join(
                state.workspace,
                ".agent",
                "logs",
                `${randomUUID()}.txt`,
            );
            atomicWrite(archivePath, `${archiveText}\n`);
        } catch {
            archivePath = null; // compaction must never fail on archive write errors
        }
    }
    const line = `- [${new Date().toISOString()}] compaction: archived ${turns.length} turn(s) (~${windowTokens} tokens) to ${archivePath ?? "(in-memory)"}`;
    state.worklog = `${state.worklog ? `${String(state.worklog).replace(/\n+$/, "")}\n` : ""}${line}\n`;
    if (state.workspace) {
        try {
            appendFileSync(join(state.workspace, "WORKLOG.md"), `${line}\n`);
        } catch {
            // WORKLOG append is best-effort; state.worklog already carries it.
        }
    }
    state.workingWindow = { turns: [] };
    return {
        compacted: true,
        thresholdTokens,
        workingWindowTokens: windowTokens,
        archivePath,
        archivedTurns: turns.length,
    };
}

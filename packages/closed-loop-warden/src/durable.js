// Durable closed-loop state: <workspace>/.agent/state.json, written
// atomically (tmp + rename). Queue items are functions in memory; on disk
// they become advisory descriptors — a serialized plan cannot be executed
// after a crash, so callers re-supply options.plan on resume.

import fs from "node:fs";
import path from "node:path";

export const STATE_FILE = ".agent/state.json";

const DEFAULTS = {
    phase: null,
    contract: null,
    active_skills: [],
    pollen_ledger: [],
    git_sha: null,
    ground_subscriptions: [],
    queue: [],
    rejected_count: {},
};

/** Absolute path of the durable state file inside a workspace. */
export function statePath(workspace) {
    return path.join(workspace, STATE_FILE);
}

/**
 * Atomically persist a closed-loop snapshot to <workspace>/.agent/state.json.
 * The file always ends with a newline; a `.tmp` sibling is renamed over the
 * target so readers never observe a partial write.
 *
 * @param {string} workspace
 * @param {object} snapshot subset of DEFAULTS keys; queue items may be functions
 * @returns {object} the persisted body (with savedAt)
 */
export function persist(workspace, snapshot = {}) {
    const file = statePath(workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
        if (snapshot[key] !== undefined) {
            body[key] = snapshot[key];
        }
    }
    body.queue = (Array.isArray(body.queue) ? body.queue : []).map(
        describeQueueItem,
    );
    body.rejected_count = body.rejected_count ?? {};
    body.savedAt = new Date().toISOString();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 4)}\n`);
    fs.renameSync(tmp, file);
    return body;
}

/**
 * Restore the durable snapshot from <workspace>/.agent/state.json.
 *
 * @param {string} workspace
 * @returns {object | null} the snapshot, or null when missing/unreadable
 */
export function restore(workspace) {
    try {
        return JSON.parse(fs.readFileSync(statePath(workspace), "utf8"));
    } catch {
        return null;
    }
}

function describeQueueItem(item) {
    if (typeof item === "function") {
        return { type: "milestone", id: item.name || "anonymous" };
    }
    if (item && typeof item === "object") {
        if (item.kind === "fix") {
            return { type: "fix", req_id: item.req_id, action: item.action };
        }
        if (item.kind === "consult_expert") {
            return { type: "consult_expert", packet: item.packet };
        }
    }
    return { type: "opaque", summary: safeStringify(item) };
}

function safeStringify(value) {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return "[unserializable]";
    }
}

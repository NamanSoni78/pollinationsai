/**
 * Autonomous git engine for child VM workspaces: idempotent init (branch
 * `agent/<agentId>/<task>`, guard .gitignore, local identity), checkpoints
 * gated by a pre-commit secret scan, branch experiments and rollback.
 * Drives the real `git` binary via execFileSync — never shells out to
 * anything else and never touches files outside the workspace.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./context.js";

const git = (workspace, args) => {
    try {
        return execFileSync("git", args, {
            cwd: workspace,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    } catch (error) {
        const stderr =
            String(error.stderr ?? "").trim() ||
            String(error.message ?? "git failed");
        throw new Error(`git ${args[0]} failed in ${workspace}: ${stderr}`, {
            cause: error,
        });
    }
};

/** The six secret patterns from the spec (spec §3.3). */
export const SECRET_PATTERNS = [
    { pattern: "sk_[A-Za-z0-9]{16,}", regex: /\bsk_[A-Za-z0-9]{16,}\b/ },
    { pattern: "pk_[A-Za-z0-9]{16,}", regex: /\bpk_[A-Za-z0-9]{16,}\b/ },
    { pattern: "github_pat_", regex: /github_pat_/ },
    { pattern: "ghp_[A-Za-z0-9]{20,}", regex: /\bghp_[A-Za-z0-9]{20,}\b/ },
    { pattern: "AKIA[0-9A-Z]{16}", regex: /\bAKIA[0-9A-Z]{16}\b/ },
    {
        pattern: "-----BEGIN ... PRIVATE KEY-----",
        regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    },
];

/**
 * Scan file contents for known secret patterns.
 *
 * @param {Array<{path: string, content: string}>} files
 * @returns {Array<{file: string, line: number, pattern: string}>} 1-based lines
 */
export function secretScan(files) {
    const findings = [];
    for (const file of files ?? []) {
        const path = String(file?.path ?? file?.file ?? "?");
        const lines = String(file?.content ?? file?.text ?? "").split(/\r?\n/);
        lines.forEach((line, index) => {
            for (const { pattern, regex } of SECRET_PATTERNS) {
                if (regex.test(line))
                    findings.push({ file: path, line: index + 1, pattern });
            }
        });
    }
    return findings;
}

const changedEntries = (workspace) => {
    const raw = git(workspace, [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "-z",
    ]);
    const entries = [];
    for (const record of raw.split("\0")) {
        if (!record) continue;
        const match = /^([ MARCDU?!.]{1,2}) (.+)$/s.exec(record);
        if (match) entries.push({ status: match[1], path: match[2] });
    }
    return entries;
};

const scanWorkspaceForSecrets = (workspace) => {
    const files = changedEntries(workspace)
        .filter((entry) => existsSync(join(workspace, entry.path)))
        .map((entry) => {
            try {
                return {
                    path: entry.path,
                    content: readFileSync(join(workspace, entry.path), "utf8"),
                };
            } catch {
                return null;
            }
        })
        .filter(Boolean);
    return secretScan(files);
};

const assertNoSecrets = (workspace) => {
    const findings = scanWorkspaceForSecrets(workspace);
    if (findings.length) {
        const error = new Error(
            `secret scan blocked commit: ${findings.map((finding) => `${finding.file}:${finding.line} ${finding.pattern}`).join("; ")}`,
        );
        error.code = "secret_detected";
        error.findings = findings;
        throw error;
    }
};

const headSha = (workspace) => {
    try {
        return git(workspace, ["rev-parse", "HEAD"]);
    } catch {
        return null;
    }
};

const commitAll = (workspace, message) => {
    git(workspace, ["add", "-A"]);
    const staged = git(workspace, ["diff", "--cached", "--name-only"]);
    if (!staged) {
        if (headSha(workspace))
            return { sha: headSha(workspace), committed: false };
        git(workspace, ["commit", "--allow-empty", "-m", message]);
    } else {
        git(workspace, ["commit", "-m", message]);
    }
    return { sha: headSha(workspace), committed: true };
};

/**
 * Initialize (idempotently) a child VM workspace as a git repo: branch
 * `agent/<agentId>/<task>`, guard `.gitignore` (.env, .agent/logs/,
 * node_modules/, dist/), local user.name/user.email from `identity`, local
 * gpgsign off, then an initial commit. Existing secrets block the init.
 *
 * @param {string} workspace absolute path (created when missing)
 * @param {{agentId?: string, task?: string, identity?: {name: string, email: string}}} [options]
 * @returns {{workspace: string, branch: string, sha: string, committed: boolean}}
 */
export function initWorkspaceGit(
    workspace,
    { agentId = "agent", task = "main", identity } = {},
) {
    if (!workspace) throw new Error("initWorkspaceGit requires workspace");
    mkdirSync(workspace, { recursive: true });
    if (!existsSync(join(workspace, ".git"))) git(workspace, ["init"]);
    const branch = `agent/${agentId}/${task}`;
    git(workspace, ["checkout", "-B", branch]);
    git(workspace, ["config", "user.name", identity?.name ?? "agent-ground"]);
    git(workspace, [
        "config",
        "user.email",
        identity?.email ?? "agent-ground@users.noreply.github.com",
    ]);
    git(workspace, ["config", "commit.gpgsign", "false"]);
    const gitignore = join(workspace, ".gitignore");
    if (!existsSync(gitignore))
        atomicWrite(gitignore, ".env\n.agent/logs/\nnode_modules/\ndist/\n");
    assertNoSecrets(workspace);
    return {
        workspace,
        branch,
        ...commitAll(workspace, "chore: agent workspace init"),
    };
}

/**
 * Commit everything (`git add -A`) after a secret scan of the pending
 * changes. Findings abort the commit before anything is staged.
 *
 * @param {string} workspace absolute path
 * @param {{message?: string}} [options]
 * @returns {{sha: string, committed: boolean}}
 * @throws {Error} code `secret_detected` with `.findings` (file:line + pattern)
 */
export function gitCheckpoint(workspace, { message = "checkpoint" } = {}) {
    assertNoSecrets(workspace);
    return commitAll(workspace, message);
}

/**
 * Create and check out an experiment branch.
 *
 * @param {string} workspace absolute path
 * @param {{name?: string}} [options] default `experiment/<uuid8>`
 * @returns {{branch: string}}
 */
export function gitBranchExperiment(workspace, { name } = {}) {
    const branch = name ?? `experiment/${randomUUID().slice(0, 8)}`;
    git(workspace, ["checkout", "-B", branch]);
    return { branch };
}

/**
 * Roll the workspace back to a sha or tag (force checkout of the target).
 *
 * @param {string} workspace absolute path
 * @param {{ref: string}} options sha or tag
 * @returns {{restored_sha: string}}
 */
export function gitRollback(workspace, { ref } = {}) {
    if (!ref) throw new Error("gitRollback requires ref");
    git(workspace, ["checkout", "-f", ref]);
    return { restored_sha: headSha(workspace) };
}

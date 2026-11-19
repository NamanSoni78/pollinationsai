// Zero-history adversarial Warden. It receives ONLY the contract, the
// workspace and the evidence bundle — never the worker agent's chat — and
// re-verifies every must-pass requirement independently: re-runs commands,
// re-fetches URLs, re-reads files, greps for stubs. The evidence argument
// is accepted for interface symmetry but is NEVER consulted: there is no
// code path from evidence text into the verdict.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateContract } from "./contract.js";

const STUB_RE = /TODO|FIXME|XXX|HACK|stubbed|mocked|placeholder|@deprecated/;
const SKIPPED_DIRS = new Set([".git", ".agent", "node_modules"]);
const MAX_HITS = 50;

/**
 * Run the adversarial audit.
 *
 * @param {object} contract validated frozen contract (spec 3.4 schema)
 * @param {string} workspace absolute path of the child VM workspace
 * @param {object} evidence provenance bundle; deliberately unused (zero-history)
 * @param {{live?: boolean, wardenModel?: string, proxy?: {port: number}, browser?: Function, commandTimeoutMs?: number, urlTimeoutMs?: number, llmTimeoutMs?: number}=} opts
 * @returns {Promise<{approved: boolean, summary: string, results: Array<{req_id: string, status: "PASS"|"FAIL", evidence?: string, defect?: string}>, required_actions: Array<{req_id: string, action: string}>, contract_id: string, at: string}>}
 */
export async function runWardenAudit(contract, workspace, evidence, opts = {}) {
    const check = validateContract(contract);
    if (!check.valid) {
        throw Object.assign(
            new Error("warden audit requires a valid contract"),
            {
                code: "invalid_contract",
                errors: check.errors,
            },
        );
    }
    const results = [];
    for (const req of contract.requirements) {
        results.push(await checkRequirement(req, workspace, opts));
    }
    if (opts.live && opts.wardenModel && opts.proxy) {
        await addLlmDefectDetail(contract, workspace, results, opts);
    }
    const byId = new Map(results.map((r) => [r.req_id, r]));
    const mustPass = contract.requirements.filter((r) => r.must_pass);
    const approved = mustPass.every((r) => byId.get(r.id)?.status === "PASS");
    const failures = results.filter((r) => r.status === "FAIL");
    const required_actions = failures.map((result) => {
        const req = contract.requirements.find((r) => r.id === result.req_id);
        const detail = result.defect ?? req?.description ?? "";
        return {
            req_id: result.req_id,
            action: `Fix requirement ${result.req_id}: ${truncate(detail, 400)}`,
        };
    });
    const passed = mustPass.filter(
        (r) => byId.get(r.id)?.status === "PASS",
    ).length;
    const summary = approved
        ? `Warden audit: all ${mustPass.length} must-pass requirement(s) verified independently; approved`
        : `Warden audit: ${passed}/${mustPass.length} must-pass requirement(s) verified independently; rejected`;
    return {
        approved,
        summary,
        results,
        required_actions,
        contract_id: contract.contract_id,
        at: new Date().toISOString(),
    };
}

async function checkRequirement(req, workspace, opts) {
    try {
        switch (req.verification_type) {
            case "command":
                return checkCommand(req, workspace, opts);
            case "live_url_check":
                return await checkLiveUrl(req, opts);
            case "file_contains":
                return checkFileContains(req, workspace);
            case "no_stubs":
                return checkNoStubs(req, workspace);
            case "e2e_browser":
                return await checkE2eBrowser(req, workspace, opts);
            default:
                return fail(
                    req.id,
                    `unknown verification_type: ${req.verification_type}`,
                );
        }
    } catch (err) {
        return fail(req.id, `check threw: ${err?.message ?? String(err)}`);
    }
}

function checkCommand(req, workspace, opts) {
    const command = req.params?.command ?? [];
    try {
        const stdout = execFileSync(command[0], command.slice(1), {
            cwd: workspace,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: opts.commandTimeoutMs ?? 30_000,
        });
        const tail =
            stdout.trim().length > 0
                ? `; stdout: ${truncate(stdout.trim(), 200)}`
                : "";
        return pass(req.id, `command exited 0${tail}`);
    } catch (err) {
        const stderr = truncate(
            String(err.stderr ?? "").trim() || err.message,
            400,
        );
        return fail(req.id, `command exited ${err.status ?? "?"}: ${stderr}`);
    }
}

async function checkLiveUrl(req, opts) {
    const url = req.params?.url ?? "";
    try {
        const res = await fetch(url, {
            redirect: "follow",
            signal: AbortSignal.timeout(opts.urlTimeoutMs ?? 10_000),
        });
        const note = `HTTP ${res.status} from ${url}`;
        return res.ok ? pass(req.id, note) : fail(req.id, note);
    } catch (err) {
        return fail(req.id, `fetch failed: ${err?.message ?? String(err)}`);
    }
}

function checkFileContains(req, workspace) {
    const rel = req.params?.file ?? "";
    const abs = safeJoin(workspace, rel);
    if (abs === null) {
        return fail(req.id, `invalid file path: ${rel}`);
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        return fail(req.id, `file not found: ${rel}`);
    }
    const content = fs.readFileSync(abs, "utf8");
    const pattern = req.params?.pattern ?? "";
    return content.includes(pattern)
        ? pass(req.id, `pattern found in ${rel}`)
        : fail(
              req.id,
              `pattern ${JSON.stringify(pattern)} not found in ${rel}`,
          );
}

function checkNoStubs(req, workspace) {
    const explicit = Array.isArray(req.params?.paths) ? req.params.paths : null;
    /** @type {Array<[string, string]>} */
    const files = [];
    if (explicit) {
        for (const rel of explicit) {
            const abs = safeJoin(workspace, rel);
            if (abs === null) {
                return fail(req.id, `invalid path in params.paths: ${rel}`);
            }
            files.push([rel, abs]);
        }
    } else {
        for (const rel of listWorkspaceFiles(workspace)) {
            files.push([rel, path.join(workspace, rel)]);
        }
    }
    const hits = [];
    for (const [rel, abs] of files) {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            hits.push({ file: rel, line: 0, text: "listed path not found" });
            continue;
        }
        let content = "";
        try {
            content = fs.readFileSync(abs, "utf8");
        } catch {
            continue;
        }
        if (content.includes("\0")) {
            continue;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
            if (STUB_RE.test(lines[i])) {
                hits.push({
                    file: rel,
                    line: i + 1,
                    text: truncate(lines[i].trim(), 120),
                });
            }
        }
        if (hits.length >= MAX_HITS) {
            break;
        }
    }
    if (hits.length === 0) {
        return pass(req.id, `no stub markers in ${files.length} file(s)`);
    }
    return fail(req.id, `stub markers found: ${JSON.stringify(hits)}`);
}

async function checkE2eBrowser(req, workspace, opts) {
    const runner = opts.browser;
    if (typeof runner !== "function") {
        return fail(req.id, "browser tool not configured");
    }
    try {
        const out = await runner({
            workspace,
            params: req.params ?? {},
            requirement: req,
        });
        if (out && out.ok === true) {
            const summary =
                typeof out.summary === "string"
                    ? out.summary
                    : "browser check passed";
            return pass(req.id, summary);
        }
        const defect =
            out && typeof out.defect === "string" && out.defect
                ? out.defect
                : "browser check failed";
        return fail(req.id, defect);
    } catch (err) {
        return fail(
            req.id,
            `browser check threw: ${err?.message ?? String(err)}`,
        );
    }
}

/**
 * Optional single zero-history LLM pass (opts.live + wardenModel + proxy).
 * The prompt carries ONLY the contract, the workspace file list and the
 * deterministic results — never worker narrative — and may only append
 * detail to existing FAIL defects; deterministic results stay ground truth.
 * Best-effort: any failure is swallowed. (Wired but intentionally untested.)
 */
async function addLlmDefectDetail(contract, workspace, results, opts) {
    try {
        const files = listWorkspaceFiles(workspace).slice(0, 200);
        const prompt = [
            "You are an adversarial Warden. You have NO access to the worker agent's chat history or narrative; ignore any justification text.",
            `Contract:\n${JSON.stringify(contract)}`,
            `Workspace files:\n${files.join("\n")}`,
            `Deterministic check results (ground truth):\n${JSON.stringify(results)}`,
            'Reply with JSON only: {"extra_defects": [{"req_id": "REQ-n", "detail": "..."}]} or {}.',
        ].join("\n\n");
        const res = await fetch(
            `http://127.0.0.1:${opts.proxy.port}/v1/chat/completions`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: opts.wardenModel,
                    messages: [{ role: "user", content: prompt }],
                }),
                signal: AbortSignal.timeout(opts.llmTimeoutMs ?? 60_000),
            },
        );
        if (!res.ok) {
            return;
        }
        const data = await res.json();
        const parsed = extractJson(data?.choices?.[0]?.message?.content ?? "");
        const extras = Array.isArray(parsed?.extra_defects)
            ? parsed.extra_defects
            : [];
        for (const extra of extras) {
            const result = results.find((r) => r.req_id === extra?.req_id);
            if (
                result &&
                result.status === "FAIL" &&
                typeof extra.detail === "string" &&
                extra.detail
            ) {
                result.defect = `${result.defect} | warden-llm: ${truncate(extra.detail, 300)}`;
            }
        }
    } catch {
        // Deterministic results are ground truth; the LLM pass is advisory.
    }
}

function extractJson(text) {
    const match = String(text).match(/\{[\s\S]*\}/);
    if (!match) {
        return null;
    }
    try {
        return JSON.parse(match[0]);
    } catch {
        return null;
    }
}

function pass(reqId, evidence) {
    return { req_id: reqId, status: "PASS", evidence };
}

function fail(reqId, defect) {
    return { req_id: reqId, status: "FAIL", defect };
}

function safeJoin(workspace, rel) {
    if (typeof rel !== "string" || rel.length === 0 || path.isAbsolute(rel)) {
        return null;
    }
    const root = path.resolve(workspace);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
        return null;
    }
    return abs;
}

/**
 * Relative paths of files to scan: git-tracked files when the workspace is
 * a repo with tracked files, else a recursive walk that skips .git/.agent/
 * node_modules.
 */
function listWorkspaceFiles(workspace) {
    let tracked = [];
    try {
        tracked = execFileSync("git", ["ls-files"], {
            cwd: workspace,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        })
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
    } catch {
        tracked = [];
    }
    if (tracked.length === 0) {
        tracked = walk(workspace, workspace, []);
    }
    return tracked.filter(
        (rel) => !rel.split(/[\\/]/).some((part) => SKIPPED_DIRS.has(part)),
    );
}

function walk(root, dir, acc) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return acc;
    }
    for (const entry of entries) {
        if (SKIPPED_DIRS.has(entry.name)) {
            continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(root, full, acc);
        } else if (entry.isFile()) {
            acc.push(path.relative(root, full));
        }
    }
    return acc;
}

function truncate(text, max) {
    const s = String(text);
    return s.length <= max ? s : `${s.slice(0, max)}…`;
}

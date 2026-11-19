// Preflight interview + contract freeze. The contract is the single frozen
// artifact the Warden later re-verifies; every field error must be precise.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DEPLOY_TARGETS = Object.freeze([
    "cloudflare_pages",
    "cloudflare_workers",
    "edgeone_pages",
    "none",
]);

export const VERIFICATION_TYPES = Object.freeze([
    "command",
    "live_url_check",
    "file_contains",
    "no_stubs",
    "e2e_browser",
]);

const ISO_RE =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * The single preflight interview batch (one focused round, per the quest).
 * Prompts are derived from `interviewContext` (e.g. {goal}) or defaults.
 *
 * @param {{goal?: string}=} interviewContext
 * @returns {Array<{id: string, topic: string, kind: string, question: string, choices?: string[], hint?: object}>}
 */
export function interviewQuestions(interviewContext = {}) {
    const ctx = interviewContext ?? {};
    const goal =
        typeof ctx.goal === "string" && ctx.goal.trim().length > 0
            ? ctx.goal.trim()
            : "the requested build";
    return [
        {
            id: "design_direction",
            topic: "design",
            kind: "text",
            question: `Describe the design direction for ${goal} (stack, structure, look).`,
        },
        {
            id: "required_features",
            topic: "scope",
            kind: "text",
            question:
                "List every required feature. Each becomes a numbered contract requirement.",
        },
        {
            id: "requirement_specs",
            topic: "contract",
            kind: "requirements",
            question:
                "Give one verifiable spec per feature: {description, verification_type, must_pass, params}. The Warden will re-check each one independently.",
            hint: {
                verification_type: [...VERIFICATION_TYPES],
                must_pass: "boolean (default true)",
                params: "per verification_type",
            },
        },
        {
            id: "edge_cases",
            topic: "robustness",
            kind: "text",
            question:
                "Which edge cases must be handled? Encode critical ones as extra requirement_specs entries.",
        },
        {
            id: "deploy_target",
            topic: "deployment",
            kind: "choice",
            choices: [...DEPLOY_TARGETS],
            question: "Where must the finished work deploy?",
        },
        {
            id: "hard_constraints",
            topic: "constraints",
            kind: "text",
            question:
                "Any hard constraints (Pollen ceiling, no new runtime deps, style)? Encode violations as must_pass requirements.",
        },
    ];
}

/**
 * Build a contract from interview answers. Requirement ids are assigned
 * REQ-1..n in order; must_pass defaults to true.
 *
 * @param {{deploy_target?: string, requirements?: Array<{description?: string, verification_type?: string, must_pass?: boolean, params?: object}>}=} answers
 * @returns {{contract_id: string, locked_at: string, deploy_target: string, requirements: Array<object>}}
 */
export function buildContract(answers = {}) {
    const src = answers ?? {};
    const requirements = (
        Array.isArray(src.requirements) ? src.requirements : []
    ).map((req, index) => ({
        id: `REQ-${index + 1}`,
        description: req?.description,
        verification_type: req?.verification_type,
        must_pass: req?.must_pass ?? true,
        params: req?.params ?? {},
    }));
    return {
        contract_id: `contract-${crypto.randomUUID().slice(0, 8)}`,
        locked_at: new Date().toISOString(),
        deploy_target: src.deploy_target ?? "none",
        requirements,
    };
}

/**
 * Validate a contract against the spec schema.
 *
 * @param {object} contract
 * @returns {{valid: boolean, errors: Array<{field: string, message: string}>}}
 */
export function validateContract(contract) {
    if (!contract || typeof contract !== "object") {
        return {
            valid: false,
            errors: [
                { field: "contract", message: "contract must be an object" },
            ],
        };
    }
    const errors = [];
    const fail = (field, message) => errors.push({ field, message });
    if (
        typeof contract.contract_id !== "string" ||
        contract.contract_id.length === 0
    ) {
        fail("contract_id", "contract_id must be a non-empty string");
    }
    if (
        typeof contract.locked_at !== "string" ||
        !ISO_RE.test(contract.locked_at)
    ) {
        fail("locked_at", "locked_at must be an ISO date string");
    }
    if (!DEPLOY_TARGETS.includes(contract.deploy_target)) {
        fail(
            "deploy_target",
            `deploy_target must be one of: ${DEPLOY_TARGETS.join(", ")}`,
        );
    }
    validateRequirements(contract.requirements, fail);
    return { valid: errors.length === 0, errors };
}

function validateRequirements(requirements, fail) {
    if (!Array.isArray(requirements) || requirements.length === 0) {
        fail("requirements", "requirements must be a non-empty array");
        return;
    }
    const seen = new Set();
    requirements.forEach((req, index) => {
        const where = `requirements[${index}]`;
        if (!req || typeof req !== "object") {
            fail(where, "requirement must be an object");
            return;
        }
        if (typeof req.id !== "string" || !/^REQ-\d+$/.test(req.id)) {
            fail(`${where}.id`, "id must match REQ-<n>");
        } else if (seen.has(req.id)) {
            fail(`${where}.id`, `duplicate requirement id: ${req.id}`);
        } else {
            seen.add(req.id);
        }
        if (
            typeof req.description !== "string" ||
            req.description.trim().length === 0
        ) {
            fail(
                `${where}.description`,
                "description must be a non-empty string",
            );
        }
        if (!VERIFICATION_TYPES.includes(req.verification_type)) {
            fail(
                `${where}.verification_type`,
                `verification_type must be one of: ${VERIFICATION_TYPES.join(", ")}`,
            );
        }
        if (typeof req.must_pass !== "boolean") {
            fail(`${where}.must_pass`, "must_pass must be a boolean");
        }
        validateParams(req, where, fail);
    });
}

function validateParams(req, where, fail) {
    const params = req.params;
    if (
        params !== undefined &&
        (params === null || typeof params !== "object" || Array.isArray(params))
    ) {
        fail(`${where}.params`, "params must be an object when present");
        return;
    }
    const p = params ?? {};
    switch (req.verification_type) {
        case "command":
            if (
                !Array.isArray(p.command) ||
                p.command.length === 0 ||
                p.command.some((c) => typeof c !== "string" || c.length === 0)
            ) {
                fail(
                    `${where}.params.command`,
                    "command requires params.command: non-empty array of strings",
                );
            }
            break;
        case "live_url_check":
            if (typeof p.url !== "string" || !/^https?:\/\//.test(p.url)) {
                fail(
                    `${where}.params.url`,
                    "live_url_check requires params.url: http(s) URL string",
                );
            }
            break;
        case "file_contains":
            if (
                typeof p.file !== "string" ||
                p.file.length === 0 ||
                path.isAbsolute(p.file) ||
                p.file.split(/[\\/]/).includes("..")
            ) {
                fail(
                    `${where}.params.file`,
                    "file_contains requires params.file: relative path inside the workspace",
                );
            }
            if (typeof p.pattern !== "string" || p.pattern.length === 0) {
                fail(
                    `${where}.params.pattern`,
                    "file_contains requires params.pattern: non-empty string",
                );
            }
            break;
        case "no_stubs":
            if (
                p.paths !== undefined &&
                (!Array.isArray(p.paths) ||
                    p.paths.some((x) => typeof x !== "string"))
            ) {
                fail(
                    `${where}.params.paths`,
                    "no_stubs params.paths must be an array of relative paths when present",
                );
            }
            break;
        default:
            break;
    }
}

/**
 * Atomically write the frozen contract to <workspace>/CONTRACT.json.
 *
 * @param {string} workspace
 * @param {object} contract
 * @returns {string} the written file path
 */
export function writeContract(workspace, contract) {
    const file = path.join(workspace, "CONTRACT.json");
    fs.mkdirSync(workspace, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(contract, null, 4)}\n`);
    fs.renameSync(tmp, file);
    return file;
}

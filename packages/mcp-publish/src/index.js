/**
 * MCP tool adapter for the Agent Ground publish tools.
 *
 * Mirrors the tool-array shape of packages/mcp/src/services/*Service.js:
 * each tool is `[name, description, zodInputSchema, handler]` and handlers
 * return `{content: [{type: "text", text}]}`. Credentials come ONLY from the
 * environment (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, EDGEONE_API_TOKEN,
 * plus CLOUDFLARE_API_BASE / EDGEONE_API_BASE overrides); the core modules
 * return `{configured: false, env, hint}` without any network call when a
 * credential is missing, and every deploy auto-verifies the returned URL.
 */

import { z } from "zod";
import {
    deployPages as cfDeployPages,
    deployWorker as cfDeployWorker,
    getDeploymentLogs as cfGetDeploymentLogs,
    setEnvVar as cfSetEnvVar,
} from "./cloudflare.js";
import {
    deployPages as eoDeployPages,
    getDeploymentStatus as eoGetDeploymentStatus,
    getLogs as eoGetLogs,
} from "./edgeone.js";

function textResult(data) {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** Wrap a core function: structured payload on success, isError on failure. */
function toolHandler(run) {
    return async (params) => {
        try {
            return textResult(await run(params ?? {}));
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({ error: error.message }, null, 2),
                    },
                ],
                isError: true,
            };
        }
    };
}

const projectSchema = z
    .string()
    .min(1)
    .describe("Pages project name (lowercase letters, digits and hyphens)");

const directorySchema = z
    .string()
    .min(1)
    .describe(
        "Absolute or cwd-relative path of the directory to deploy (dotfiles and node_modules are skipped)",
    );

/**
 * Build the publish tool array.
 *
 * @returns {Array<[string, string, Object, Function]>} Tool tuples compatible
 *     with the McpServer.registerTool loop in packages/mcp/src/server.js.
 */
export function publishTools() {
    return [
        [
            "cloudflare_deploy_pages",
            "Deploy a static directory to Cloudflare Pages via Direct Upload and verify the live URL. " +
                "Creates the project when missing. Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
            {
                project: projectSchema,
                directory: directorySchema,
                branch: z
                    .string()
                    .optional()
                    .describe(
                        "Branch to deploy; also the production branch when creating the project",
                    ),
            },
            toolHandler((params) => cfDeployPages(params)),
        ],
        [
            "cloudflare_deploy_worker",
            "Upload a directory of ES modules as a Cloudflare Worker and verify its workers.dev URL. " +
                "Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
            {
                name: z.string().min(1).describe("Worker script name"),
                directory: directorySchema,
                main: z
                    .string()
                    .optional()
                    .describe(
                        "Entry module path (default: index.js, main.js, worker.js or src/index.js)",
                    ),
            },
            toolHandler((params) => cfDeployWorker(params)),
        ],
        [
            "cloudflare_set_env_var",
            "Set a plaintext environment variable on a Cloudflare Pages project (production or preview). " +
                "Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
            {
                project: projectSchema,
                key: z.string().min(1).describe("Variable name"),
                value: z
                    .string()
                    .describe("Variable value (stored as plain text)"),
                env: z
                    .enum(["production", "preview"])
                    .optional()
                    .describe("Pages environment (default: production)"),
            },
            toolHandler((params) => cfSetEnvVar(params)),
        ],
        [
            "cloudflare_get_deployment_logs",
            "Fetch the build logs of a Cloudflare Pages deployment. " +
                "Requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.",
            {
                project: projectSchema,
                deploymentId: z
                    .string()
                    .min(1)
                    .describe("Deployment id from cloudflare_deploy_pages"),
            },
            toolHandler((params) => cfGetDeploymentLogs(params)),
        ],
        [
            "edgeone_deploy_pages",
            "Deploy a static directory to EdgeOne Pages (Tencent) and verify the live URL. " +
                "Creates the project when missing. Requires EDGEONE_API_TOKEN.",
            {
                project: projectSchema,
                directory: directorySchema,
            },
            toolHandler((params) => eoDeployPages(params)),
        ],
        [
            "edgeone_get_deployment_status",
            "Get the status of an EdgeOne Pages deployment; pass projectId to skip a project search. " +
                "Requires EDGEONE_API_TOKEN.",
            {
                deploymentId: z
                    .string()
                    .min(1)
                    .describe("Deployment id from edgeone_deploy_pages"),
                projectId: z
                    .string()
                    .optional()
                    .describe("Project id from edgeone_deploy_pages"),
            },
            toolHandler((params) => eoGetDeploymentStatus(params)),
        ],
        [
            "edgeone_get_logs",
            "Get logs for an EdgeOne Pages deployment. The EdgeOne pages-api has no per-deployment " +
                "logs action, so this returns the deployment status with an explicit empty-log note. " +
                "Requires EDGEONE_API_TOKEN.",
            {
                deploymentId: z
                    .string()
                    .min(1)
                    .describe("Deployment id from edgeone_deploy_pages"),
                projectId: z
                    .string()
                    .optional()
                    .describe("Project id from edgeone_deploy_pages"),
            },
            toolHandler((params) => eoGetLogs(params)),
        ],
    ];
}

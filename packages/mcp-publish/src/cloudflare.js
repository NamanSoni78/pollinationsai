/**
 * Cloudflare Pages + Workers deployment via the documented Cloudflare API v4.
 *
 * All request/response shapes follow the official Cloudflare OpenAPI spec
 * (https://developers.cloudflare.com/api/, source:
 * https://github.com/cloudflare/api-schemas blob main/openapi.yaml) and the
 * flow used by wrangler itself (https://github.com/cloudflare/workers-sdk,
 * packages/wrangler/src/pages/upload.ts + src/api/pages/deploy.ts):
 *
 *   1. GET  /accounts/{aid}/pages/projects/{project}           (project exists?)
 *   2. POST /accounts/{aid}/pages/projects                     {name, production_branch}
 *   3. GET  /accounts/{aid}/pages/projects/{project}/upload-token -> {result:{jwt}}
 *   4. POST /pages/assets/check-missing  {hashes}              (Bearer jwt)
 *   5. POST /pages/assets/upload         [KV bulk-write shape]  (Bearer jwt)
 *   6. POST /pages/assets/upsert-hashes  {hashes}               (best effort)
 *   7. POST /accounts/{aid}/pages/projects/{project}/deployments
 *      multipart/form-data: `manifest` part (application/json, maps
 *      "/<path>" -> content hash) + optional `branch` field.
 *
 * Workers scripts upload (worker-script-upload-worker-module):
 *   PUT /accounts/{aid}/workers/scripts/{script_name} multipart with a JSON
 *   `metadata` part ({main_module, compatibility_date, bindings}) plus one
 *   part per module (application/javascript+module), then
 *   GET /accounts/{aid}/workers/subdomain to build the workers.dev URL.
 *
 * Env vars (pages-project-update-project): PATCH
 *   /accounts/{aid}/pages/projects/{project} with
 *   {deployment_configs: {production|preview: {env_vars: {KEY: {type, value}}}}}.
 *
 * Logs (pages-deployment-get-deployment-logs): GET
 *   /accounts/{aid}/pages/projects/{project}/deployments/{id}/history/logs.
 */

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { verifyDeployment } from "./verify.js";

const DEFAULT_API_BASE = "https://api.cloudflare.com/client/v4";

const MIME_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".htm": "text/html; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json",
    ".mjs": "text/javascript; charset=utf-8",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".xml": "application/xml",
};

/**
 * Collect deployable files under `directory` (recursively, POSIX-style
 * relative paths). Dotfiles, dot-directories and node_modules are skipped.
 * Shared with the EdgeOne module (file list fixed by the work order).
 *
 * @returns {Promise<Array<{path: string, absolute: string, contentType: string}>>}
 */
export async function collectFiles(directory) {
    const files = [];
    const walk = async (dir) => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") {
                continue;
            }
            const absolute = join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
            } else if (entry.isFile()) {
                const extension = entry.name
                    .slice(entry.name.lastIndexOf("."))
                    .toLowerCase();
                files.push({
                    path: relative(directory, absolute).split("\\").join("/"),
                    absolute,
                    contentType:
                        MIME_TYPES[extension] ?? "application/octet-stream",
                });
            }
        }
    };
    await walk(directory);
    return files.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Content hash used as the asset-store key. The asset store takes the hash
 * as an opaque key (KV bulk-write shape), so any stable digest works; md5
 * hex keeps the documented 32-hex format.
 * unverified: wrangler hashes with blake3(base64+ext).slice(0,32)
 * (workers-sdk packages/workers-utils/src/asset-hash.ts); md5 is accepted
 * per the Agent Ground work order because the key is opaque.
 */
function contentHash(buffer) {
    return createHash("md5").update(buffer).digest("hex");
}

/**
 * Resolve Cloudflare credentials. Explicit options win over env vars.
 * Returns `{configured:false, env, hint}` when a credential is missing —
 * the caller must return that instead of attempting any network call.
 */
function resolveConfig({ token, accountId, apiBase }) {
    const resolvedToken = token ?? process.env.CLOUDFLARE_API_TOKEN;
    if (!resolvedToken) {
        return {
            configured: false,
            env: "CLOUDFLARE_API_TOKEN",
            hint: "set CLOUDFLARE_API_TOKEN in the environment",
        };
    }
    const resolvedAccountId = accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!resolvedAccountId) {
        return {
            configured: false,
            env: "CLOUDFLARE_ACCOUNT_ID",
            hint: "set CLOUDFLARE_ACCOUNT_ID in the environment",
        };
    }
    return {
        configured: true,
        token: resolvedToken,
        accountId: resolvedAccountId,
        apiBase: (
            apiBase ??
            process.env.CLOUDFLARE_API_BASE ??
            DEFAULT_API_BASE
        ).replace(/\/+$/, ""),
    };
}

/**
 * Call the Cloudflare API and unwrap the `{success, errors, result}` envelope.
 * Throws on transport failure and on `success:false` responses.
 */
async function cfApi(apiBase, path, token, init = {}) {
    const response = await fetch(`${apiBase}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(init.body && !(init.body instanceof FormData)
                ? { "Content-Type": "application/json" }
                : {}),
            ...init.headers,
        },
    });
    let payload = null;
    try {
        payload = await response.json();
    } catch {
        // fall through: non-JSON error responses are handled below
    }
    if (!response.ok || !payload?.success) {
        const first = payload?.errors?.[0];
        throw new Error(
            `Cloudflare API ${init.method ?? "GET"} ${path} failed: HTTP ${response.status}` +
                (first ? ` ${first.code} ${first.message}` : ""),
        );
    }
    return payload.result;
}

async function ensureProject(cfg, project, branch) {
    try {
        return await cfApi(
            cfg.apiBase,
            `/accounts/${cfg.accountId}/pages/projects/${encodeURIComponent(project)}`,
            cfg.token,
        );
    } catch {
        // Not found (or transient failure): create it, mirroring wrangler.
    }
    try {
        return await cfApi(
            cfg.apiBase,
            `/accounts/${cfg.accountId}/pages/projects`,
            cfg.token,
            {
                method: "POST",
                body: JSON.stringify({
                    name: project,
                    production_branch: branch ?? "main",
                }),
            },
        );
    } catch (error) {
        // Lost a race with a concurrent creator: reuse the existing project.
        try {
            return await cfApi(
                cfg.apiBase,
                `/accounts/${cfg.accountId}/pages/projects/${encodeURIComponent(project)}`,
                cfg.token,
            );
        } catch {
            throw error;
        }
    }
}

/**
 * Deploy a directory of static assets to Cloudflare Pages via Direct Upload.
 *
 * @param {{apiBase?: string, token?: string, accountId?: string, project: string,
 *     directory: string, branch?: string, verify?: (url: string) => Promise<object>}} options
 *     `verify` overrides verifyDeployment (test seam).
 * @returns {Promise<{url: string, id: string, project: string, files: number,
 *     verification: object} | {configured: false, env: string, hint: string}>}
 */
export async function deployPages(options) {
    const cfg = resolveConfig(options);
    if (!cfg.configured) {
        return cfg;
    }
    const { project, directory, branch } = options;
    const files = await collectFiles(directory);
    if (files.length === 0) {
        throw new Error(`No deployable files found in ${directory}`);
    }

    await ensureProject(cfg, project, branch);

    // Short-lived JWT for the Pages asset store (upload-token endpoint).
    const { jwt } = await cfApi(
        cfg.apiBase,
        `/accounts/${cfg.accountId}/pages/projects/${encodeURIComponent(project)}/upload-token`,
        cfg.token,
    );

    const entries = [];
    const manifest = {};
    for (const file of files) {
        const content = await readFile(file.absolute);
        const hash = contentHash(content);
        entries.push({ hash, content, contentType: file.contentType });
        manifest[`/${file.path}`] = hash;
    }

    // Which hashes are missing from the asset store?
    const missing = await cfApi(
        cfg.apiBase,
        "/pages/assets/check-missing",
        jwt,
        {
            method: "POST",
            headers: { Authorization: `Bearer ${jwt}` },
            body: JSON.stringify({
                hashes: entries.map((entry) => entry.hash),
            }),
        },
    );
    const toUpload = entries.filter((entry) => missing.includes(entry.hash));

    // KV bulk-write shape: {key, value(base64), metadata.contentType, base64}.
    if (toUpload.length > 0) {
        await cfApi(cfg.apiBase, "/pages/assets/upload", jwt, {
            method: "POST",
            headers: { Authorization: `Bearer ${jwt}` },
            body: JSON.stringify(
                toUpload.map((entry) => ({
                    key: entry.hash,
                    value: entry.content.toString("base64"),
                    metadata: { contentType: entry.contentType },
                    base64: true,
                })),
            ),
        });
    }

    // Best-effort cache hint; wrangler treats failure as non-fatal too.
    try {
        await cfApi(cfg.apiBase, "/pages/assets/upsert-hashes", jwt, {
            method: "POST",
            headers: { Authorization: `Bearer ${jwt}` },
            body: JSON.stringify({
                hashes: entries.map((entry) => entry.hash),
            }),
        });
    } catch {
        // ignored
    }

    const form = new FormData();
    // Manifest keys carry a leading "/" like wrangler does (openapi.yaml's
    // example shows keys without it — both appear in the wild, wrangler is
    // the reference client).
    form.append(
        "manifest",
        new Blob([JSON.stringify(manifest)], { type: "application/json" }),
    );
    if (branch) {
        form.append("branch", branch);
    }
    const deployment = await cfApi(
        cfg.apiBase,
        `/accounts/${cfg.accountId}/pages/projects/${encodeURIComponent(project)}/deployments`,
        cfg.token,
        { method: "POST", body: form },
    );

    const verify = options.verify ?? verifyDeployment;
    return {
        url: deployment.url,
        id: deployment.id,
        project,
        files: files.length,
        verification: await verify(deployment.url),
    };
}

/**
 * Upload a Worker script (ES modules) to Cloudflare Workers.
 *
 * @param {{apiBase?: string, token?: string, accountId?: string, name: string,
 *     directory: string, main?: string, verify?: (url: string) => Promise<object>}} options
 * @returns {Promise<{url: string|null, id: string, name: string,
 *     verification: object} | {configured: false, env: string, hint: string}>}
 */
export async function deployWorker(options) {
    const cfg = resolveConfig(options);
    if (!cfg.configured) {
        return cfg;
    }
    const { name, directory, main } = options;
    const modules = (await collectFiles(directory)).filter(
        (file) => file.path.endsWith(".js") || file.path.endsWith(".mjs"),
    );
    if (modules.length === 0) {
        throw new Error(`No .js/.mjs modules found in ${directory}`);
    }
    const mainModule =
        main ??
        ["index.js", "main.js", "worker.js", "src/index.js"].find((candidate) =>
            modules.some((file) => file.path === candidate),
        );
    if (!mainModule || !modules.some((file) => file.path === mainModule)) {
        throw new Error(
            `Main module not found; pass main= as one of: ${modules.map((file) => file.path).join(", ")}`,
        );
    }

    const form = new FormData();
    form.append(
        "metadata",
        new Blob(
            [
                JSON.stringify({
                    main_module: mainModule,
                    compatibility_date: new Date().toISOString().slice(0, 10),
                    bindings: [],
                }),
            ],
            { type: "application/json" },
        ),
    );
    for (const module of modules) {
        form.append(
            module.path,
            new Blob([await readFile(module.absolute)], {
                type: "application/javascript+module",
            }),
        );
    }
    const script = await cfApi(
        cfg.apiBase,
        `/accounts/${cfg.accountId}/workers/scripts/${encodeURIComponent(name)}`,
        cfg.token,
        { method: "PUT", body: form },
    );

    // workers.dev URL from the account subdomain (workers-subdomain-get-subdomain).
    let url = null;
    try {
        const { subdomain } = await cfApi(
            cfg.apiBase,
            `/accounts/${cfg.accountId}/workers/subdomain`,
            cfg.token,
        );
        if (subdomain) {
            url = `https://${name}.${subdomain}.workers.dev`;
        }
    } catch {
        // No workers.dev subdomain: the upload still succeeded.
    }

    const verify = options.verify ?? verifyDeployment;
    return {
        url,
        id: script.id ?? name,
        name,
        verification: url
            ? await verify(url)
            : {
                  ok: false,
                  status: "error",
                  checkedAt: new Date().toISOString(),
                  error: "no workers.dev subdomain",
              },
    };
}

/**
 * Set a Pages environment variable (plaintext) via the project PATCH endpoint.
 *
 * @param {{apiBase?: string, token?: string, accountId?: string, project: string,
 *     key: string, value: string, env?: "production"|"preview"}} options
 * @returns {Promise<{updated: boolean, project: string, key: string, env: string,
 *     productionBranch?: string} | {configured: false, env: string, hint: string}>}
 */
export async function setEnvVar(options) {
    const cfg = resolveConfig(options);
    if (!cfg.configured) {
        return cfg;
    }
    const { project, key, value, env = "production" } = options;
    if (env !== "production" && env !== "preview") {
        throw new Error(`env must be "production" or "preview", got ${env}`);
    }
    const result = await cfApi(
        cfg.apiBase,
        `/accounts/${cfg.accountId}/pages/projects/${encodeURIComponent(project)}`,
        cfg.token,
        {
            method: "PATCH",
            body: JSON.stringify({
                deployment_configs: {
                    [env]: {
                        env_vars: { [key]: { type: "plain_text", value } },
                    },
                },
            }),
        },
    );
    return {
        updated: true,
        project: result?.name ?? project,
        key,
        env,
        ...(result?.production_branch
            ? { productionBranch: result.production_branch }
            : {}),
    };
}

/**
 * Fetch build logs for a Pages deployment.
 *
 * @param {{apiBase?: string, token?: string, accountId?: string, project: string,
 *     deploymentId: string}} options
 * @returns {Promise<{deploymentId: string, total: number, includesContainerLogs: boolean,
 *     logs: Array<{line: string, ts: string}>} | {configured: false, env: string, hint: string}>}
 */
export async function getDeploymentLogs(options) {
    const cfg = resolveConfig(options);
    if (!cfg.configured) {
        return cfg;
    }
    const { project, deploymentId } = options;
    const result = await cfApi(
        cfg.apiBase,
        `/accounts/${cfg.accountId}/pages/projects/${encodeURIComponent(project)}` +
            `/deployments/${encodeURIComponent(deploymentId)}/history/logs`,
        cfg.token,
    );
    return {
        deploymentId,
        total: result?.total ?? 0,
        includesContainerLogs: result?.includes_container_logs ?? false,
        logs: Array.isArray(result?.data) ? result.data : [],
    };
}

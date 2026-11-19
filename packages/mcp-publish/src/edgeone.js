/**
 * EdgeOne Pages deployment via the documented pages-api (token based).
 *
 * API surface verified from the official Tencent EdgeOne MCP package
 * `edgeone-pages-mcp` 0.0.16 (https://www.npmjs.com/package/edgeone-pages-mcp,
 * dist/tools/deploy_folder_or_zip.js) and mirrored by `@edgeone/makers-mcp`.
 * Everything is a POST to the API base with an `Action` field in the JSON
 * body and `Authorization: Bearer <token>`:
 *
 *   base: https://pages-api.edgeone.ai/v1 (international, default)
 *         https://pages-api.cloud.tencent.com/v1 (China, set EDGEONE_API_BASE)
 *   token: https://edgeone.ai/document/177158578324279296 (API Token page)
 *
 * Deploy flow (deploy_folder_or_zip.js):
 *   DescribePagesProjects -> CreatePagesProject -> DescribePagesCosTempToken
 *   -> upload files to Tencent COS (XML API, signed with the temp
 *   credentials, https://cloud.tencent.com/document/product/436/7778)
 *   -> CreatePagesDeployment -> poll DescribePagesDeployments until Status
 *   != "Process" -> DescribePagesEncipherToken for the preview URL.
 *
 * There is no documented per-deployment logs action; getLogs returns the
 * deployment status plus an honest empty log list (never fabricated).
 */

import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { collectFiles } from "./cloudflare.js";
import { verifyDeployment } from "./verify.js";

const DEFAULT_API_BASE = "https://pages-api.edgeone.ai/v1";
const CHINA_API_BASE = "https://pages-api.cloud.tencent.com/v1";

/**
 * Resolve EdgeOne credentials. Token is required for directory deploys (the
 * documented tokenless flow only covers single-HTML previews).
 */
function resolveConfig({ token, apiBase }) {
    const resolvedToken = token ?? process.env.EDGEONE_API_TOKEN;
    if (!resolvedToken) {
        return {
            configured: false,
            env: "EDGEONE_API_TOKEN",
            hint: "set EDGEONE_API_TOKEN in the environment",
        };
    }
    return {
        configured: true,
        token: resolvedToken,
        apiBase: (
            apiBase ??
            process.env.EDGEONE_API_BASE ??
            DEFAULT_API_BASE
        ).replace(/\/+$/, ""),
    };
}

/** POST one Action to the pages-api and validate the response envelope. */
async function eoAction(apiBase, token, payload) {
    const response = await fetch(apiBase, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        throw new Error(
            `EdgeOne API ${payload.Action} failed: HTTP ${response.status}`,
        );
    }
    const body = await response.json();
    if (body.Code !== 0) {
        throw new Error(
            `EdgeOne API ${payload.Action} failed: ${body.Code} ${body.Message ?? ""}`.trim(),
        );
    }
    const data = body.Data?.Response;
    if (data?.Error) {
        throw new Error(
            `EdgeOne API ${payload.Action} failed: ${data.Error.Message ?? "unknown error"}`,
        );
    }
    return data ?? {};
}

/**
 * Tencent COS XML API request signature, following the official
 * cos-nodejs-sdk-v5 util.getAuth implementation (which cites
 * https://cloud.tencent.com/document/product/436/7778).
 */
function camSafeUrlEncode(value) {
    return encodeURIComponent(String(value))
        .replace(/!/g, "%21")
        .replace(/'/g, "%27")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/\*/g, "%2A");
}

function cosAuthorization({
    secretId,
    secretKey,
    sessionToken,
    method,
    host,
    pathname,
    contentType,
}) {
    const now = Math.floor(Date.now() / 1000) - 1;
    const expires = now + 600;
    const keyTime = `${now};${expires}`;
    // Signed headers: host, content-type and x-cos-security-token (the SDK
    // signs exactly the x-cos-* + standard headers it sends).
    const signedHeaders = {
        "content-type": contentType,
        host,
        "x-cos-security-token": sessionToken,
    };
    const headerKeys = Object.keys(signedHeaders).sort();
    const headerList = headerKeys.join(";");
    const headerString = headerKeys
        .map(
            (key) =>
                `${camSafeUrlEncode(key)}=${camSafeUrlEncode(signedHeaders[key])}`,
        )
        .join("&");
    const formatString = [
        method.toLowerCase(),
        pathname,
        "",
        headerString,
        "",
    ].join("\n");
    const signKey = createHmac("sha1", secretKey).update(keyTime).digest("hex");
    const stringToSign = [
        "sha1",
        keyTime,
        createHash("sha1").update(formatString).digest("hex"),
        "",
    ].join("\n");
    const signature = createHmac("sha1", signKey)
        .update(stringToSign)
        .digest("hex");
    return [
        "q-sign-algorithm=sha1",
        `q-ak=${secretId}`,
        `q-sign-time=${keyTime}`,
        `q-key-time=${keyTime}`,
        `q-header-list=${headerList}`,
        "q-url-param-list=",
        `q-signature=${signature}`,
    ].join("&");
}

/**
 * PUT one object into the EdgeOne upload bucket.
 * Default endpoint per COS XML API: https://{bucket}.cos.{region}.myqcloud.com/{key}.
 * EDGEONE_COS_BASE / opts.cosBase override the base for offline tests.
 */
async function cosPutObject({
    bucket,
    region,
    key,
    content,
    contentType,
    credentials,
    cosBase,
}) {
    const encodedKey = key.split("/").map(camSafeUrlEncode).join("/");
    const base =
        cosBase ??
        process.env.EDGEONE_COS_BASE ??
        `https://${bucket}.cos.${region}.myqcloud.com`;
    const url = new URL(`${base.replace(/\/+$/, "")}/${encodedKey}`);
    const authorization = cosAuthorization({
        secretId: credentials.TmpSecretId,
        secretKey: credentials.TmpSecretKey,
        sessionToken: credentials.Token,
        method: "PUT",
        host: url.host,
        pathname: url.pathname,
        contentType,
    });
    const response = await fetch(url, {
        method: "PUT",
        headers: {
            "Content-Type": contentType,
            "x-cos-security-token": credentials.Token,
            Authorization: authorization,
        },
        body: content,
    });
    if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
            `COS upload of ${key} failed: HTTP ${response.status} ${detail.slice(0, 200)}`,
        );
    }
}

async function findDeployment(apiBase, token, projectId, deploymentId) {
    const data = await eoAction(apiBase, token, {
        Action: "DescribePagesDeployments",
        ProjectId: projectId,
        Offset: 0,
        Limit: 50,
        OrderBy: "CreatedOn",
        Order: "Desc",
    });
    return (
        (data.Deployments ?? []).find(
            (deployment) => deployment.DeploymentId === deploymentId,
        ) ?? null
    );
}

/**
 * Deploy a directory of static files to EdgeOne Pages.
 *
 * @param {{apiBase?: string, token?: string, project: string, directory: string,
 *     env?: "Production"|"Preview", cosBase?: string, pollIntervalMs?: number,
 *     maxPolls?: number, verify?: (url: string) => Promise<object>}} options
 *     cosBase/pollIntervalMs/maxPolls/verify are test seams; defaults follow
 *     the official package (5s poll).
 * @returns {Promise<{url: string, id: string, project: string, projectId: string,
 *     status: string, verification: object} | {configured: false, env: string, hint: string}>}
 */
export async function deployPages(options) {
    const cfg = resolveConfig(options);
    if (!cfg.configured) {
        return cfg;
    }
    const {
        project,
        directory,
        env = "Production",
        cosBase,
        pollIntervalMs = 5000,
        maxPolls = 60,
    } = options;
    const files = await collectFiles(directory);
    if (files.length === 0) {
        throw new Error(`No deployable files found in ${directory}`);
    }

    // Get or create the project (DescribePagesProjects / CreatePagesProject).
    const listed =
        (
            await eoAction(cfg.apiBase, cfg.token, {
                Action: "DescribePagesProjects",
                Filters: [{ Name: "Name", Values: [project] }],
                Offset: 0,
                Limit: 10,
                OrderBy: "CreatedOn",
            })
        ).Projects ?? [];
    let projectId = listed[0]?.ProjectId;
    if (!projectId) {
        projectId = (
            await eoAction(cfg.apiBase, cfg.token, {
                Action: "CreatePagesProject",
                Name: project,
                Provider: "Upload",
                Source: "mcp",
                Channel: "Custom",
                Area: "global",
            })
        ).ProjectId;
        if (!projectId) {
            throw new Error(
                `EdgeOne project creation for ${project} returned no ProjectId`,
            );
        }
    }

    // Temporary COS credentials for the upload bucket.
    const tokenData = await eoAction(cfg.apiBase, cfg.token, {
        Action: "DescribePagesCosTempToken",
        ProjectId: projectId,
    });
    const { Bucket, Region, TargetPath, Credentials } = tokenData;
    if (!Bucket || !Region || !TargetPath || !Credentials?.TmpSecretId) {
        throw new Error(
            "DescribePagesCosTempToken returned incomplete upload credentials",
        );
    }
    for (const file of files) {
        await cosPutObject({
            bucket: Bucket,
            region: Region,
            key: `${TargetPath}/${file.path}`,
            content: await readFile(file.absolute),
            contentType: file.contentType,
            credentials: Credentials,
            cosBase,
        });
    }

    const deploymentId = (
        await eoAction(cfg.apiBase, cfg.token, {
            Action: "CreatePagesDeployment",
            ProjectId: projectId,
            ViaMeta: "Upload",
            Provider: "Upload",
            Env: env,
            DistType: "Folder",
            TempBucketPath: TargetPath,
        })
    ).DeploymentId;
    if (!deploymentId) {
        throw new Error("CreatePagesDeployment returned no DeploymentId");
    }

    // Poll until the deployment leaves the "Process" state.
    let deployment = null;
    for (let attempt = 0; attempt <= maxPolls; attempt++) {
        deployment = await findDeployment(
            cfg.apiBase,
            cfg.token,
            projectId,
            deploymentId,
        );
        if (!deployment) {
            throw new Error(
                `Deployment ${deploymentId} not found in project ${projectId}`,
            );
        }
        if (deployment.Status !== "Process") {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    if (deployment.Status !== "Success") {
        throw new Error(
            `EdgeOne deployment failed with status: ${deployment.Status}`,
        );
    }

    // Build the live URL (custom domain, or preview domain + access token).
    const projectData = (
        await eoAction(cfg.apiBase, cfg.token, {
            Action: "DescribePagesProjects",
            Filters: [{ Name: "ProjectId", Values: [projectId] }],
            Offset: 0,
            Limit: 10,
            OrderBy: "CreatedOn",
        })
    ).Projects?.[0];
    let url;
    const customDomain =
        env === "Production" &&
        projectData?.CustomDomains?.find((domain) => domain.Status === "Pass");
    if (customDomain) {
        url = `https://${customDomain.Domain}`;
    } else {
        const domain = deployment.PreviewUrl
            ? deployment.PreviewUrl.replace(/^https?:\/\//, "")
            : projectData?.PresetDomain;
        if (!domain) {
            throw new Error("Deployment succeeded but no domain was returned");
        }
        const encipher = await eoAction(cfg.apiBase, cfg.token, {
            Action: "DescribePagesEncipherToken",
            Text: domain,
        });
        if (!encipher.Token || !encipher.Timestamp) {
            throw new Error(
                "DescribePagesEncipherToken returned no access token",
            );
        }
        url = `https://${domain}?eo_token=${encipher.Token}&eo_time=${encipher.Timestamp}`;
    }

    const verify = options.verify ?? verifyDeployment;
    return {
        url,
        id: deploymentId,
        project: projectData?.Name ?? project,
        projectId,
        status: deployment.Status,
        verification: await verify(url),
    };
}

/** Look up a deployment, optionally searching projects when projectId is omitted. */
async function locateDeployment(apiBase, token, deploymentId, projectId) {
    if (projectId) {
        const deployment = await findDeployment(
            apiBase,
            token,
            projectId,
            deploymentId,
        );
        return deployment ? { projectId, deployment } : null;
    }
    const projects =
        (
            await eoAction(apiBase, token, {
                Action: "DescribePagesProjects",
                Offset: 0,
                Limit: 50,
                OrderBy: "CreatedOn",
            })
        ).Projects ?? [];
    for (const project of projects) {
        const deployment = await findDeployment(
            apiBase,
            token,
            project.ProjectId,
            deploymentId,
        );
        if (deployment) {
            return { projectId: project.ProjectId, deployment };
        }
    }
    return null;
}

/**
 * Get the status of an EdgeOne Pages deployment.
 *
 * @param {{apiBase?: string, token?: string, deploymentId: string,
 *     projectId?: string}} options
 * @returns {Promise<{found: boolean, deploymentId: string, projectId?: string,
 *     status?: string, deployment?: object} | {configured: false, env: string, hint: string}>}
 */
export async function getDeploymentStatus(options) {
    const cfg = resolveConfig(options);
    if (!cfg.configured) {
        return cfg;
    }
    const { deploymentId, projectId } = options;
    const located = await locateDeployment(
        cfg.apiBase,
        cfg.token,
        deploymentId,
        projectId,
    );
    if (!located) {
        return {
            found: false,
            deploymentId,
            ...(projectId ? { projectId } : {}),
        };
    }
    return {
        found: true,
        deploymentId,
        projectId: located.projectId,
        status: located.deployment.Status,
        deployment: located.deployment,
    };
}

/**
 * Get logs for an EdgeOne Pages deployment. The documented pages-api has no
 * per-deployment logs action, so this returns the deployment status with an
 * honest empty log list instead of fabricating entries.
 *
 * @param {{apiBase?: string, token?: string, deploymentId: string,
 *     projectId?: string}} options
 * @returns {Promise<{deploymentId: string, projectId?: string, status: string,
 *     logs: never[], note: string} | {configured: false, env: string, hint: string}>}
 */
export async function getLogs(options) {
    const status = await getDeploymentStatus(options);
    if (status.configured === false || !status.found) {
        return status;
    }
    return {
        deploymentId: status.deploymentId,
        projectId: status.projectId,
        status: status.status,
        logs: [],
        note:
            "EdgeOne pages-api exposes no per-deployment logs action; documented actions are " +
            "DescribePagesProjects, CreatePagesProject, DescribePagesCosTempToken, CreatePagesDeployment, " +
            "DescribePagesDeployments, DescribePagesEncipherToken " +
            "(source: edgeone-pages-mcp 0.0.16, https://www.npmjs.com/package/edgeone-pages-mcp)",
    };
}

export {
    CHINA_API_BASE as EDGEONE_API_BASE_CHINA,
    DEFAULT_API_BASE as EDGEONE_API_BASE_DEFAULT,
};

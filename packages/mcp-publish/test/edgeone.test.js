import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { deployPages, getDeploymentStatus, getLogs } from "../src/edgeone.js";

const TOKEN = "eo_test_token";
const PROJECT_ID = "eo-proj-1";
const COS = {
    secretId: "eo_cos_id",
    secretKey: "eo_cos_secret",
    sessionToken: "eo_cos_session",
    bucket: "eo-bucket-1250000000",
    region: "ap-guangzhou",
    targetPath: "temp/upload-1",
};

/** Same camSafeUrlEncode as cos-nodejs-sdk-v5 (product/436/7778). */
function camSafeUrlEncode(value) {
    return encodeURIComponent(String(value))
        .replace(/!/g, "%21")
        .replace(/'/g, "%27")
        .replace(/\(/g, "%28")
        .replace(/\)/g, "%29")
        .replace(/\*/g, "%2A");
}

/**
 * Independent re-implementation of the COS signature algorithm (from the
 * official SDK) used to verify the Authorization header our code sends.
 */
function expectedCosSignature({
    method,
    pathname,
    host,
    contentType,
    authorization,
}) {
    const params = {};
    for (const pair of authorization.split("&")) {
        const idx = pair.indexOf("=");
        params[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    const keyTime = params["q-sign-time"];
    const headers = {
        "content-type": contentType,
        host,
        "x-cos-security-token": COS.sessionToken,
    };
    const headerKeys = Object.keys(headers).sort();
    const headerString = headerKeys
        .map(
            (key) =>
                `${camSafeUrlEncode(key)}=${camSafeUrlEncode(headers[key])}`,
        )
        .join("&");
    const formatString = [
        method.toLowerCase(),
        pathname,
        "",
        headerString,
        "",
    ].join("\n");
    const signKey = createHmac("sha1", COS.secretKey)
        .update(keyTime)
        .digest("hex");
    const stringToSign = [
        "sha1",
        keyTime,
        createHash("sha1").update(formatString).digest("hex"),
        "",
    ].join("\n");
    return {
        params,
        signature: createHmac("sha1", signKey)
            .update(stringToSign)
            .digest("hex"),
        headerKeys,
    };
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

describe("edgeone publish tools (stub pages-api + COS)", () => {
    let server;
    let port;
    const apiRequests = [];
    const cosUploads = [];
    const projects = new Map();
    // "Process" right after CreatePagesDeployment; flips to "Success" on the
    // next status poll (exercises the poll loop) and stays "Success" for
    // plain status lookups in other tests.
    let deploymentStatus = "Success";
    const envBackup = {};
    const ENV_VARS = [
        "EDGEONE_API_TOKEN",
        "EDGEONE_API_BASE",
        "EDGEONE_COS_BASE",
    ];

    const base = () => `http://127.0.0.1:${port}`;

    async function makeSite(files) {
        const dir = await mkdtemp(join(tmpdir(), "mcp-publish-eo-"));
        for (const [path, content] of Object.entries(files)) {
            await mkdir(join(dir, path, ".."), { recursive: true });
            await writeFile(join(dir, path), content);
        }
        return dir;
    }

    before(async () => {
        for (const name of ENV_VARS) envBackup[name] = process.env[name];
        process.env.EDGEONE_API_TOKEN = TOKEN;

        server = http.createServer(async (req, res) => {
            const body = await readBody(req);
            const url = new URL(req.url, base());
            const json = (req.headers["content-type"] ?? "").includes(
                "application/json",
            )
                ? JSON.parse(body.toString() || "{}")
                : null;

            if (req.method === "GET" && url.pathname === "/eo-site") {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("edgeone deployed!");
                return;
            }

            if (req.method === "PUT" && url.pathname.startsWith("/cos/")) {
                const expected = expectedCosSignature({
                    method: "PUT",
                    pathname: url.pathname,
                    host: req.headers.host,
                    contentType: req.headers["content-type"],
                    authorization: req.headers.authorization,
                });
                cosUploads.push({
                    path: url.pathname,
                    securityToken: req.headers["x-cos-security-token"],
                    contentType: req.headers["content-type"],
                    body: body.toString(),
                    authParams: expected.params,
                    authValid:
                        expected.params["q-signature"] === expected.signature,
                    headerList: expected.headerKeys.join(";"),
                });
                res.writeHead(200);
                res.end();
                return;
            }

            if (req.method === "POST" && url.pathname === "/v1") {
                apiRequests.push({
                    action: json.Action,
                    body: json,
                    authorization: req.headers.authorization,
                });
                const send = (response) => {
                    res.writeHead(200, { "Content-Type": "application/json" });
                    res.end(
                        JSON.stringify({
                            Code: 0,
                            Message: "ok",
                            Data: { Response: response },
                        }),
                    );
                };
                const filterValues = (name) =>
                    (json.Filters ?? []).find((filter) => filter.Name === name)
                        ?.Values ?? [];
                switch (json.Action) {
                    case "DescribePagesProjects": {
                        let list = [...projects.values()];
                        const byName = filterValues("Name");
                        const byId = filterValues("ProjectId");
                        if (byName.length > 0)
                            list = list.filter((p) => byName.includes(p.Name));
                        if (byId.length > 0)
                            list = list.filter((p) =>
                                byId.includes(p.ProjectId),
                            );
                        send({ Projects: list, TotalCount: list.length });
                        return;
                    }
                    case "CreatePagesProject": {
                        const project = {
                            ProjectId: PROJECT_ID,
                            Name: json.Name,
                            PresetDomain: `${json.Name}.edgeone.app`,
                            CustomDomains: [],
                        };
                        projects.set(json.Name, project);
                        send({ ProjectId: project.ProjectId });
                        return;
                    }
                    case "DescribePagesCosTempToken":
                        send({
                            Bucket: COS.bucket,
                            Region: COS.region,
                            TargetPath: COS.targetPath,
                            Credentials: {
                                TmpSecretId: COS.secretId,
                                TmpSecretKey: COS.secretKey,
                                Token: COS.sessionToken,
                            },
                        });
                        return;
                    case "CreatePagesDeployment":
                        deploymentStatus = "Process";
                        send({ DeploymentId: "eo-dep-1" });
                        return;
                    case "DescribePagesDeployments": {
                        const status = deploymentStatus;
                        if (deploymentStatus === "Process") {
                            deploymentStatus = "Success";
                        }
                        send({
                            Deployments: [
                                {
                                    DeploymentId: "eo-dep-1",
                                    Status: status,
                                    PreviewUrl: `${base()}/eo-site`,
                                },
                            ],
                        });
                        return;
                    }
                    case "DescribePagesEncipherToken":
                        send({
                            Token: "eo-preview-access",
                            Timestamp: "1730000000",
                        });
                        return;
                    default:
                        res.writeHead(500);
                        res.end(
                            JSON.stringify({
                                Code: -1,
                                Message: `unhandled action ${json.Action}`,
                            }),
                        );
                }
                return;
            }

            res.writeHead(404);
            res.end();
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = server.address().port;
        process.env.EDGEONE_API_BASE = `${base()}/v1`;
        process.env.EDGEONE_COS_BASE = `${base()}/cos`;
    });

    after(async () => {
        for (const name of ENV_VARS) {
            if (envBackup[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = envBackup[name];
            }
        }
        server.close();
    });

    beforeEach(() => {
        apiRequests.length = 0;
        cosUploads.length = 0;
        deploymentStatus = "Success";
    });

    it("deployPages creates the project, COS-uploads files, deploys, polls, and builds the URL", async () => {
        const directory = await makeSite({
            "index.html": "<h1>edgeone</h1>",
            "assets/app.js": "console.log(2)",
            ".hidden": "skipped",
            "node_modules/skip.js": "skipped",
        });
        const checked = [];
        const result = await deployPages({
            project: "eo-demo",
            directory,
            pollIntervalMs: 5,
            verify: async (url) => {
                checked.push(url);
                return {
                    ok: true,
                    status: 200,
                    checkedAt: new Date().toISOString(),
                };
            },
        });

        // API flow order (official deploy_folder_or_zip.js sequence).
        const actions = apiRequests.map((r) => r.action);
        assert.deepEqual(actions, [
            "DescribePagesProjects",
            "CreatePagesProject",
            "DescribePagesCosTempToken",
            "CreatePagesDeployment",
            "DescribePagesDeployments",
            "DescribePagesDeployments",
            "DescribePagesProjects",
            "DescribePagesEncipherToken",
        ]);
        for (const request of apiRequests) {
            assert.equal(request.authorization, `Bearer ${TOKEN}`);
        }
        assert.deepEqual(apiRequests[0].body.Filters, [
            { Name: "Name", Values: ["eo-demo"] },
        ]);
        assert.deepEqual(
            {
                Name: apiRequests[1].body.Name,
                Provider: apiRequests[1].body.Provider,
                Area: apiRequests[1].body.Area,
            },
            { Name: "eo-demo", Provider: "Upload", Area: "global" },
        );
        assert.equal(apiRequests[3].body.DistType, "Folder");
        assert.equal(apiRequests[3].body.TempBucketPath, COS.targetPath);
        assert.equal(apiRequests[3].body.ProjectId, PROJECT_ID);

        // COS uploads: signed PUTs keyed by TargetPath/<relative path>.
        assert.equal(cosUploads.length, 2);
        const indexUpload = cosUploads.find(
            (u) => u.path === `/cos/${COS.targetPath}/index.html`,
        );
        const assetUpload = cosUploads.find(
            (u) => u.path === `/cos/${COS.targetPath}/assets/app.js`,
        );
        assert.ok(indexUpload && assetUpload, "per-path COS uploads");
        assert.equal(indexUpload.body, "<h1>edgeone</h1>");
        assert.equal(indexUpload.contentType, "text/html; charset=utf-8");
        assert.equal(indexUpload.securityToken, COS.sessionToken);
        assert.equal(
            indexUpload.authParams["q-header-list"],
            "content-type;host;x-cos-security-token",
        );
        assert.equal(indexUpload.authParams["q-ak"], COS.secretId);
        assert.equal(
            indexUpload.authValid,
            true,
            "COS Authorization matches the SDK signature algorithm",
        );
        assert.equal(assetUpload.authValid, true);
        assert.ok(
            !cosUploads.some(
                (u) =>
                    u.path.includes("node_modules") ||
                    u.path.includes(".hidden"),
            ),
        );

        // Result + injected verification of the preview URL (token + eo_time).
        assert.equal(result.id, "eo-dep-1");
        assert.equal(result.projectId, PROJECT_ID);
        assert.equal(result.status, "Success");
        assert.equal(
            result.url,
            `https://127.0.0.1:${port}/eo-site?eo_token=eo-preview-access&eo_time=1730000000`,
        );
        assert.deepEqual(checked, [result.url]);
        assert.equal(result.verification.ok, true);
        assert.ok(
            !JSON.stringify(result).includes(TOKEN),
            "API token never appears in the result",
        );

        await rm(directory, { recursive: true, force: true });
    });

    it("deployPages prefers a passing custom domain in Production", async () => {
        projects.set("eo-custom", {
            ProjectId: "eo-proj-2",
            Name: "eo-custom",
            PresetDomain: "eo-custom.edgeone.app",
            CustomDomains: [{ Domain: "custom.example.com", Status: "Pass" }],
        });
        const directory = await makeSite({ "index.html": "<p>custom</p>" });
        const result = await deployPages({
            project: "eo-custom",
            directory,
            pollIntervalMs: 5,
            verify: async () => ({
                ok: true,
                status: 200,
                checkedAt: new Date().toISOString(),
            }),
        });
        assert.equal(result.url, "https://custom.example.com");
        assert.equal(result.projectId, "eo-proj-2");
        assert.equal(
            apiRequests.some((r) => r.action === "DescribePagesEncipherToken"),
            false,
            "no encipher token needed for a passing custom domain",
        );
        await rm(directory, { recursive: true, force: true });
    });

    it("getDeploymentStatus finds the deployment with and without projectId", async () => {
        projects.set("eo-demo", {
            ProjectId: PROJECT_ID,
            Name: "eo-demo",
            PresetDomain: "eo-demo.edgeone.app",
        });
        const withProject = await getDeploymentStatus({
            deploymentId: "eo-dep-1",
            projectId: PROJECT_ID,
        });
        assert.equal(withProject.found, true);
        assert.equal(withProject.status, "Success");
        assert.equal(withProject.projectId, PROJECT_ID);
        assert.equal(withProject.deploymentId, "eo-dep-1");

        const requestCountBeforeSearch = apiRequests.length;
        const searched = await getDeploymentStatus({
            deploymentId: "eo-dep-1",
        });
        assert.equal(searched.found, true);
        assert.equal(searched.projectId, PROJECT_ID);
        assert.equal(
            apiRequests[requestCountBeforeSearch].action,
            "DescribePagesProjects",
            "without projectId it lists projects first",
        );
        assert.ok(!JSON.stringify(withProject).includes(TOKEN));

        const missing = await getDeploymentStatus({
            deploymentId: "nope",
            projectId: PROJECT_ID,
        });
        assert.equal(missing.found, false);
    });

    it("getLogs is honest: real status lookup, empty logs with a note", async () => {
        const result = await getLogs({
            deploymentId: "eo-dep-1",
            projectId: PROJECT_ID,
        });
        assert.equal(result.status, "Success");
        assert.deepEqual(result.logs, []);
        assert.match(result.note, /no per-deployment logs action/);
        assert.match(result.note, /edgeone-pages-mcp/);
        assert.ok(!JSON.stringify(result).includes(TOKEN));
    });

    it("missing EDGEONE_API_TOKEN returns {configured:false} with zero network attempts", async () => {
        const directory = await makeSite({ "index.html": "<p>x</p>" });
        delete process.env.EDGEONE_API_TOKEN;
        for (const [label, call] of [
            [
                "deployPages",
                () => deployPages({ project: "eo-demo", directory }),
            ],
            [
                "getDeploymentStatus",
                () =>
                    getDeploymentStatus({
                        deploymentId: "eo-dep-1",
                        projectId: PROJECT_ID,
                    }),
            ],
            ["getLogs", () => getLogs({ deploymentId: "eo-dep-1" })],
        ]) {
            const result = await call();
            assert.deepEqual(
                Object.keys(result).sort(),
                ["configured", "env", "hint"],
                `${label} result shape`,
            );
            assert.equal(result.configured, false, label);
            assert.equal(result.env, "EDGEONE_API_TOKEN", label);
            assert.match(
                result.hint,
                /set EDGEONE_API_TOKEN in the environment/,
                label,
            );
            assert.ok(!JSON.stringify(result).includes(TOKEN), label);
        }
        assert.equal(apiRequests.length, 0, "no pages-api call was attempted");
        assert.equal(cosUploads.length, 0, "no COS upload was attempted");
        process.env.EDGEONE_API_TOKEN = TOKEN;
        await rm(directory, { recursive: true, force: true });
    });
});

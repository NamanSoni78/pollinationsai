import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
    deployPages,
    deployWorker,
    getDeploymentLogs,
    setEnvVar,
} from "../src/cloudflare.js";

const TOKEN = "cf_test_token";
const ACCOUNT_ID = "cf_test_account";

/** Minimal multipart/form-data parser (asserts what our code sends). */
function parseMultipart(buffer, contentType) {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? "");
    assert.ok(match, "request has a multipart boundary");
    const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
    const parts = [];
    let start = buffer.indexOf(boundary);
    while (start !== -1) {
        const next = buffer.indexOf(boundary, start + boundary.length);
        if (next === -1) break;
        let segment = buffer.subarray(start + boundary.length, next);
        if (segment.subarray(0, 2).toString() === "\r\n")
            segment = segment.subarray(2);
        if (segment.subarray(-2).toString() === "\r\n")
            segment = segment.subarray(0, -2);
        const headerEnd = segment.indexOf("\r\n\r\n");
        if (headerEnd !== -1) {
            const headerText = segment.subarray(0, headerEnd).toString("utf8");
            const headers = {};
            for (const line of headerText.split("\r\n")) {
                const idx = line.indexOf(":");
                if (idx > 0) {
                    headers[line.slice(0, idx).trim().toLowerCase()] = line
                        .slice(idx + 1)
                        .trim();
                }
            }
            const name = /name="([^"]*)"/.exec(
                headers["content-disposition"] ?? "",
            );
            parts.push({
                name: name?.[1] ?? null,
                contentType: headers["content-type"] ?? null,
                content: segment.subarray(headerEnd + 4),
            });
        }
        start = next;
    }
    return parts;
}

const md5 = (data) => createHash("md5").update(data).digest("hex");

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

describe("cloudflare publish tools (stub API)", () => {
    let server;
    let port;
    const requests = [];
    const createdProjects = new Set();
    const envBackup = {};
    const ENV_VARS = [
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID",
        "CLOUDFLARE_API_BASE",
    ];
    let tmpRoot;

    const base = () => `http://127.0.0.1:${port}`;

    async function makeSite(files) {
        const dir = await mkdtemp(join(tmpdir(), "mcp-publish-cf-"));
        for (const [path, content] of Object.entries(files)) {
            await mkdir(join(dir, path, ".."), { recursive: true });
            await writeFile(join(dir, path), content);
        }
        return dir;
    }

    before(async () => {
        for (const name of ENV_VARS) {
            envBackup[name] = process.env[name];
        }
        process.env.CLOUDFLARE_API_TOKEN = TOKEN;
        process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;

        server = http.createServer(async (req, res) => {
            const body = await readBody(req);
            const contentType = req.headers["content-type"] ?? "";
            const json = contentType.includes("application/json")
                ? JSON.parse(body.toString() || "{}")
                : null;
            requests.push({
                method: req.method,
                path: req.url,
                authorization: req.headers.authorization,
                contentType,
                body,
                json,
            });
            const send = (status, payload) => {
                res.writeHead(status, { "Content-Type": "application/json" });
                res.end(JSON.stringify(payload));
            };
            const url = new URL(req.url, base());
            const parts = url.pathname.split("/").filter(Boolean); // accounts/<aid>/pages/...

            if (req.method === "GET" && url.pathname === "/site") {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("deployed!");
                return;
            }
            if (url.pathname.startsWith("/pages/assets/")) {
                // Asset-store endpoints: Bearer <upload-token jwt>.
                if (url.pathname === "/pages/assets/check-missing") {
                    return send(200, { success: true, result: json.hashes });
                }
                return send(200, { success: true, errors: [], messages: [] });
            }
            if (parts[0] !== "accounts" || parts[1] !== ACCOUNT_ID) {
                return send(404, {
                    success: false,
                    errors: [{ code: 1, message: "bad account path" }],
                });
            }
            const tail = parts.slice(2).join("/"); // pages/projects/...
            if (req.method === "GET" && tail === "pages/projects/demo-site") {
                if (createdProjects.has("demo-site")) {
                    return send(200, {
                        success: true,
                        result: {
                            name: "demo-site",
                            subdomain: "demo-site.pages.dev",
                        },
                    });
                }
                return send(404, {
                    success: false,
                    errors: [
                        { code: 8000007, message: "Could not find project" },
                    ],
                });
            }
            if (req.method === "POST" && tail === "pages/projects") {
                createdProjects.add(json.name);
                return send(200, {
                    success: true,
                    result: {
                        name: json.name,
                        subdomain: `${json.name}.pages.dev`,
                    },
                });
            }
            if (
                req.method === "GET" &&
                tail === "pages/projects/demo-site/upload-token"
            ) {
                return send(200, {
                    success: true,
                    result: { jwt: "jwt_test_123" },
                });
            }
            if (
                req.method === "POST" &&
                tail === "pages/projects/demo-site/deployments"
            ) {
                return send(200, {
                    success: true,
                    result: {
                        id: "dep-123",
                        url: `${base()}/site`,
                        aliases: [`${base()}/site`],
                    },
                });
            }
            if (req.method === "PATCH" && tail === "pages/projects/demo-site") {
                return send(200, {
                    success: true,
                    result: { name: "demo-site", production_branch: "main" },
                });
            }
            if (
                req.method === "GET" &&
                tail ===
                    "pages/projects/demo-site/deployments/dep-123/history/logs"
            ) {
                return send(200, {
                    success: true,
                    result: {
                        data: [
                            {
                                line: "Cloning repository...",
                                ts: "2025-01-01T00:00:00.000Z",
                            },
                        ],
                        total: 1,
                        includes_container_logs: false,
                    },
                });
            }
            if (
                req.method === "PUT" &&
                tail === "workers/scripts/demo-worker"
            ) {
                return send(200, { success: true, result: { id: "script-1" } });
            }
            if (req.method === "GET" && tail === "workers/subdomain") {
                return send(200, {
                    success: true,
                    result: { subdomain: "test-sub" },
                });
            }
            return send(404, {
                success: false,
                errors: [
                    {
                        code: 0,
                        message: `unhandled ${req.method} ${url.pathname}`,
                    },
                ],
            });
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = server.address().port;
        process.env.CLOUDFLARE_API_BASE = base();
        tmpRoot = await mkdtemp(join(tmpdir(), "mcp-publish-cf-root-"));
    });

    after(async () => {
        for (const name of ENV_VARS) {
            if (envBackup[name] === undefined) {
                delete process.env[name];
            } else {
                process.env[name] = envBackup[name];
            }
        }
        await rm(tmpRoot, { recursive: true, force: true });
        server.close();
    });

    beforeEach(() => {
        requests.length = 0;
    });

    it("deployPages creates the project, uploads assets, and posts a manifest deployment", async () => {
        const directory = await makeSite({
            "index.html": "<h1>hello</h1>",
            "assets/app.js": "console.log(1)",
            ".hidden.txt": "skipped",
            "node_modules/skip.js": "skipped",
        });

        const result = await deployPages({
            project: "demo-site",
            directory,
            branch: "main",
        });

        // Create-then-deploy: GET (404) then POST project creation.
        const create = requests.find(
            (r) => r.method === "POST" && r.path.endsWith("/pages/projects"),
        );
        assert.ok(create, "project creation was attempted after GET 404");
        assert.deepEqual(
            {
                name: create.json.name,
                production_branch: create.json.production_branch,
            },
            { name: "demo-site", production_branch: "main" },
        );
        assert.equal(create.authorization, `Bearer ${TOKEN}`);

        // Asset upload: KV bulk-write payload keyed by content hash.
        const upload = requests.find((r) => r.path === "/pages/assets/upload");
        assert.ok(upload, "assets were uploaded");
        assert.equal(upload.authorization, "Bearer jwt_test_123");
        const expected = [
            {
                path: "index.html",
                content: "<h1>hello</h1>",
                type: "text/html; charset=utf-8",
            },
            {
                path: "assets/app.js",
                content: "console.log(1)",
                type: "text/javascript; charset=utf-8",
            },
        ];
        assert.equal(upload.json.length, 2);
        for (const entry of expected) {
            const payload = upload.json.find(
                (item) => item.key === md5(entry.content),
            );
            assert.ok(payload, `hash of ${entry.path} is an upload key`);
            assert.equal(
                payload.value,
                Buffer.from(entry.content).toString("base64"),
            );
            assert.deepEqual(payload.metadata, { contentType: entry.type });
            assert.equal(payload.base64, true);
        }

        // Deployment multipart: manifest (application/json) + branch field.
        const deployment = requests.find(
            (r) => r.method === "POST" && r.path.endsWith("/deployments"),
        );
        assert.ok(deployment, "deployment was created");
        assert.equal(deployment.authorization, `Bearer ${TOKEN}`);
        const manifestPart = parseMultipart(
            deployment.body,
            deployment.contentType,
        ).find((part) => part.name === "manifest");
        assert.ok(manifestPart, "manifest part present");
        assert.equal(manifestPart.contentType, "application/json");
        assert.deepEqual(JSON.parse(manifestPart.content.toString()), {
            "/index.html": md5("<h1>hello</h1>"),
            "/assets/app.js": md5("console.log(1)"),
        });
        const branchPart = parseMultipart(
            deployment.body,
            deployment.contentType,
        ).find((part) => part.name === "branch");
        assert.equal(branchPart?.content.toString(), "main");

        // Result + automatic verification against the returned URL.
        assert.equal(result.url, `${base()}/site`);
        assert.equal(result.id, "dep-123");
        assert.equal(result.project, "demo-site");
        assert.equal(result.files, 2);
        assert.deepEqual(result.verification, {
            ok: true,
            status: 200,
            checkedAt: result.verification.checkedAt,
        });
        assert.ok(
            !JSON.stringify(result).includes(TOKEN),
            "token never appears in the result",
        );

        await rm(directory, { recursive: true, force: true });
    });

    it("deployPages reuses an existing project without creating it", async () => {
        createdProjects.add("demo-site");
        const directory = await makeSite({ "index.html": "<p>again</p>" });
        const result = await deployPages({ project: "demo-site", directory });

        assert.equal(
            requests.some(
                (r) =>
                    r.method === "POST" && r.path.endsWith("/pages/projects"),
            ),
            false,
            "no create call when the project exists",
        );
        assert.equal(result.id, "dep-123");
        await rm(directory, { recursive: true, force: true });
    });

    it("deployWorker PUTs metadata + ES module parts and builds the workers.dev URL", async () => {
        const directory = await makeSite({
            "index.js": "export default { fetch() {} };",
            "helper.js": "export const x = 1;",
        });
        const checked = [];
        const result = await deployWorker({
            name: "demo-worker",
            directory,
            verify: async (url) => {
                checked.push(url);
                return {
                    ok: true,
                    status: 200,
                    checkedAt: new Date().toISOString(),
                };
            },
        });

        const upload = requests.find(
            (r) =>
                r.method === "PUT" &&
                r.path.endsWith("/workers/scripts/demo-worker"),
        );
        assert.ok(upload, "script upload via PUT");
        assert.equal(upload.authorization, `Bearer ${TOKEN}`);
        const parts = parseMultipart(upload.body, upload.contentType);
        const metadata = parts.find((part) => part.name === "metadata");
        assert.ok(metadata, "metadata part present");
        assert.equal(metadata.contentType, "application/json");
        const metadataJson = JSON.parse(metadata.content.toString());
        assert.equal(metadataJson.main_module, "index.js");
        assert.match(metadataJson.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
        assert.deepEqual(metadataJson.bindings, []);
        const modulePart = (name) => parts.find((part) => part.name === name);
        assert.equal(
            modulePart("index.js")?.contentType,
            "application/javascript+module",
        );
        assert.equal(
            modulePart("index.js")?.content.toString(),
            "export default { fetch() {} };",
        );
        assert.equal(
            modulePart("helper.js")?.contentType,
            "application/javascript+module",
        );
        assert.equal(
            modulePart("helper.js")?.content.toString(),
            "export const x = 1;",
        );

        assert.deepEqual(checked, ["https://demo-worker.test-sub.workers.dev"]);
        assert.equal(result.url, "https://demo-worker.test-sub.workers.dev");
        assert.equal(result.id, "script-1");
        assert.equal(result.verification.ok, true);
        assert.ok(!JSON.stringify(result).includes(TOKEN));

        await rm(directory, { recursive: true, force: true });
    });

    it("setEnvVar PATCHes deployment_configs env_vars (plain_text)", async () => {
        const result = await setEnvVar({
            project: "demo-site",
            key: "API_KEY",
            value: "v1",
        });

        const patch = requests.find(
            (r) =>
                r.method === "PATCH" &&
                r.path.endsWith("/pages/projects/demo-site"),
        );
        assert.ok(patch, "PATCH request sent");
        assert.equal(patch.authorization, `Bearer ${TOKEN}`);
        assert.deepEqual(patch.json, {
            deployment_configs: {
                production: {
                    env_vars: { API_KEY: { type: "plain_text", value: "v1" } },
                },
            },
        });
        assert.equal(result.updated, true);
        assert.equal(result.env, "production");
        assert.ok(!JSON.stringify(result).includes(TOKEN));

        await setEnvVar({
            project: "demo-site",
            key: "OTHER",
            value: "v2",
            env: "preview",
        });
        const previewPatch = requests
            .filter((r) => r.method === "PATCH")
            .at(-1);
        assert.deepEqual(Object.keys(previewPatch.json.deployment_configs), [
            "preview",
        ]);
    });

    it("getDeploymentLogs returns the documented log shape", async () => {
        const result = await getDeploymentLogs({
            project: "demo-site",
            deploymentId: "dep-123",
        });
        const logs = requests.find((r) =>
            r.path.endsWith("/deployments/dep-123/history/logs"),
        );
        assert.ok(logs, "logs endpoint called");
        assert.equal(logs.authorization, `Bearer ${TOKEN}`);
        assert.equal(result.total, 1);
        assert.equal(result.includesContainerLogs, false);
        assert.deepEqual(result.logs, [
            { line: "Cloning repository...", ts: "2025-01-01T00:00:00.000Z" },
        ]);
        assert.ok(!JSON.stringify(result).includes(TOKEN));
    });

    it("missing credentials return {configured:false} with zero network attempts", async () => {
        const directory = await makeSite({ "index.html": "<p>x</p>" });
        delete process.env.CLOUDFLARE_API_TOKEN;

        for (const [label, call] of [
            [
                "deployPages",
                () => deployPages({ project: "demo-site", directory }),
            ],
            [
                "deployWorker",
                () => deployWorker({ name: "demo-worker", directory }),
            ],
            [
                "setEnvVar",
                () => setEnvVar({ project: "demo-site", key: "K", value: "V" }),
            ],
            [
                "getDeploymentLogs",
                () =>
                    getDeploymentLogs({
                        project: "demo-site",
                        deploymentId: "dep-123",
                    }),
            ],
        ]) {
            const result = await call();
            assert.deepEqual(
                Object.keys(result).sort(),
                ["configured", "env", "hint"],
                `${label} result shape`,
            );
            assert.equal(result.configured, false, label);
            assert.equal(result.env, "CLOUDFLARE_API_TOKEN", label);
            assert.match(
                result.hint,
                /set CLOUDFLARE_API_TOKEN in the environment/,
                label,
            );
            assert.ok(
                !JSON.stringify(result).includes(TOKEN),
                `${label} never echoes the token`,
            );
        }
        assert.equal(requests.length, 0, "no network call was attempted");

        process.env.CLOUDFLARE_API_TOKEN = TOKEN;
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
        const noAccount = await deployPages({
            project: "demo-site",
            directory,
        });
        assert.equal(noAccount.configured, false);
        assert.equal(noAccount.env, "CLOUDFLARE_ACCOUNT_ID");
        assert.match(
            noAccount.hint,
            /set CLOUDFLARE_ACCOUNT_ID in the environment/,
        );
        assert.equal(requests.length, 0, "still no network call");
        process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;

        await rm(directory, { recursive: true, force: true });
    });

    it("deployPages throws on a directory with no deployable files", async () => {
        const directory = await makeSite({ ".only-hidden": "x" });
        await assert.rejects(
            deployPages({ project: "demo-site", directory }),
            /No deployable files/,
        );
        await rm(directory, { recursive: true, force: true });
    });
});

import fs from "node:fs";
import path from "node:path";

const MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".woff2": "font/woff2",
};

const KNOWN_API_PATHS = new Set([
    "/api/session",
    "/api/auth",
    "/api/budget",
    "/api/budget/topup",
    "/api/agents",
    "/api/artifacts",
    "/api/ask",
    "/api/broadcast",
    "/api/close-loop",
    "/api/warden",
]);

function send(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(data),
    });
    res.end(data);
}

function sendError(res, err) {
    const status = err?.status ?? err?.statusCode ?? 500;
    const body = { error: err?.code ?? err?.message ?? "internal_error" };
    if (err?.message && err.message !== body.error) body.message = err.message;
    send(res, status, body);
}

function badRequest(message) {
    const err = new Error(message);
    err.status = 400;
    err.code = "invalid_input";
    return err;
}

function httpError(status, code) {
    const err = new Error(code);
    err.status = status;
    err.code = code;
    return err;
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        let settled = false;
        req.on("data", (chunk) => {
            data += chunk;
            if (data.length > 1000000 && !settled) {
                settled = true;
                reject(badRequest("request body too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            if (settled) return;
            if (data.trim() === "") return resolve({});
            try {
                resolve(JSON.parse(data));
            } catch {
                reject(badRequest("request body must be valid JSON"));
            }
        });
        req.on("error", (err) => {
            if (!settled) {
                settled = true;
                reject(err);
            }
        });
    });
}

function serveStatic(res, uiDir, pathname) {
    const relative =
        pathname === "/" ? "index.html" : pathname.slice("/static/".length);
    let decoded;
    try {
        decoded = decodeURIComponent(relative);
    } catch {
        send(res, 400, { error: "bad_path" });
        return;
    }
    const root = path.resolve(uiDir);
    const absolute = path.resolve(root, decoded);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
        send(res, 404, { error: "not_found" });
        return;
    }
    let stat;
    try {
        stat = fs.statSync(absolute);
    } catch {
        send(res, 404, { error: "not_found" });
        return;
    }
    if (!stat.isFile()) {
        send(res, 404, { error: "not_found" });
        return;
    }
    const body = fs.readFileSync(absolute);
    res.writeHead(200, {
        "Content-Type":
            MIME_TYPES[path.extname(absolute).toLowerCase()] ??
            "application/octet-stream",
        "Content-Length": body.length,
    });
    res.end(body);
}

/**
 * REST routing per master spec 3.2 + static file serving for `uiDir`.
 * Missing injections (budgetControl / closeLoop) surface as 503 not_configured.
 *
 * @param {{ground: object, uiDir?: string|null}} deps
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void} handler
 */
export function createRequestHandler({ ground, uiDir = null }) {
    async function handle(req, res, url) {
        const method = req.method ?? "GET";
        const { pathname } = url;

        if (pathname.startsWith("/api/")) {
            if (pathname === "/api/session" && method === "GET")
                return send(res, 200, ground.session());
            if (pathname === "/api/auth" && method === "POST") {
                const body = await readJsonBody(req);
                return send(res, 200, await ground.auth(body.apiKey));
            }
            if (pathname === "/api/budget" && method === "POST") {
                const body = await readJsonBody(req);
                if (
                    typeof body.maxPollen !== "number" ||
                    !Number.isFinite(body.maxPollen) ||
                    body.maxPollen < 0
                ) {
                    throw badRequest("maxPollen must be a non-negative number");
                }
                await ground.setBudget(body.maxPollen);
                return send(res, 200, {
                    ok: true,
                    budget: ground.budgetState(),
                });
            }
            if (pathname === "/api/budget/topup" && method === "POST") {
                const body = await readJsonBody(req);
                if (
                    typeof body.amount !== "number" ||
                    !Number.isFinite(body.amount) ||
                    body.amount <= 0
                ) {
                    throw badRequest("amount must be a positive number");
                }
                await ground.topUp(body.amount);
                return send(res, 200, {
                    ok: true,
                    budget: ground.budgetState(),
                });
            }
            if (pathname === "/api/agents" && method === "GET") {
                const filter = {};
                const status = url.searchParams.get("status");
                const role = url.searchParams.get("role");
                if (status) filter.status = status;
                if (role) filter.role = role;
                return send(res, 200, { agents: ground.listAgents(filter) });
            }
            if (pathname === "/api/agents" && method === "POST") {
                const body = await readJsonBody(req);
                return send(res, 201, ground.registerAgent(body));
            }
            if (pathname === "/api/artifacts" && method === "GET") {
                const key = url.searchParams.get("key");
                if (key === null)
                    return send(res, 200, { artifacts: ground.artifactsAll() });
                const versionParam = url.searchParams.get("version");
                let version;
                if (versionParam !== null) {
                    version = Number.parseInt(versionParam, 10);
                    if (!Number.isInteger(version))
                        throw badRequest("version must be an integer");
                }
                const artifact = ground.fetchArtifact(key, version);
                if (!artifact) throw httpError(404, "artifact_not_found");
                return send(res, 200, artifact);
            }
            if (pathname === "/api/ask" && method === "POST") {
                const body = await readJsonBody(req);
                const result = await ground.askAgent(body);
                return send(
                    res,
                    result.status === "unavailable" ? 409 : 200,
                    result,
                );
            }
            if (pathname === "/api/broadcast" && method === "POST") {
                const body = await readJsonBody(req);
                return send(res, 200, ground.broadcast(body));
            }
            if (pathname === "/api/close-loop" && method === "POST") {
                const body = await readJsonBody(req);
                const result = await ground.startCloseLoop(body.answers);
                return send(res, 200, {
                    started: true,
                    result: result ?? null,
                });
            }
            if (pathname === "/api/warden" && method === "GET") {
                return send(res, 200, { verdicts: ground.wardenVerdicts() });
            }
            throw KNOWN_API_PATHS.has(pathname)
                ? httpError(405, "method_not_allowed")
                : httpError(404, "not_found");
        }

        if (
            uiDir &&
            method === "GET" &&
            (pathname === "/" || pathname.startsWith("/static/"))
        ) {
            return serveStatic(res, uiDir, pathname);
        }
        throw httpError(404, "not_found");
    }

    return function handler(req, res) {
        let url;
        try {
            url = new URL(req.url ?? "/", "http://agent-ground.local");
        } catch {
            send(res, 400, { error: "bad_url" });
            return;
        }
        handle(req, res, url).catch((err) => {
            if (!res.headersSent) sendError(res, err);
            else res.destroy();
        });
    };
}

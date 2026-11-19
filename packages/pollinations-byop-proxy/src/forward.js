// HTTP forwarding to the Pollinations GEN upstream: path classification
// (metered vs unmetered), hop-by-hop header hygiene, buffered requests for
// proxy-internal calls, and a streaming pass-through for client traffic
// that tees the upstream bytes so responses can be costed without breaking
// streaming for the caller.

import http from "node:http";
import https from "node:https";

const METERED_PREFIXES = [
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/messages",
    "/v1/embeddings",
    "/text",
    "/image",
    "/audio",
    "/video",
    "/realtime",
];

const HOP_BY_HOP = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
]);

/** Strip the query string so prefix matching only sees the path. */
export function pathOnly(url) {
    const query = url.indexOf("?");
    return query === -1 ? url : url.slice(0, query);
}

/** `/account/*` and `/v1/models` are free and never budget-blocked. */
export function isUnmeteredPath(url) {
    const path = pathOnly(url);
    return path === "/v1/models" || path.startsWith("/account/");
}

/** Paid generation paths, matched by exact path or prefix (spec globs). */
export function isMeteredPath(url) {
    const path = pathOnly(url);
    return METERED_PREFIXES.some(
        (prefix) => path === prefix || path.startsWith(prefix),
    );
}

/**
 * Copy request headers for upstream, dropping hop-by-hop headers. When
 * `authorization` is given it replaces whatever the caller sent (metered
 * paths get the BYOP key); otherwise the caller's credentials pass through.
 */
export function forwardHeaders(headers = {}, authorization) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        out[name] = value;
    }
    if (authorization !== undefined) out.authorization = authorization;
    return out;
}

/** Response headers safe to copy back to the client verbatim. */
export function responseHeaders(headers = {}) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase())) continue;
        out[name] = value;
    }
    return out;
}

function transportFor(protocol) {
    if (protocol === "https:") return https;
    if (protocol === "http:") return http;
    throw new Error(`Unsupported upstream protocol: ${protocol}`);
}

function openUpstream({ baseUrl, method, url, headers }) {
    const target = new URL(url, `${baseUrl}/`);
    return transportFor(target.protocol).request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        // One-shot sockets: no lingering keep-alive handles in test processes.
        agent: false,
    });
}

/** Buffer an IncomingMessage body into a single Buffer. */
export async function readRequestBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks);
}

/**
 * Buffered upstream request for proxy-internal calls (profile, balance,
 * models pricing). Resolves `{status, headers, body: Buffer}`.
 */
export function requestUpstream({
    baseUrl,
    method = "GET",
    url,
    headers = {},
    authorization,
    body = null,
}) {
    return new Promise((resolve, reject) => {
        let upstream;
        try {
            upstream = openUpstream({
                baseUrl,
                method,
                url,
                headers: forwardHeaders(headers, authorization),
            });
        } catch (err) {
            reject(err);
            return;
        }
        upstream.on("error", reject);
        upstream.on("response", (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("error", reject);
            res.on("end", () => {
                resolve({
                    status: res.statusCode ?? 502,
                    headers: res.headers,
                    body: Buffer.concat(chunks),
                });
            });
        });
        if (body) upstream.write(body);
        upstream.end();
    });
}

/**
 * Stream a client request through to the upstream and pipe the response
 * back while teeing the bytes for metering. `onBody(buffer, info)` runs
 * synchronously once the upstream body completes — before the client can
 * observe the completed response — and `info` is
 * `{status, headers, requestBody}`. Never rejects after headers were sent.
 */
export function pipeUpstream({ baseUrl, req, res, authorization, onBody }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        };
        res.on("error", () => {});
        req.on("error", fail);

        (async () => {
            const body = await readRequestBody(req);
            const upstream = openUpstream({
                baseUrl,
                method: req.method,
                url: req.url,
                headers: forwardHeaders(req.headers, authorization),
            });
            upstream.on("error", fail);
            upstream.on("response", (up) => {
                const chunks = [];
                res.writeHead(
                    up.statusCode ?? 502,
                    responseHeaders(up.headers),
                );
                up.on("data", (chunk) => {
                    chunks.push(chunk);
                    res.write(chunk);
                });
                up.on("error", fail);
                up.on("aborted", () =>
                    fail(new Error("upstream connection aborted")),
                );
                up.on("end", () => {
                    res.end();
                    const buffer = Buffer.concat(chunks);
                    if (onBody) {
                        try {
                            onBody(buffer, {
                                status: up.statusCode ?? 502,
                                headers: up.headers,
                                requestBody: body,
                            });
                        } catch {
                            // Metering must never break the forwarded response.
                        }
                    }
                    if (!settled) {
                        settled = true;
                        resolve({ status: up.statusCode ?? 502 });
                    }
                });
            });
            if (body.length > 0) upstream.write(body);
            upstream.end();
        })().catch(fail);
    });
}

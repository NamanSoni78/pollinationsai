import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import {
    isMeteredPath,
    isUnmeteredPath,
    pipeUpstream,
    requestUpstream,
} from "../src/forward.js";

async function startEchoUpstream(t) {
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            res.end(
                JSON.stringify({
                    method: req.method,
                    url: req.url,
                    authorization: req.headers.authorization ?? null,
                    contentType: req.headers["content-type"] ?? null,
                    body: Buffer.concat(chunks).toString("utf8"),
                }),
            );
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
        server.closeAllConnections?.();
        return new Promise((resolve) => server.close(resolve));
    });
    return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("path classification: unmetered account/models, metered generation globs", () => {
    for (const path of [
        "/account/profile",
        "/account/balance",
        "/v1/models",
        "/v1/models?x=1",
    ]) {
        assert.equal(isUnmeteredPath(path), true, path);
        assert.equal(isMeteredPath(path), false, path);
    }
    const metered = [
        "/v1/chat/completions",
        "/v1/responses",
        "/v1/messages",
        "/v1/embeddings",
        "/v1/chat/completions?stream=true",
        "/text",
        "/text?model=x",
        "/image/foo.png",
        "/audio",
        "/video/x",
        "/realtime",
    ];
    for (const path of metered) {
        assert.equal(isMeteredPath(path), true, path);
        assert.equal(isUnmeteredPath(path), false, path);
    }
    assert.equal(isMeteredPath("/v1/unknown"), false);
    assert.equal(isUnmeteredPath("/v1/unknown"), false);
});

test("requestUpstream round-trips method, path, headers and body", async (t) => {
    const upstream = await startEchoUpstream(t);
    const response = await requestUpstream({
        baseUrl: upstream.baseUrl,
        method: "POST",
        url: "/v1/chat/completions?x=1",
        headers: {
            "content-type": "application/json",
            authorization: "Bearer original",
        },
        authorization: "Bearer replaced",
        body: Buffer.from(JSON.stringify({ hello: "world" })),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body.toString("utf8")), {
        method: "POST",
        url: "/v1/chat/completions?x=1",
        authorization: "Bearer replaced",
        contentType: "application/json",
        body: JSON.stringify({ hello: "world" }),
    });

    const get = await requestUpstream({
        baseUrl: upstream.baseUrl,
        url: "/account/balance",
        authorization: "Bearer k",
    });
    assert.deepEqual(JSON.parse(get.body.toString("utf8")), {
        method: "GET",
        url: "/account/balance",
        authorization: "Bearer k",
        contentType: null,
        body: "",
    });
});

test("requestUpstream rejects when the upstream is unreachable", async () => {
    await assert.rejects(
        requestUpstream({ baseUrl: "http://127.0.0.1:1", url: "/v1/models" }),
    );
});

test("pipeUpstream streams the upstream response through to the client", async (t) => {
    const upstream = await startEchoUpstream(t);
    const seen = [];
    const gate = http.createServer((req, res) => {
        const override = req.headers["x-no-override"]
            ? undefined
            : "Bearer proxy-key";
        pipeUpstream({
            baseUrl: upstream.baseUrl,
            req,
            res,
            authorization: override,
            onBody: (buffer) => seen.push(buffer.toString("utf8")),
        }).catch(() => res.destroy());
    });
    gate.listen(0, "127.0.0.1");
    await once(gate, "listening");
    t.after(() => {
        gate.closeAllConnections?.();
        return new Promise((resolve) => gate.close(resolve));
    });
    const base = `http://127.0.0.1:${gate.address().port}`;

    const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ping: 1 }),
    });
    assert.equal(response.status, 200);
    const echoed = await response.json();
    assert.equal(echoed.method, "POST");
    assert.equal(echoed.url, "/v1/chat/completions");
    assert.equal(echoed.authorization, "Bearer proxy-key");
    assert.deepEqual(JSON.parse(echoed.body), { ping: 1 });
    assert.equal(seen.length, 1);
    assert.equal(JSON.parse(seen[0]).authorization, "Bearer proxy-key");

    // Without an override, the caller's own credentials pass through untouched.
    const passthrough = await fetch(`${base}/account/profile`, {
        headers: { authorization: "Bearer caller-token", "x-no-override": "1" },
    });
    assert.equal(passthrough.status, 200);
    const passed = await passthrough.json();
    assert.equal(passed.authorization, "Bearer caller-token");
    assert.equal(passed.method, "GET");
});

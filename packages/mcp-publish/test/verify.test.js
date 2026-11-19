import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";
import { verifyDeployment } from "../src/verify.js";

function startServer(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, "127.0.0.1", () =>
            resolve({ server, port: server.address().port }),
        );
    });
}

describe("verifyDeployment", () => {
    let server;
    let port;
    let closed;

    after(() => {
        if (!closed) server.close();
    });

    it("returns ok:true for 2xx responses", async () => {
        ({ server, port } = await startServer((req, res) => {
            if (req.url === "/ok") {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end("hello");
            } else if (req.url === "/no-content") {
                res.writeHead(204);
                res.end();
            } else if (req.url === "/teapot") {
                res.writeHead(418);
                res.end("teapot");
            } else if (req.url === "/boom") {
                res.writeHead(500);
                res.end("boom");
            } else {
                res.writeHead(404);
                res.end();
            }
        }));
        const ok = await verifyDeployment(`http://127.0.0.1:${port}/ok`);
        assert.equal(ok.ok, true);
        assert.equal(ok.status, 200);
        assert.ok(
            !Number.isNaN(Date.parse(ok.checkedAt)),
            "checkedAt is an ISO timestamp",
        );

        const noContent = await verifyDeployment(
            `http://127.0.0.1:${port}/no-content`,
        );
        assert.equal(noContent.ok, true);
        assert.equal(noContent.status, 204);
    });

    it("returns ok:false with the status for non-2xx responses", async () => {
        const teapot = await verifyDeployment(
            `http://127.0.0.1:${port}/teapot`,
        );
        assert.equal(teapot.ok, false);
        assert.equal(teapot.status, 418);

        const boom = await verifyDeployment(`http://127.0.0.1:${port}/boom`);
        assert.equal(boom.ok, false);
        assert.equal(boom.status, 500);

        const missing = await verifyDeployment(
            `http://127.0.0.1:${port}/missing`,
        );
        assert.equal(missing.ok, false);
        assert.equal(missing.status, 404);
    });

    it("returns ok:false with status 'error' when the request fails", async () => {
        // A port with nothing listening: connection refused, never a throw.
        const result = await verifyDeployment(
            "http://127.0.0.1:1/unreachable",
            { timeoutMs: 2000 },
        );
        assert.equal(result.ok, false);
        assert.equal(result.status, "error");
        assert.ok(typeof result.error === "string" && result.error.length > 0);
        assert.ok(!Number.isNaN(Date.parse(result.checkedAt)));
    });

    it("accepts an injected fetchImpl for offline use", async () => {
        const fetchImpl = async () => new Response("injected", { status: 201 });
        const result = await verifyDeployment("https://example.test/x", {
            fetchImpl,
        });
        assert.equal(result.ok, true);
        assert.equal(result.status, 201);
    });

    it("closes the stub server", () => {
        server.close();
        closed = true;
    });
});

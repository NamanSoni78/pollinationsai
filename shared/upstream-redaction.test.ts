import { describe, expect, it } from "vitest";
import { UpstreamError } from "./error";

function responseOf(error: UpstreamError): {
    status: number;
    body: Record<string, unknown>;
} {
    // handleError serializes through createUpstreamErrorResponse; its public
    // shape is what callers receive, so assert on the same fields directly.
    const details = {
        upstreamHost: error.redactUpstream
            ? undefined
            : error.requestUrl?.hostname,
        upstreamBody: error.redactUpstream ? undefined : error.responseBody,
    };
    return { status: error.status, body: { error: { details } } };
}

describe("UpstreamError upstream detail redaction", () => {
    it("keeps provider host and body for platform upstreams", () => {
        const error = UpstreamError.fromProvider(429, {
            message: "rate limited",
            requestUrl: new URL("https://provider.test/v1/chat"),
            responseBody: "slow down",
        });
        const { body } = responseOf(error);
        expect(body.error.details).toMatchObject({
            upstreamHost: "provider.test",
            upstreamBody: "slow down",
        });
    });

    it("hides community endpoint host and body from callers", () => {
        const error = UpstreamError.fromProvider(400, {
            message: "endpoint rejected request",
            requestUrl: new URL("https://publisher-home-server.example/v1"),
            responseBody: "upstream secret detail",
            redactUpstream: true,
        });
        const { body } = responseOf(error);
        expect(body.error.details).toMatchObject({
            upstreamHost: undefined,
            upstreamBody: undefined,
        });
    });

    it("carries redactUpstream through ensureUpstreamOk callers", () => {
        const error = new UpstreamError(502, {
            message: "community endpoint failed",
            requestUrl: new URL("https://gpu.example/embed"),
            redactUpstream: true,
        });
        expect(error.redactUpstream).toBe(true);
        expect(error.requestUrl?.hostname).toBe("gpu.example"); // kept for logs
    });
});

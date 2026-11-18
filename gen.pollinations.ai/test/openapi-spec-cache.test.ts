import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.ts";
import { buildMergedOpenApiSpec } from "../src/routes/docs.ts";

const enterSchema = {
    openapi: "3.1.0",
    info: { title: "Enter", version: "0.0.0" },
    paths: {},
    components: {},
};

/**
 * Minimal Context shape used by the schema builders: fetchEnterSchema reads
 * c.req.url / c.req.raw.headers and calls c.env.ENTER.fetch, fetchMediaSchema
 * reads c.env.ENVIRONMENT and uses global fetch.
 */
function fakeContext(enterFetch: (request: Request) => Promise<Response>) {
    const raw = new Request("https://gen.pollinations.ai/openapi.json");
    return {
        env: {
            ENVIRONMENT: "production",
            ENTER: { fetch: enterFetch },
        } as unknown as Env,
        req: { url: raw.url, raw },
    } as never;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("merged OpenAPI spec upstream caching", () => {
    it("fetches the enter and media halves once per TTL window", async () => {
        const enterFetch = vi.fn(async () => Response.json(enterSchema));
        const mediaFetch = vi.fn(async () =>
            Response.json({
                ...enterSchema,
                info: { title: "Media", version: "0.0.0" },
            }),
        );
        vi.spyOn(globalThis, "fetch").mockImplementation(
            async (input: RequestInfo | URL) => {
                const url = String(
                    input instanceof Request ? input.url : input,
                );
                if (url.includes("media.pollinations.ai")) {
                    return mediaFetch();
                }
                throw new Error(`unexpected fetch: ${url}`);
            },
        );
        const genApp = new Hono<Env>().get("/health", (c) => c.text("ok"));

        const first = await buildMergedOpenApiSpec(
            fakeContext(enterFetch),
            genApp,
        );
        const second = await buildMergedOpenApiSpec(
            fakeContext(enterFetch),
            genApp,
        );

        expect(enterFetch).toHaveBeenCalledTimes(1);
        expect(mediaFetch).toHaveBeenCalledTimes(1);
        expect(second).toEqual(first);
    });
});

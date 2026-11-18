import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Logger } from "@logtape/logtape";
import { ValidationError } from "@shared/http/validation-error.ts";
import { validator } from "@shared/middleware/validator.ts";
import { CreateImageRequestSchema } from "@shared/schemas/openai.ts";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "@/env.ts";
import {
    formatOpenAIImageResponse,
    prepareOpenAIImageGeneration,
} from "../../src/routes/images.ts";

const testLog = {
    getChild: () => testLog,
    debug() {},
    info() {},
    warn() {},
    error() {},
} as unknown as Logger;

// 24 MiB media (one byte over the cap when the body reads it whole) — proves
// the gate stops the arrayBuffer()/b64 conversion before the multiply.
const OVER_CAP = 24 * 1024 * 1024 + 1;
const UNDER_CAP = 1024 * 1024;

function mediaResponse(bytes: number, contentType: string): Response {
    const body = new Uint8Array(bytes).fill(65);
    return new Response(body, {
        headers: {
            "content-type": contentType,
            "content-length": String(bytes),
        },
    });
}

function b64App() {
    return new Hono<Env>()
        .use("*", async (c, next) => {
            c.set("model", {
                requested: "test-model",
                resolved: "test-model",
                definition: {} as Env["Variables"]["model"]["definition"],
            });
            await next();
        })
        .post(
            "/v1/images/generations",
            validator("json", CreateImageRequestSchema),
            formatOpenAIImageResponse,
            (c) => mediaResponse(OVER_CAP, "video/mp4"),
        );
}

describe("b64_json media byte cap", () => {
    it("rejects an over-cap video with 413 before the base64 conversion", async () => {
        const app = b64App();
        const res = await app.request("/v1/images/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "a clip" }),
        });
        expect(res.status).toBe(413);
        const text = await res.text();
        expect(text).toContain("b64_json");
    });

    it("declared content-length above the cap is rejected without reading the body", async () => {
        const app = b64App();
        const res = await app.request("/v1/images/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "a clip" }),
        });
        expect(res.status).toBe(413);
    });

    it("an under-cap image still inlines b64_json unchanged", async () => {
        const app = new Hono<Env>()
            .use("*", async (c, next) => {
                c.set("model", {
                    requested: "test-model",
                    resolved: "test-model",
                    definition: {} as Env["Variables"]["model"]["definition"],
                });
                await next();
            })
            .post(
                "/v1/images/generations",
                validator("json", CreateImageRequestSchema),
                formatOpenAIImageResponse,
                () => mediaResponse(UNDER_CAP, "image/png"),
            );
        const res = await app.request("/v1/images/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "a circle" }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            data?: Array<{ b64_json?: string }>;
        };
        expect(body.data?.[0]?.b64_json).toHaveLength(
            Math.floor((UNDER_CAP + 2) / 3) * 4,
        );
    });

    it("response_format url is untouched by the cap", async () => {
        const app = new Hono<Env>()
            .use("*", async (c, next) => {
                c.set("model", {
                    requested: "test-model",
                    resolved: "test-model",
                    definition: {} as Env["Variables"]["model"]["definition"],
                });
                await next();
            })
            .post(
                "/v1/images/generations",
                validator("json", CreateImageRequestSchema),
                formatOpenAIImageResponse,
                (c) =>
                    new Response(
                        new Uint8Array(UNDER_CAP).fill(65),
                        {
                            headers: {
                                "content-type": "video/mp4",
                                "Link": '<https://media.pollinations.ai/u/x/y.mp4>; rel="enclosure"',
                            },
                        },
                    ),
            );
        const res = await app.request("/v1/images/generations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                prompt: "a clip",
                response_format: "url",
            }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            data?: Array<{ url?: string }>;
        };
        expect(body.data?.[0]?.url).toContain("media.pollinations.ai");
    });
});

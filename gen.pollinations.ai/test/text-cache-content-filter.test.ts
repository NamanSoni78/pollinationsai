import {
    createExecutionContext,
    waitOnExecutionContext,
} from "cloudflare:test";
import type { Logger } from "@logtape/logtape";
import { validator } from "@shared/middleware/validator.ts";
import { CreateChatCompletionRequestSchema } from "@shared/schemas/openai.ts";
import { createTestR2Bucket } from "@shared/test/mocks/r2.ts";
import { Hono } from "hono";
import type { RequestIdVariables } from "hono/request-id";
import { describe, expect, it } from "vitest";
import type { LoggerVariables } from "@/middleware/logger.ts";
import type { ModelVariables } from "@/middleware/model.ts";
import { textCache } from "@/middleware/text-cache.ts";

type TestEnv = {
    Bindings: CloudflareBindings;
    Variables: LoggerVariables &
        ModelVariables &
        RequestIdVariables & { requestId: string };
};

const testLog = {
    getChild: () => testLog,
    debug() {},
    info() {},
    warn() {},
    error() {},
} as unknown as Logger;

function createTextCacheEnv(bucket = createTestR2Bucket()): CloudflareBindings {
    return {
        TEXT_BUCKET: bucket,
    } as unknown as CloudflareBindings;
}

async function dispatch(
    app: Hono<TestEnv>,
    path: string,
    init?: RequestInit,
    env = createTextCacheEnv(),
) {
    const ctx = createExecutionContext();
    const response = await app.fetch(
        new Request(`https://gen.pollinations.ai${path}`, init),
        env,
        ctx,
    );
    return { response, wait: () => waitOnExecutionContext(ctx) };
}

async function consumeAndWait(result: Awaited<ReturnType<typeof dispatch>>) {
    const text = await result.response.text();
    await result.wait();
    return text;
}

function chatInit(body: unknown): RequestInit {
    return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    };
}

const baseApp = (origin: () => Response) => {
    let originHits = 0;
    const app = new Hono<TestEnv>()
        .use("*", async (c, next) => {
            c.set("log", testLog);
            c.set("requestId", "test-request");
            await next();
        })
        .post(
            "/v1/chat/completions",
            validator("json", CreateChatCompletionRequestSchema),
            textCache,
            () => {
                originHits += 1;
                return origin();
            },
        )
        .get("/stream", textCache, () => {
            originHits += 1;
            return origin();
        });
    return {
        app,
        get originHits() {
            return originHits;
        },
    };
};

const chatBody = {
    model: "openai-fast",
    messages: [{ role: "user", content: "hi" }],
};

// Azure-style moderation refusal: 200, finish_reason=content_filter, and —
// because the filter trips before completion — no usage object.
const unbilledContentFilterCompletion = JSON.stringify({
    id: "chatcmpl-filtered",
    object: "chat.completion",
    created: 1,
    model: "provider/underlying",
    choices: [
        {
            index: 0,
            message: { role: "assistant", content: "" },
            finish_reason: "content_filter",
        },
    ],
});

// The same refusal with a usage object is a billed, delivered completion and
// must stay cacheable (mirrors the billing-side hasUsage rule).
const billedContentFilterCompletion = JSON.stringify({
    id: "chatcmpl-filtered-billed",
    object: "chat.completion",
    created: 1,
    model: "provider/underlying",
    choices: [
        {
            index: 0,
            message: { role: "assistant", content: "partial" },
            finish_reason: "content_filter",
        },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});

const okCompletion = JSON.stringify({
    id: "chatcmpl-ok",
    object: "chat.completion",
    created: 1,
    model: "provider/underlying",
    choices: [
        {
            index: 0,
            message: { role: "assistant", content: "full answer" },
            finish_reason: "stop",
        },
    ],
    // Usage is absent here on purpose: only the content_filter refusal is
    // gated when the body carries no usage; a normal stop completion without
    // usage stays cacheable.
});

describe("text cache content_filter refusal gate", () => {
    it("does not cache an unbilled JSON content_filter refusal", async () => {
        const harness = baseApp(
            () =>
                new Response(unbilledContentFilterCompletion, {
                    headers: { "Content-Type": "application/json" },
                }),
        );
        const env = createTextCacheEnv();
        const first = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(chatBody),
            env,
        );
        await consumeAndWait(first);
        const second = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(chatBody),
            env,
        );
        await consumeAndWait(second);
        expect(first.response.headers.get("X-Cache")).toBe("MISS");
        expect(second.response.headers.get("X-Cache")).toBe("MISS");
        expect(harness.originHits).toBe(2);
    });

    it("does not cache an unbilled SSE content_filter refusal", async () => {
        const sse = [
            '{"choices":[{"delta":{"role":"assistant","content":""}}]}',
            '{"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
            "[DONE]",
        ]
            .map((data) => `data: ${data}\n\n`)
            .join("");
        const harness = baseApp(
            () =>
                new Response(sse, {
                    headers: { "Content-Type": "text/event-stream" },
                }),
        );
        const env = createTextCacheEnv();
        const first = await dispatch(harness.app, "/stream", undefined, env);
        await consumeAndWait(first);
        const second = await dispatch(harness.app, "/stream", undefined, env);
        await consumeAndWait(second);
        expect(first.response.headers.get("X-Cache")).toBe("MISS");
        expect(second.response.headers.get("X-Cache")).toBe("MISS");
        expect(harness.originHits).toBe(2);
    });

    it("still caches a billed content_filter completion", async () => {
        const harness = baseApp(
            () =>
                new Response(billedContentFilterCompletion, {
                    headers: { "Content-Type": "application/json" },
                }),
        );
        const env = createTextCacheEnv();
        const first = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(chatBody),
            env,
        );
        await consumeAndWait(first);
        const second = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(chatBody),
            env,
        );
        await consumeAndWait(second);
        expect(first.response.headers.get("X-Cache")).toBe("MISS");
        expect(second.response.headers.get("X-Cache")).toBe("HIT");
        expect(harness.originHits).toBe(1);
    });

    it("still caches a refused SSE stream whose final chunk carries usage", async () => {
        // include_usage streams report the usage on a separate final frame:
        // the filtered completion is billable and stays cacheable.
        const sse = [
            '{"choices":[{"delta":{"role":"assistant","content":"partial"}}]}',
            '{"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
            '{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
            "[DONE]",
        ]
            .map((data) => `data: ${data}\n\n`)
            .join("");
        const harness = baseApp(
            () =>
                new Response(sse, {
                    headers: { "Content-Type": "text/event-stream" },
                }),
        );
        const env = createTextCacheEnv();
        const first = await dispatch(harness.app, "/stream", undefined, env);
        await consumeAndWait(first);
        const second = await dispatch(harness.app, "/stream", undefined, env);
        await consumeAndWait(second);
        expect(first.response.headers.get("X-Cache")).toBe("MISS");
        expect(second.response.headers.get("X-Cache")).toBe("HIT");
        expect(harness.originHits).toBe(1);
    });

    it("still caches normal completions without usage", async () => {
        const harness = baseApp(
            () =>
                new Response(okCompletion, {
                    headers: { "Content-Type": "application/json" },
                }),
        );
        const env = createTextCacheEnv();
        const first = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(chatBody),
            env,
        );
        await consumeAndWait(first);
        const second = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(chatBody),
            env,
        );
        await consumeAndWait(second);
        expect(first.response.headers.get("X-Cache")).toBe("MISS");
        expect(second.response.headers.get("X-Cache")).toBe("HIT");
        expect(harness.originHits).toBe(1);
    });
});

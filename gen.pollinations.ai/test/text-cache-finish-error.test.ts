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

const errorCompletion = JSON.stringify({
    id: "chatcmpl-error",
    object: "chat.completion",
    created: 1,
    model: "provider/underlying",
    choices: [
        {
            index: 0,
            message: { role: "assistant", content: "partial answer" },
            finish_reason: "error",
            error: { message: "Provider failed mid-generation" },
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
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
});

const failedResponsesBody = JSON.stringify({
    id: "resp_error",
    object: "response",
    status: "failed",
    error: { code: "provider_error", message: "Provider failed" },
});

const incompleteResponsesBody = JSON.stringify({
    id: "resp_incomplete",
    object: "response",
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [],
});

describe("text cache finish-reason error gate", () => {
    it("does not cache JSON completions that finish in error", async () => {
        const harness = baseApp(
            () =>
                new Response(errorCompletion, {
                    headers: { "Content-Type": "application/json" },
                }),
        );
        const env = createTextCacheEnv();
        const body = {
            model: "openai-fast",
            messages: [{ role: "user", content: "hi" }],
        };
        const first = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(body),
            env,
        );
        await consumeAndWait(first);
        const second = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(body),
            env,
        );
        await consumeAndWait(second);
        expect(first.response.headers.get("X-Cache")).toBe("MISS");
        expect(second.response.headers.get("X-Cache")).toBe("MISS");
        expect(harness.originHits).toBe(2);
    });

    it("does not cache SSE completions that finish in error", async () => {
        const sse = [
            '{"choices":[{"delta":{"role":"assistant","content":"partial"}}]}',
            '{"choices":[{"delta":{},"finish_reason":"error","error":{"message":"Provider failed"}}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
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

    it("does not cache Responses bodies that failed", async () => {
        const harness = baseApp(
            () =>
                new Response(failedResponsesBody, {
                    headers: { "Content-Type": "application/json" },
                }),
        );
        const env = createTextCacheEnv();
        const body = {
            model: "openai-fast",
            messages: [{ role: "user", content: "hi" }],
        };
        const first = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(body),
            env,
        );
        await consumeAndWait(first);
        const second = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(body),
            env,
        );
        await consumeAndWait(second);
        expect(first.response.headers.get("X-Cache")).toBe("MISS");
        expect(second.response.headers.get("X-Cache")).toBe("MISS");
        expect(harness.originHits).toBe(2);
    });

    it("still caches completions that finish normally", async () => {
        const harness = baseApp(
            () =>
                new Response(okCompletion, {
                    headers: { "Content-Type": "application/json" },
                }),
        );
        const env = createTextCacheEnv();
        const body = {
            model: "openai-fast",
            messages: [{ role: "user", content: "hi" }],
        };
        const first = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(body),
            env,
        );
        await consumeAndWait(first);
        const second = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(body),
            env,
        );
        await consumeAndWait(second);
        expect(first.response.headers.get("X-Cache")).toBe("MISS");
        expect(second.response.headers.get("X-Cache")).toBe("HIT");
        expect(harness.originHits).toBe(1);
    });

    it("still caches SSE completions that finish normally", async () => {
        const sse = [
            '{"choices":[{"delta":{"role":"assistant","content":"full"}}]}',
            '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
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

    it("still caches max_tokens-truncated Responses bodies", async () => {
        const harness = baseApp(
            () =>
                new Response(incompleteResponsesBody, {
                    headers: { "Content-Type": "application/json" },
                }),
        );
        const env = createTextCacheEnv();
        const body = {
            model: "openai-fast",
            messages: [{ role: "user", content: "hi" }],
        };
        const first = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(body),
            env,
        );
        await consumeAndWait(first);
        const second = await dispatch(
            harness.app,
            "/v1/chat/completions",
            chatInit(body),
            env,
        );
        await consumeAndWait(second);
        expect(first.response.headers.get("X-Cache")).toBe("MISS");
        expect(second.response.headers.get("X-Cache")).toBe("HIT");
        expect(harness.originHits).toBe(1);
    });
});

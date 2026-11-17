import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from "cloudflare:test";
import { createTestApiKey } from "@shared/test/fixtures/index.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateMessageRequestSchema } from "@/text/messages/schema.ts";
import { chatToMessagesStream } from "@/text/messages/stream.ts";
import { chatToMessagesResponse } from "@/text/messages/translate.ts";
import worker from "../../src/index.ts";
import { withInlineGenerationCoordinator } from "../helpers/inline-generation-coordinator.ts";

const model = "openai/gpt-5.4-nano";
const usage = { prompt_tokens: 15, completion_tokens: 30, total_tokens: 45 };

const encoder = new TextEncoder();

function sse(chunks: (object | string)[]) {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                const data =
                    typeof chunk === "string" ? chunk : JSON.stringify(chunk);
                controller.enqueue(encoder.encode(`data: ${data}\n\n`));
            }
            controller.close();
        },
    });
}

type AnthropicEvent = { type: string; [key: string]: unknown };

function parseEvents(text: string): AnthropicEvent[] {
    return text
        .split("\n\n")
        .filter((frame) => frame.trim())
        .map((frame) => {
            const [eventLine, dataLine] = frame.split("\n");
            const event = JSON.parse(dataLine.slice("data: ".length));
            expect(eventLine).toBe(`event: ${event.type}`);
            return event;
        });
}

async function translateStream(chunks: (object | string)[]) {
    const text = await new Response(
        chatToMessagesStream(sse(chunks), model),
    ).text();
    return parseEvents(text);
}

function errorCompletion() {
    return {
        id: "chatcmpl_error",
        object: "chat.completion",
        created: 1,
        choices: [
            {
                index: 0,
                finish_reason: "error",
                message: {
                    role: "assistant",
                    content: "partial answer",
                },
                error: { message: "Provider failed mid-generation" },
            },
        ],
        usage,
    };
}

describe("Messages finish_reason=error translation", () => {
    it("fails the stream instead of ending a normal turn", async () => {
        const events = await translateStream([
            { choices: [{ delta: { role: "assistant", content: "partial" } }] },
            {
                choices: [
                    {
                        delta: {},
                        finish_reason: "error",
                        error: { message: "Provider failed mid-generation" },
                    },
                ],
                usage,
            },
            "[DONE]",
        ]);
        const types = events.map((event) => event.type);
        expect(types).toContain("error");
        expect(types).not.toContain("message_stop");
        const errorEvent = events.find((event) => event.type === "error");
        expect(
            (errorEvent?.error as { message?: string } | undefined)?.message,
        ).toBe("Provider failed mid-generation");
    });

    it("still ends a normal turn with stop_reason end_turn", async () => {
        const events = await translateStream([
            { choices: [{ delta: { content: "full" } }] },
            { choices: [{ delta: {}, finish_reason: "stop" }], usage },
            "[DONE]",
        ]);
        const types = events.map((event) => event.type);
        expect(types).not.toContain("error");
        expect(types).toContain("message_stop");
        const delta = events.find(
            (event) => event.type === "message_delta",
        ) as { delta?: { stop_reason?: string } } | undefined;
        expect(delta?.delta?.stop_reason).toBe("end_turn");
    });

    it("rejects a non-stream error completion with a Messages error", () => {
        expect(() =>
            chatToMessagesResponse(
                // biome-ignore lint/suspicious/noExplicitAny: test fixture
                errorCompletion() as any,
                model,
            ),
        ).toThrow(/finish_reason=error|Provider failed/);
    });

    it("still translates a normal non-stream completion", () => {
        const message = chatToMessagesResponse(
            {
                id: "chatcmpl_ok",
                object: "chat.completion",
                created: 1,
                choices: [
                    {
                        index: 0,
                        finish_reason: "stop",
                        message: { role: "assistant", content: "full answer" },
                    },
                ],
                usage,
            },
            model,
        );
        expect(message.stop_reason).toBe("end_turn");
        expect(message.content).toEqual([
            { type: "text", text: "full answer" },
        ]);
    });

    describe("POST /v1/messages route", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        /** Mock the provider to return a 200 error completion. */
        function mockErrorUpstream() {
            vi.spyOn(globalThis, "fetch").mockImplementation(
                async (input, init) => {
                    const upstream = new Request(input, init);
                    if (new URL(upstream.url).pathname === "/v0/events") {
                        return Response.json({});
                    }
                    const body = (await upstream.json().catch(() => null)) as {
                        messages?: unknown;
                    } | null;
                    if (!body?.messages) return Response.json({ data: [] });
                    return Response.json(errorCompletion());
                },
            );
        }

        async function call(body: Record<string, unknown>, key: string) {
            const bindings = {
                ...withInlineGenerationCoordinator(env),
                TINYBIRD_INGEST_URL:
                    "https://tinybird.test/v0/events?name=generation_event_v2",
            };
            const ctx = createExecutionContext();
            const serialized = JSON.stringify(body);
            const response = await worker.fetch(
                new Request("https://gen.pollinations.ai/v1/messages", {
                    method: "POST",
                    headers: {
                        Authorization: `Bearer ${key}`,
                        "Content-Type": "application/json",
                        "Content-Length": String(
                            encoder.encode(serialized).length,
                        ),
                        "anthropic-version": "2023-06-01",
                    },
                    body: serialized,
                }),
                bindings,
                ctx,
            );
            const text = await response.text();
            await waitOnExecutionContext(ctx);
            return { response, text };
        }

        it("returns 502 when the upstream completion finishes in error", async () => {
            const caller = await createTestApiKey({
                user: { tierBalance: 100 },
            });
            mockErrorUpstream();
            const request = CreateMessageRequestSchema.parse({
                model,
                max_tokens: 256,
                messages: [{ role: "user", content: "hi" }],
            });
            const { response, text } = await call(request, caller.key);
            expect(response.status, text).toBe(502);
            // The shared response schema strips choice.error, so the route
            // reports the terminal failure itself.
            expect(text).toContain("finish_reason=error");
            expect(text).not.toContain('"stop_reason":"end_turn"');
            expect(text).not.toContain("partial answer");
        });
    });
});

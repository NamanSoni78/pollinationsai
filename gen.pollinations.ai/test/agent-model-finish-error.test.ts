import { generateText, streamText } from "ai";
import { describe, expect, it, vi } from "vitest";
import { createAgentModelProvider } from "@shared/agents/model.ts";

const errorCompletion = {
    id: "chatcmpl_error",
    object: "chat.completion",
    created: 1,
    model: "agent-test-model",
    choices: [
        {
            index: 0,
            message: { role: "assistant", content: "partial agent output" },
            finish_reason: "error",
            error: { message: "Provider failed mid-generation" },
        },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
};

const okCompletion = {
    id: "chatcmpl_ok",
    object: "chat.completion",
    created: 1,
    model: "agent-test-model",
    choices: [
        {
            index: 0,
            message: { role: "assistant", content: "full agent output" },
            finish_reason: "stop",
        },
    ],
    usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
};

function providerWith(body: object, stream = false) {
    const fetcher = vi.fn(async () =>
        stream
            ? new Response(
                  `data: ${JSON.stringify({
                      choices: [
                          {
                              delta: { role: "assistant", content: "partial" },
                          },
                      ],
                  })}\n\ndata: ${JSON.stringify({
                      choices: [
                          {
                              delta: {},
                              finish_reason: "error",
                              error: { message: "Provider failed mid-generation" },
                          },
                      ],
                      usage: errorCompletion.usage,
                  })}\n\ndata: [DONE]\n\n`,
                  { headers: { "content-type": "text/event-stream" } },
              )
            : Response.json(body),
    );
    const provider = createAgentModelProvider({
        baseURL: "https://gen.test/v1",
        fetch: fetcher as unknown as typeof fetch,
    });
    return { provider, fetcher };
}

describe("agent model rejects completions that finish in error", () => {
    it("rejects a non-streaming error completion instead of resolving", async () => {
        const { provider } = providerWith(errorCompletion);
        await expect(
            generateText({
                model: provider("agent-test-model"),
                prompt: "do the task",
            }),
        ).rejects.toThrow(
            /finish_reason=error|Provider failed mid-generation/,
        );
    });

    it("rejects a streaming error completion instead of resolving", async () => {
        const { provider } = providerWith(errorCompletion, true);
        const result = streamText({
            model: provider("agent-test-model"),
            prompt: "do the task",
        });
        await expect(
            async () => {
                for await (const _ of result.fullStream) {
                    // consume
                }
                await result.finishReason;
            },
        ).rejects.toThrow(
            /finish_reason=error|Provider failed mid-generation/,
        );
    });

    it("still resolves completions that finish normally", async () => {
        const { provider } = providerWith(okCompletion);
        const result = await generateText({
            model: provider("agent-test-model"),
            prompt: "do the task",
        });
        expect(result.text).toBe("full agent output");
    });
});

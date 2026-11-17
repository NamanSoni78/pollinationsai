import type { Logger } from "@logtape/logtape";
import type { CommunityEndpointRuntime } from "@shared/community-endpoints.ts";
import { MAX_COMMUNITY_TEXT_RESPONSE_BYTES } from "@shared/community-endpoints.ts";
import { readResponseText } from "@shared/response-bytes.ts";
import { encryptSecret } from "@shared/secret-encryption.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callCommunityTranscriptionEndpoint } from "../src/audio/communityEndpoint.ts";
import { generateCommunityEmbeddings } from "../src/embeddings/communityEndpoint.ts";
import { genericOpenAIClient } from "../src/text/genericOpenAIClient.ts";
import { callChatViaResponses } from "../src/text/responses/chatClient.ts";
import { createCaptureStream } from "../src/utils/text-cache.ts";

const SECRET = "test-better-auth-secret";
const mb = (n: number) => n * 1024 * 1024;

async function buildRuntime(
    baseUrl: string,
): Promise<CommunityEndpointRuntime> {
    return {
        id: "ep-caps",
        type: "proxy",
        ownerUserId: "user-1",
        modelId: "owner/model",
        name: "model",
        title: null,
        description: null,
        modality: "transcription",
        imagePricing: "request",
        inputModalities: ["text"],
        baseUrl,
        api: "chat_completions",
        upstreamModel: "upstream-model",
        visibility: "public",
        requiredSafetyFeatures: undefined,
        paidOnly: false,
        perUserRpm: null,
        fallbacks: [],
        bearerTokenCiphertext: await encryptSecret("upstream-bearer", SECRET),
    } as unknown as CommunityEndpointRuntime;
}

describe("community chat-completions leg (genericOpenAIClient)", () => {
    const bodyFor = (contentBytes: number) => {
        const content = "A".repeat(contentBytes);
        return JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "upstream-model",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content },
                    finish_reason: "stop",
                },
            ],
            usage: {
                prompt_tokens: 10,
                completion_tokens: 20,
                total_tokens: 30,
            },
        });
    };
    const jsonFetcher =
        (body: string, status = 200): typeof fetch =>
        async () =>
            new Response(body, {
                status,
                headers: { "content-type": "application/json" },
            });

    it("rejects an oversized community body instead of buffering it", async () => {
        await expect(
            genericOpenAIClient(
                [{ role: "user", content: "hello" }],
                {
                    model: "upstream-model",
                    modelConfig: { communityEndpoint: true },
                },
                {
                    endpoint: "https://community.example/v1/chat/completions",
                    fetcher: jsonFetcher(bodyFor(mb(9))),
                },
            ),
        ).rejects.toThrow(/too large/);
    });

    it("passes a community body under the cap", async () => {
        const completion = await genericOpenAIClient(
            [{ role: "user", content: "hello" }],
            {
                model: "upstream-model",
                modelConfig: { communityEndpoint: true },
            },
            {
                endpoint: "https://community.example/v1/chat/completions",
                fetcher: jsonFetcher(bodyFor(64 * 1024)),
            },
        );
        expect(completion.choices?.[0]?.message?.content).toHaveLength(64 * 1024);
    });

    it("caps the community error body too", async () => {
        await expect(
            genericOpenAIClient(
                [{ role: "user", content: "hello" }],
                {
                    model: "upstream-model",
                    modelConfig: { communityEndpoint: true },
                },
                {
                    endpoint: "https://community.example/v1/chat/completions",
                    fetcher: jsonFetcher("E".repeat(mb(9)), 500),
                },
            ),
        ).rejects.toThrow(/too large/);
    });

    it("keeps first-party legs uncapped (same code path, no marker)", async () => {
        const completion = await genericOpenAIClient(
            [{ role: "user", content: "hello" }],
            { model: "upstream-model" },
            {
                endpoint: "https://official.example/v1/chat/completions",
                fetcher: jsonFetcher(bodyFor(mb(9))),
            },
        );
        expect(completion.choices?.[0]?.message?.content ?? "").toHaveLength(
            mb(9),
        );
    });
});

describe("community responses leg (chatClient)", () => {
    const responsesBody = (contentBytes: number) =>
        JSON.stringify({
            id: "resp_1",
            object: "response",
            created_at: Math.floor(Date.now() / 1000),
            status: "completed",
            model: "upstream-model",
            output: [
                {
                    type: "message",
                    id: "msg_1",
                    role: "assistant",
                    status: "completed",
                    content: [
                        { type: "output_text", text: "A".repeat(contentBytes) },
                    ],
                },
            ],
            usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        });
    const jsonFetcher =
        (body: string): typeof fetch =>
        async () =>
            new Response(body, {
                status: 200,
                headers: { "content-type": "application/json" },
            });
    const communityOptions = {
        model: "upstream-model",
        stream: false as const,
        modelConfig: {
            communityEndpoint: true,
            responsesEndpoint: "https://community.example/v1",
            authKey: "k",
        },
    };

    it("rejects an oversized community responses body", async () => {
        await expect(
            callChatViaResponses(
                [{ role: "user", content: "hello" }],
                communityOptions,
                jsonFetcher(responsesBody(mb(9))),
            ),
        ).rejects.toThrow(/too large/);
    });

    it("passes a community responses body under the cap", async () => {
        const completion = await callChatViaResponses(
            [{ role: "user", content: "hello" }],
            communityOptions,
            jsonFetcher(responsesBody(1024)),
        );
        expect(typeof completion.choices?.[0]?.message?.content).toBe("string");
        expect((completion.choices?.[0]?.message?.content ?? "").length).toBe(
            1024,
        );
    });
});

describe("community embeddings leg (generateCommunityEmbeddings)", () => {
    afterEach(() => vi.unstubAllGlobals());
    const stubUpstream = (body: string) =>
        vi.stubGlobal(
            "fetch",
            async () =>
                new Response(body, {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
        );

    it("rejects an oversized embeddings body (9.5 MiB, 2M-dim vector)", async () => {
        const runtime = await buildRuntime("https://community.example/v1");
        const dims = 2_000_000;
        const body = JSON.stringify({
            object: "list",
            data: [
                {
                    object: "embedding",
                    embedding: new Array<number>(dims).fill(0.25),
                    index: 0,
                },
            ],
            model: "upstream-model",
            usage: { prompt_tokens: 5, total_tokens: 5 },
        });
        stubUpstream(body);
        await expect(
            generateCommunityEmbeddings(
                runtime,
                {
                    model: "upstream-model",
                    encoding_format: "float",
                    input: "hello",
                },
                "owner/bge",
                SECRET,
            ),
        ).rejects.toThrow(/too large/);
    });

    it("rejects an unbounded vector when dimensions is omitted (body under the byte cap)", async () => {
        const runtime = await buildRuntime("https://community.example/v1");
        const embedding = new Array<number>(8_000).fill(0.25);
        const body = JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding, index: 0 }],
            model: "upstream-model",
            usage: { prompt_tokens: 5, total_tokens: 5 },
        });
        stubUpstream(body);
        await expect(
            generateCommunityEmbeddings(
                runtime,
                {
                    model: "upstream-model",
                    encoding_format: "float",
                    input: "hello",
                },
                "owner/bge",
                SECRET,
            ),
        ).rejects.toThrow(/invalid embedding data/);
    });
});

describe("community transcription leg (callCommunityTranscriptionEndpoint)", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("rejects an oversized transcription body", async () => {
        const runtime = await buildRuntime("https://community.example/v1");
        const body = JSON.stringify({
            text: "T".repeat(mb(9)),
            duration: 1.5,
            language: "en",
            words: [],
            segments: [],
        });
        vi.stubGlobal(
            "fetch",
            async () =>
                new Response(body, {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
        );
        await expect(
            callCommunityTranscriptionEndpoint(
                runtime,
                {
                    file: new File(
                        [new Uint8Array([1, 2, 3, 4])],
                        "audio.mp3",
                        {
                            type: "audio/mpeg",
                        },
                    ),
                    responseFormat: "json",
                },
                SECRET,
            ),
        ).rejects.toThrow(/too large/);
    });
});

describe("text-cache capture cap (createCaptureStream)", () => {
    const testLog = {
        getChild: () => testLog,
        debug() {},
        info() {},
        warn() {},
        error() {},
    } as unknown as Logger;

    const makeContext = (
        put: (key: string, value: Uint8Array) => Promise<void>,
    ) =>
        ({
            get: (key: string) => (key === "log" ? testLog : undefined),
            env: { TEXT_BUCKET: { put } },
        }) as unknown as Parameters<typeof createCaptureStream>[0];

    it("streams an oversized response through without caching it", async () => {
        const put = vi.fn(async () => {});
        const response = new Response("B".repeat(mb(9)));
        const { stream, write } = createCaptureStream(
            makeContext(put),
            "cap-key",
            response,
        );
        const bytes = await new Response(stream).arrayBuffer();
        expect(bytes.byteLength).toBe(mb(9));
        await write;
        expect(put).not.toHaveBeenCalled();
    });

    it("caches a response under the cap", async () => {
        const put = vi.fn<(key: string, value: Uint8Array) => Promise<void>>(
            async () => {},
        );
        const response = new Response("B".repeat(64 * 1024));
        const { stream, write } = createCaptureStream(
            makeContext(put),
            "cap-key-2",
            response,
        );
        const bytes = await new Response(stream).arrayBuffer();
        expect(bytes.byteLength).toBe(64 * 1024);
        await write;
        expect(put).toHaveBeenCalledTimes(1);
        expect(put.mock.calls[0][0]).toBe("cap-key-2");
    });
});

describe("shared cap constant sanity", () => {
    it("is 8 MiB and distinct from the media cap", async () => {
        expect(MAX_COMMUNITY_TEXT_RESPONSE_BYTES).toBe(8 * 1024 * 1024);
        // The helper rejects beyond the cap (contrast with the pre-fix legs).
        const oversized = new Response(
            "x".repeat(MAX_COMMUNITY_TEXT_RESPONSE_BYTES + 1),
        );
        await expect(
            readResponseText(
                oversized,
                MAX_COMMUNITY_TEXT_RESPONSE_BYTES,
                () => new Error("too large"),
            ),
        ).rejects.toThrow("too large");
    });
});

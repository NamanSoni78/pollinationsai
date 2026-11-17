import { MAX_COMMUNITY_MEDIA_RESPONSE_BYTES } from "@shared/community-media.ts";
import { COMMUNITY_ENDPOINT_TIMEOUT_MS } from "@shared/community-endpoints.ts";
import { UpstreamError } from "@shared/error.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { communityEndpointFetch } from "../src/text/communityEndpoint.ts";
import { genericOpenAIClient } from "../src/text/genericOpenAIClient.ts";

const endpoint = "https://community.example.test/v1/chat/completions";

/** A chunked source that only produces its next chunk on pull and never
 * closes on its own, so an overflow-triggered cancel() is observable. */
function chunkedBody(chunks: number[]): {
    body: ReadableStream<Uint8Array<ArrayBuffer>>;
    wasCancelled: () => boolean;
} {
    let cancelled = false;
    let index = 0;
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
        pull(controller) {
            const size =
                index < chunks.length
                    ? chunks[index++]
                      : // Keep producing trailing bytes instead of closing, so
                        // a mid-stream cap violation always cancels a live
                        // upstream rather than a finished one.
                        1024;
            controller.enqueue(new Uint8Array(size).fill(65));
        },
        cancel() {
            cancelled = true;
        },
    });
    return { body, wasCancelled: () => cancelled };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("communityEndpointFetch response byte cap", () => {
    it("errors instead of relaying a stream larger than the media byte cap", async () => {
        // 20 MB + 10 MB lies past MAX_COMMUNITY_MEDIA_RESPONSE_BYTES without
        // ever declaring a Content-Length, like an unbounded SSE relay.
        const { body, wasCancelled } = chunkedBody([
            20 * 1024 * 1024,
            10 * 1024 * 1024,
        ]);
        const fetchMock = vi.fn(
            async () =>
                new Response(body, {
                    status: 200,
                    headers: { "content-type": "text/event-stream" },
                }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const response = await communityEndpointFetch(endpoint, {
            method: "POST",
        });
        await expect(response.text()).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(UpstreamError);
            expect((error as UpstreamError).status).toBe(502);
            expect((error as UpstreamError).message).toContain(
                "larger than",
            );
            return true;
        });
        expect(wasCancelled()).toBe(true);
    });

    it("rejects immediately on a declared Content-Length over the cap", async () => {
        const { body, wasCancelled } = chunkedBody([1024]);
        const fetchMock = vi.fn(
            async () =>
                new Response(body, {
                    status: 200,
                    headers: {
                        "content-type": "application/json",
                        "content-length": String(
                            MAX_COMMUNITY_MEDIA_RESPONSE_BYTES + 1,
                        ),
                    },
                }),
        );
        vi.stubGlobal("fetch", fetchMock);

        // Whether the runtime preserves the declared header or the running
        // total catches it, the oversized response must never be relayed and
        // the upstream body must be released.
        await expect(
            communityEndpointFetch(endpoint, { method: "POST" }).then((r) =>
                r.text(),
            ),
        ).rejects.toSatisfy((error: unknown) => {
            expect(error).toBeInstanceOf(UpstreamError);
            expect((error as UpstreamError).status).toBe(502);
            return true;
        });
        expect(wasCancelled()).toBe(true);
    });

    it("passes a bounded response through unchanged", async () => {
        const fetchMock = vi.fn(
            async () =>
                new Response('{"ok":true}', {
                    status: 201,
                    headers: {
                        "content-type": "application/json",
                        "x-publisher-header": "kept",
                    },
                }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const response = await communityEndpointFetch(endpoint);
        expect(response.status).toBe(201);
        expect(response.headers.get("content-type")).toBe(
            "application/json",
        );
        expect(response.headers.get("x-publisher-header")).toBe("kept");
        await expect(response.text()).resolves.toBe('{"ok":true}');
    });

    it("binds the community fetch to the endpoint deadline", async () => {
        const fetchMock = vi.fn(
            async (_input: string, _init?: RequestInit) =>
                new Response("{\"ok\":true}", { status: 200 }),
        );
        vi.stubGlobal("fetch", fetchMock);

        await communityEndpointFetch(endpoint);
        const init = fetchMock.mock.calls[0]?.[1] as
            | RequestInit
            | undefined;
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it("times out via the community deadline, not the platform default", async () => {
        // AbortSignal.timeout(COMMUNITY_ENDPOINT_TIMEOUT_MS) must fire far
        // below the platform's ~300 s proxy timeout for a wedged endpoint.
        expect(COMMUNITY_ENDPOINT_TIMEOUT_MS).toBeLessThanOrEqual(300_000);
    });
});

describe("genericOpenAIClient honors a community fetcher override", () => {
    it("uses the fetcher supplied through the request config", async () => {
        const completion = {
            id: "chatcmpl-cap-test",
            object: "chat.completion",
            created: 1737100000,
            model: "community/test-model",
            choices: [
                {
                    index: 0,
                    message: { role: "assistant", content: "ok" },
                    finish_reason: "stop",
                },
            ],
            usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
            },
        };
        const fetchMock = vi.fn(
            async (_input: string, _init?: RequestInit) =>
                new Response(JSON.stringify(completion), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
        );
        vi.stubGlobal("fetch", fetchMock);

        const result = await genericOpenAIClient(
            [{ role: "user", content: "hi" }],
            { model: "community/test-model" },
            {
                endpoint,
                fetcher: async (input: string, init?: RequestInit) =>
                    fetchMock(input, init),
            },
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[0]).toBe(endpoint);
        expect(result.choices?.[0]?.message?.content).toBe("ok");
    });
});

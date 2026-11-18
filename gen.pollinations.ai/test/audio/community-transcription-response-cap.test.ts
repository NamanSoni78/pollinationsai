import type { CommunityEndpointRuntime } from "@shared/community-endpoints.ts";
import * as decryptSecretModule from "@shared/secret-encryption.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callCommunityTranscriptionEndpoint } from "../../src/audio/communityEndpoint.ts";

const SECRET = "test-better-auth-secret";

/**
 * Community transcription serve paths buffer the publisher's response with
 * response.text() (audio/communityEndpoint.ts), while the image/video
 * community paths cap the same untrusted body at
 * MAX_COMMUNITY_MEDIA_RESPONSE_BYTES via readResponseText. A publisher's
 * endpoint — or anyone who compromises one — can declare (or stream) a
 * body far larger than any transcription, and the gen worker buffers all
 * of it: an isolate-OOM class inside the platform, paid for by the caller.
 */
function buildRuntime(
    overrides: Partial<CommunityEndpointRuntime> = {},
): CommunityEndpointRuntime {
    return {
        id: "ep-1",
        type: "proxy",
        ownerUserId: "user-1",
        modelId: "owner/whisper",
        name: "whisper",
        title: null,
        description: "Community transcription model",
        modality: "audio",
        imagePricing: "request",
        inputModalities: ["audio"],
        baseUrl: "https://example.com/v1",
        upstreamModel: "upstream-model",
        paidOnly: false,
        bearerTokenCiphertext: "ciphertext",
        visibility: "public",
        delegatesGeneration: false,
        fallbackModelIds: [],
        disabledAt: null,
        disabledReason: null,
        ...overrides,
    } as unknown as CommunityEndpointRuntime;
}

const AUDIO_FILE = () => new File([new Uint8Array([1, 2, 3, 4])], "a.mp3");

describe("callCommunityTranscriptionEndpoint response cap", () => {
    beforeEach(() => {
        vi.spyOn(decryptSecretModule, "decryptSecret").mockResolvedValue(
            "test-token",
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("serves a normal verbose_json transcription", async () => {
        const endpoint = buildRuntime();
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({
                        text: "hello world",
                        duration: 12,
                        language: "en",
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                ),
            ),
        );

        const response = await callCommunityTranscriptionEndpoint(
            endpoint,
            { file: AUDIO_FILE() },
            SECRET,
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ text: "hello world" });
    });

    it("rejects an oversized transcription response before buffering it", async () => {
        const endpoint = buildRuntime();
        // The endpoint declares a 200 MB body; the JSON actually sent is
        // small and valid, so on unpatched main the request SUCCEEDS after
        // buffering whatever the endpoint streams. The declared size alone
        // must refuse the read before a byte is buffered.
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({ text: "hello world", duration: 12 }),
                    {
                        status: 200,
                        headers: {
                            "content-type": "application/json",
                            "content-length": String(200 * 1024 * 1024),
                        },
                    },
                ),
            ),
        );

        await expect(
            callCommunityTranscriptionEndpoint(
                endpoint,
                { file: AUDIO_FILE() },
                SECRET,
            ),
        ).rejects.toMatchObject({ status: 502, message: /too large/i });
    });

    it("rejects an oversized streaming transcription response without a content-length", async () => {
        const endpoint = buildRuntime();
        // No content-length: the running byte count while streaming must
        // enforce the cap on its own.
        const oversizedBody = JSON.stringify({
            text: "x".repeat(30 * 1024 * 1024),
            duration: 1,
        });
        vi.stubGlobal(
            "fetch",
            vi.fn().mockResolvedValue(
                new Response(oversizedBody, {
                    status: 200,
                    headers: { "content-type": "application/json" },
                }),
            ),
        );

        await expect(
            callCommunityTranscriptionEndpoint(
                endpoint,
                { file: AUDIO_FILE() },
                SECRET,
            ),
        ).rejects.toMatchObject({ status: 502, message: /too large/i });
    });
});

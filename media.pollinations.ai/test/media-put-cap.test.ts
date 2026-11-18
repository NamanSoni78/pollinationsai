import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MediaUpload } from "../src/media-upload.ts";

// Mirrors MAX_GENERATION_MEDIA_BYTES in src/media-upload.ts. Defined locally
// so the suite runs (red) against the unpatched worker as well.
const MAX_GENERATION_MEDIA_BYTES = 64 * 1024 * 1024;
const MIB = 1024 * 1024;

/** A stream that emits `totalChunks` copies of `chunk` and then closes. */
function chunkedBody(
    totalChunks: number,
    chunk: Uint8Array,
    onProduced?: (chunks: number) => void,
): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            sent += 1;
            onProduced?.(sent);
            if (sent > totalChunks) {
                controller.close();
                return;
            }
            controller.enqueue(chunk);
        },
    });
}

describe("MediaUpload.put generation byte cap", () => {
    it("rejects a declared content-length over the cap without reading the body", async () => {
        const ctx = createExecutionContext();
        const storage = new MediaUpload(ctx, env);
        const id = "a".repeat(64);
        // The real body is one byte: the cap must trip on the declared
        // content-length alone, before anything is buffered.
        const response = new Response(chunkedBody(1, new Uint8Array([0x61])), {
            headers: {
                "Content-Type": "audio/mpeg",
                "Content-Length": String(MAX_GENERATION_MEDIA_BYTES + MIB),
            },
        });
        await expect(storage.put(id, response)).rejects.toThrow(
            /64 MiB|too large/i,
        );
        expect(await storage.has(id)).toBe(false);
        await waitOnExecutionContext(ctx);
    });

    it("rejects a streaming body that exceeds the cap mid-read", async () => {
        const ctx = createExecutionContext();
        const storage = new MediaUpload(ctx, env);
        const id = "b".repeat(64);
        const chunk = new Uint8Array(MIB);
        // Two chunks past the 64 MiB ceiling.
        const totalChunks = Math.ceil(MAX_GENERATION_MEDIA_BYTES / MIB) + 2;
        const response = new Response(chunkedBody(totalChunks, chunk), {
            headers: { "Content-Type": "audio/mpeg" },
        });
        await expect(storage.put(id, response)).rejects.toThrow(
            /64 MiB|too large/i,
        );
        expect(await storage.has(id)).toBe(false);
        await waitOnExecutionContext(ctx);
    });

    it("stores small media byte-identically", async () => {
        const ctx = createExecutionContext();
        const storage = new MediaUpload(ctx, env);
        const id = "c".repeat(64);
        const bytes = new Uint8Array([0x61, 0x62, 0x63]);
        await storage.put(
            id,
            new Response(bytes, {
                headers: {
                    "Content-Type": "image/png",
                    "X-Model-Used": "test-model",
                },
            }),
        );
        expect(await storage.has(id)).toBe(true);
        const stored = await env.MEDIA_BUCKET.get(id);
        expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
        await waitOnExecutionContext(ctx);
    });
});

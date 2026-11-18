import { afterEach, describe, expect, it, vi } from "vitest";
import { generateLyria35 } from "../../src/audio/lyria.ts";

// Issue 87's accepted profile at a distinct site: the fal leg of
// google/lyria-3.5 downloaded its artifact with a raw fetch() — no
// AbortSignal, no byte cap, no content-length check — then buffered the
// whole body. fal already billed the completed job (its billable-units
// receipt is in hand), so a slow or runaway fal-storage response pinned the
// request to the platform limit or OOM'd the isolate after the paid event.
// These tests pin the sonilo/mesh-convention caps: bounded wait + bounded
// bytes.

const options = {
    model: "google/lyria-3.5:fal" as const,
    prompt: "A short folk song",
    responseFormat: "mp3",
    falKey: "test-fal",
};

/** Stubs the fal queue flow up to a result whose audio URL is `songUrl`. */
function stubFalQueue(
    songResponse: (
        url: URL | RequestInfo,
        init?: RequestInit,
    ) => Response | Promise<Response>,
) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
        (async (url: URL | RequestInfo, init?: RequestInit) => {
            const href =
                typeof url === "string" ? url : new URL(url.toString()).href;
            if (href === "https://queue.fal.run/google/lyria-3.5")
                return Response.json({
                    status_url: "https://queue.fal.run/status",
                    response_url: "https://queue.fal.run/result",
                });
            if (href === "https://queue.fal.run/status")
                return Response.json({ status: "COMPLETED" });
            if (href === "https://queue.fal.run/result")
                return Response.json(
                    { audio: { url: "https://fal.media/song.mp3" } },
                    { headers: { "x-fal-billable-units": "30" } },
                );
            if (href === "https://fal.media/song.mp3")
                return songResponse(url, init);
            return new Response("unexpected", { status: 404 });
        }) as unknown as typeof fetch,
    );
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("Lyria 3.5 fal-leg artifact download caps", () => {
    it("rejects a declared body over the byte cap via content-length", async () => {
        stubFalQueue(
            () =>
                new Response(new Uint8Array([1, 2, 3]), {
                    headers: {
                        "content-type": "audio/mpeg",
                        "content-length": String(200 * 1024 * 1024),
                    },
                }),
        );

        vi.useFakeTimers();
        const pending = generateLyria35(options);
        await vi.advanceTimersByTimeAsync(10_000);
        const error = (await pending.catch(
            (err: unknown) => err,
        )) as Error;
        expect(error).toBeInstanceOf(Error);
        expect((error as { message?: string }).message).toMatch(/too large/i);
    });

    it("rejects a streaming body that exceeds the cap mid-download", async () => {
        const chunk = new Uint8Array(1024 * 1024).fill(1); // 1 MiB chunks
        let sent = 0;
        const endless = new ReadableStream<Uint8Array>({
            pull(controller) {
                sent += 1;
                if (sent > 200) {
                    controller.close();
                    return;
                }
                controller.enqueue(chunk);
            },
        });
        stubFalQueue(
            () =>
                new Response(endless, {
                    headers: { "content-type": "audio/mpeg" },
                }),
        );

        vi.useFakeTimers();
        const pending = generateLyria35(options);
        await vi.advanceTimersByTimeAsync(10_000);
        const error = (await pending.catch(
            (err: unknown) => err,
        )) as Error;
        expect(error).toBeInstanceOf(Error);
        expect((error as { message?: string }).message).toMatch(
            /too large|exceeded|cap/i,
        );
    });

    it("passes a bounded wait to the artifact fetch", async () => {
        let sawSignal = false;
        stubFalQueue((_url, init) => {
            sawSignal = Boolean(init?.signal);
            return new Response(new Uint8Array([1]), {
                headers: { "content-type": "audio/mpeg" },
            });
        });

        vi.useFakeTimers();
        const pending = generateLyria35(options);
        await vi.advanceTimersByTimeAsync(10_000);
        await pending.catch(() => undefined);
        // Pre-fix: no signal was passed at all and a stalled fal-storage
        // response hung the request to the platform limit.
        expect(sawSignal).toBe(true);
    });

    it("still returns a small well-formed song unchanged", async () => {
        const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]);
        stubFalQueue(
            () =>
                new Response(mp3, {
                    headers: { "content-type": "audio/mpeg" },
                }),
        );

        vi.useFakeTimers();
        const pending = generateLyria35(options);
        await vi.advanceTimersByTimeAsync(10_000);
        const response = await pending;
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(mp3);
    });
});

import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncModel3dEnvironment } from "../../src/model3d/env.ts";
import { downloadMesh } from "../../src/model3d/modelUtils.ts";

beforeEach(() => {
    syncModel3dEnvironment({ ...env } as CloudflareBindings);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("downloadMesh (3D provider artifact fetch)", () => {
    it("rejects an artifact over the declared byte cap via content-length", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(new Uint8Array([1, 2, 3]), {
                headers: {
                    "content-type": "model/gltf-binary",
                    "content-length": String(200 * 1024 * 1024),
                },
            }),
        );

        const error = await downloadMesh("https://provider.example/mesh.glb").catch(
            (err: unknown) => err,
        );
        expect((error as Error).message).toMatch(/too large/i);
    });

    it("rejects a streaming artifact that exceeds the cap mid-download", async () => {
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
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(endless, {
                headers: { "content-type": "model/gltf-binary" },
            }),
        );

        const error = await downloadMesh("https://provider.example/mesh.glb").catch(
            (err: unknown) => err,
        );
        expect((error as Error).message).toMatch(/exceeded|too large|cap/i);
    });

    it("uses a deadline: the artifact fetch is made with an AbortSignal", async () => {
        let sawSignal = false;
        vi.spyOn(globalThis, "fetch").mockImplementation(
            (_url, init) => {
                const signal = init?.signal;
                sawSignal = Boolean(signal);
                return Promise.resolve(
                    new Response(new Uint8Array([1]), {
                        headers: { "content-type": "model/gltf-binary" },
                    }),
                );
            },
        );

        await downloadMesh("https://provider.example/slow.glb").catch(
            (err: unknown) => err,
        );
        // Pre-fix: no signal was passed at all and a slow host hung the
        // request to the platform limit.
        expect(sawSignal).toBe(true);
    });

    it("still returns a small well-formed artifact unchanged", async () => {
        const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(bytes, {
                headers: { "content-type": "model/gltf-binary" },
            }),
        );

        const buffer = await downloadMesh("https://provider.example/ok.glb");
        expect(buffer.length).toBe(bytes.length);
        expect(buffer[0]).toBe(0x67);
    });
});

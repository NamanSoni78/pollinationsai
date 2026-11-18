import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncModel3dEnvironment } from "../../src/model3d/env.ts";
import { runFalJob } from "../../src/model3d/models/falClient.ts";

beforeEach(() => {
    syncModel3dEnvironment({
        ...env,
        FAL_KEY: "fal_test_key",
    } as CloudflareBindings);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe("runFalJob FAILED status", () => {
    it("rejects when the queue reports a FAILED job instead of polling forever", async () => {
        vi.useFakeTimers();
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        fetchSpy.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    request_id: "req_fail",
                    status_url:
                        "https://queue.fal.run/fal-ai/triposr/requests/req_fail/status",
                    response_url:
                        "https://queue.fal.run/fal-ai/triposr/requests/req_fail",
                }),
                { status: 202 },
            ),
        );
        // fal's documented terminal failure status. Fresh Response per poll:
        // each status read consumes the body once.
        fetchSpy.mockImplementation(async () =>
            new Response(JSON.stringify({ status: "FAILED" }), {
                status: 200,
            }),
        );

        const job = runFalJob({ endpoint: "fal-ai/triposr", input: {} });
        const rejection = job.catch((error: unknown) => error);

        // Advance well past several poll intervals.
        await vi.advanceTimersByTimeAsync(30_000);

        const error = await Promise.race([
            rejection,
            new Promise((_resolve, reject) =>
                setTimeout(
                    () => reject(new Error("STILL POLLING: FAILED not terminal")),
                    1_000,
                ),
            ),
        ]);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("FalError");
        expect((error as Error).message).toContain("FAILED");
    });

    it("surfaces the fal error detail on a FAILED job", async () => {
        vi.useFakeTimers();
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        fetchSpy.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    request_id: "req_fail2",
                    status_url:
                        "https://queue.fal.run/requests/req_fail2/status",
                    response_url: "https://queue.fal.run/requests/req_fail2",
                }),
                { status: 202 },
            ),
        );
        fetchSpy.mockImplementation(async () =>
            new Response(
                JSON.stringify({
                    status: "FAILED",
                    error: "upstream model crashed",
                }),
                { status: 200 },
            ),
        );

        const job = runFalJob({
            endpoint: "fal-ai/trellis/multi",
            input: {},
        });
        const rejection = job.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(30_000);

        const error = await Promise.race([
            rejection,
            new Promise((_resolve, reject) =>
                setTimeout(
                    () => reject(new Error("STILL POLLING: error detail lost")),
                    1_000,
                ),
            ),
        ]);
        expect((error as Error).message).toContain("upstream model crashed");
    });

    it("treats an unknown status value as an error instead of polling forever", async () => {
        vi.useFakeTimers();
        const fetchSpy = vi.spyOn(globalThis, "fetch");

        fetchSpy.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    request_id: "req_unknown",
                    status_url: "https://queue.fal.run/requests/req_unknown/status",
                    response_url: "https://queue.fal.run/requests/req_unknown",
                }),
                { status: 202 },
            ),
        );
        fetchSpy.mockImplementation(async () =>
            new Response(JSON.stringify({ status: "GARBAGE" }), {
                status: 200,
            }),
        );

        const job = runFalJob({ endpoint: "fal-ai/triposr", input: {} });
        const rejection = job.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(30_000);

        const error = await Promise.race([
            rejection,
            new Promise((_resolve, reject) =>
                setTimeout(
                    () => reject(
                        new Error("STILL POLLING: unknown status not terminal"),
                    ),
                    1_000,
                ),
            ),
        ]);
        expect(error).toBeInstanceOf(Error);
    });
});

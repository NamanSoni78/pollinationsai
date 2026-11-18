import {
    createExecutionContext,
    env,
    waitOnExecutionContext,
} from "cloudflare:test";
import { createTestApiKey } from "@shared/test/fixtures/index.ts";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import worker from "../../src/index.ts";
import { withInlineGenerationCoordinator } from "../helpers/inline-generation-coordinator.ts";

// POST /v1/audio/speech documents and enforces input ≤ 10,000 characters
// (CreateSpeechRequestSchema: input z.string().min(1).max(10000)). The GET
// /audio/:text param validator only has .min(1), so the same shared handler
// receives uncapped text — bounded only by the ~16 KB request line.

const FISH_MODEL = "fish-audio/s2.1-pro";
// Fish Audio bills UTF-8 bytes at $15/1M (x1.055): astral-plane characters
// cost 4 bytes each.
const FISH_PER_BYTE = (15 / 1_000_000) * 1.055;

const speechRequests: Array<{ input: unknown }> = [];

async function fetchWorker(path: string, init: RequestInit = {}) {
    const bindings = withInlineGenerationCoordinator({
        ...env,
        OPENROUTER_API_KEY: "openrouter-r17-key",
    } as unknown as CloudflareBindings);
    const ctx = createExecutionContext();
    const response = await worker.fetch(
        new Request(`https://gen.pollinations.ai${path}`, init),
        bindings,
        ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
}

beforeEach(() => {
    // Mocked upstreams only: OpenRouter speech answers audio; every other
    // host (Tinybird ingest + public pipes) gets an inert 2xx. No network.
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(
                input instanceof Request ? input.url : String(input),
            );
            if (url.host === "openrouter.ai") {
                speechRequests.push(await new Request(input, init).json());
                return new Response(new Uint8Array([1, 2, 3]), {
                    headers: {
                        "content-type": "audio/mpeg",
                        "x-generation-id": "gen-r17-d",
                    },
                });
            }
            if (url.host === "api.europe-west2.gcp.tinybird.co") {
                return Response.json({ data: [] });
            }
            return new Response("unmocked host", { status: 404 });
        }) as unknown as typeof fetch,
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    speechRequests.length = 0;
});

describe("Round 17 lead D: GET /audio/:text enforces the documented 10,000-char cap", () => {
    it("RED: rejects a 15,000-character GET input like POST does", async () => {
        const { key } = await createTestApiKey({
            user: { packBalance: 100 },
        });
        const text = "a".repeat(15_000);
        const response = await fetchWorker(
            `/audio/${encodeURIComponent(text)}?model=${encodeURIComponent(FISH_MODEL)}`,
            { headers: { authorization: `Bearer ${key}` } },
        );
        // POST answers 400 for this input ("input: String must contain at
        // most 10000 character(s)"); the GET path feeds the same shared
        // handler, so it must refuse it too instead of billing 15,000
        // UTF-8 bytes on a per-byte model.
        expect(response.status, await response.clone().text()).toBe(400);
        expect(speechRequests).toHaveLength(0);
    });

    it("control: POST /v1/audio/speech refuses the same 15,000-char input", async () => {
        const { key } = await createTestApiKey({
            user: { packBalance: 100 },
        });
        const response = await fetchWorker("/v1/audio/speech", {
            method: "POST",
            headers: {
                authorization: `Bearer ${key}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: FISH_MODEL,
                input: "a".repeat(15_000),
            }),
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("10000");
        expect(speechRequests).toHaveLength(0);
    });

    it("documents the byte multiplier: 2,500 astral chars bill 10,000 UTF-8 bytes", async () => {
        const { key } = await createTestApiKey({
            user: { packBalance: 100 },
        });
        // 2,500 musical-symbol glyphs (U+1D11E): 5,000 UTF-16 units — under
        // the POST cap — but 10,000 UTF-8 bytes on a per-byte model, the
        // same bill as the full 10,000-character ASCII cap.
        const text = "\u{1D11E}".repeat(2_500);
        expect(text.length).toBe(5_000);
        expect(new TextEncoder().encode(text).byteLength).toBe(10_000);
        const response = await fetchWorker(
            `/audio/${encodeURIComponent(text)}?model=${encodeURIComponent(FISH_MODEL)}`,
            { headers: { authorization: `Bearer ${key}` } },
        );
        expect(response.status, await response.clone().text()).toBe(200);
        // Fish Audio bills UTF-8 bytes: 4 per astral-plane character.
        expect(response.headers.get("x-usage-completion-audio-tokens")).toBe(
            "10000",
        );
        expect(speechRequests).toHaveLength(1);
        expect((speechRequests[0] as { input: string }).input).toBe(text);
        // At the registry rate this is $0.158 of Pollen from 2,500 glyphs.
        expect(10_000 * FISH_PER_BYTE).toBeCloseTo(0.15825, 6);
    });
});

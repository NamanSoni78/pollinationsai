import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { getUserBalance } from "@shared/billing/balance.ts";
import { createTestApiKey } from "@shared/test/fixtures/index.ts";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index.ts";
import { withInlineGenerationCoordinator } from "../helpers/inline-generation-coordinator.ts";

const model = "qwen/qwen3guard-gen-8b";
const host = "oai.endpoints.kepler.ai.cloud.ovh.net";

const errorWire = JSON.stringify({
    id: "finish-error",
    object: "chat.completion",
    model,
    choices: [
        {
            index: 0,
            message: { role: "assistant", content: "partial answer" },
            finish_reason: "error",
            error: { message: "Provider failed mid-generation" },
        },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
});

const okWire = JSON.stringify({
    id: "finish-ok",
    object: "chat.completion",
    model,
    choices: [
        {
            index: 0,
            message: { role: "assistant", content: "full answer" },
            finish_reason: "stop",
        },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
});

async function callRoute(
    wire: string,
    path: string,
    key: string,
    init: RequestInit,
) {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, initArg) => {
        const request = new Request(input, initArg);
        if (new URL(request.url).hostname === "tinybird.test") {
            return Response.json({});
        }
        const azureResource = request.headers.get(
            "x-portkey-azure-resource-name",
        );
        const target =
            request.headers.get("x-portkey-custom-host") ?? request.url;
        const targetHost = azureResource
            ? `${azureResource}.openai.azure.com`
            : new URL(target).host;
        if ([host].flat().includes(targetHost)) {
            calls++;
            return new Response(wire, {
                headers: { "content-type": "application/json" },
            });
        }
        return Response.json({ data: [] });
    });
    const context = createExecutionContext();
    const response = await worker.fetch(
        new Request(`https://gen.pollinations.ai${path}`, {
            ...init,
            headers: {
                authorization: `Bearer ${key}`,
                ...(init.headers ?? {}),
            },
        }),
        withInlineGenerationCoordinator({
            ...env,
            AZURE_MYCELI_PROD_API_KEY: "test_azure_key",
            TINYBIRD_INGEST_URL:
                "https://tinybird.test/v0/events?name=generation_event_v2",
            TINYBIRD_INGEST_TOKEN: "test_tinybird_token",
        }),
        context,
    );
    const text = await response.text();
    await waitOnExecutionContext(context);
    return { response, text, calls };
}

describe("content routes reject completions that finish in error", () => {
    it("GET /text/:prompt returns 502 instead of serving the partial answer", async () => {
        const { key } = await createTestApiKey({
            expiresIn: 600,
            user: { packBalance: 100 },
        });
        const { response, text } = await callRoute(
            errorWire,
            `/text/${encodeURIComponent("finish error probe")}?model=${encodeURIComponent(model)}`,
            key,
            { method: "GET" },
        );
        expect(response.status, text).toBe(502);
        expect(text).not.toBe("partial answer");
    });

    it("GET /text/:prompt still serves answers that finish normally", async () => {
        const { key } = await createTestApiKey({
            expiresIn: 600,
            user: { packBalance: 100 },
        });
        const { response, text } = await callRoute(
            okWire,
            `/text/${encodeURIComponent("finish ok probe")}?model=${encodeURIComponent(model)}`,
            key,
            { method: "GET" },
        );
        expect(response.status, text).toBe(200);
        expect(text).toBe("full answer");
    });

    it("keeps the chat-completions marker contract untouched", async () => {
        const { key } = await createTestApiKey({
            expiresIn: 600,
            user: { packBalance: 100 },
        });
        const { response, text } = await callRoute(
            errorWire,
            "/v1/chat/completions",
            key,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    model,
                    stream: false,
                    messages: [
                        { role: "user", content: "finish error chat probe" },
                    ],
                }),
            },
        );
        expect(response.status, text).toBe(200);
        const body = JSON.parse(text);
        expect(body.choices[0].finish_reason).toBe("error");
    });
});

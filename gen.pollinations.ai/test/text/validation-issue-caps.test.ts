import {
    MAX_MESSAGES_PER_REQUEST,
} from "@shared/schemas/openai.ts";
import { CreateChatCompletionRequestSchema } from "@shared/schemas/openai.ts";
import { CreateEmbeddingRequestSchema } from "@/schemas/embeddings.ts";
import { CreateMessageRequestSchema } from "@/text/messages/schema.ts";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// GHSA-mrhx-c7xc-m3w5: zod < 4.6.6 materializes one issue object (~1 KB) per
// failing array element with no cap or early abort, so an anonymous ~1.6 MB
// body of 100k invalid messages allocated ~200 MB of issues inside the shared
// gen isolate — before any auth or billing middleware ran. On zod >= 4.6.6 a
// violated .max() short-circuits to exactly one issue, which is why the fix
// is both the version bump and the per-array caps.
//
// These tests pin the short-circuit: a hostile oversized body must produce a
// handful of issues (not one per element), and legitimate bodies at the cap
// must keep parsing.

const require = createRequire(import.meta.url);
const zodVersion = require("zod/package.json").version as string;

const validMessage = (i: number) => ({
    role: "user",
    content: `message ${i}`,
});

describe("validation issue amplification (GHSA-mrhx-c7xc-m3w5)", () => {
    it("runs a zod version with the advisory fix (>= 4.6.6)", () => {
        const [major, minor, patch] = zodVersion.split(".").map(Number);
        expect(
            major > 4 ||
                (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))),
        ).toBe(true);
    });

    it.each([
        ["CreateMessageRequestSchema", CreateMessageRequestSchema, 50_000],
        ["CreateChatCompletionRequestSchema", CreateChatCompletionRequestSchema, 50_000],
    ])(
        "%s short-circuits an oversized invalid messages array",
        (_name, schema, count) => {
            const body = {
                model: "x",
                max_tokens: 1,
                messages: Array.from({ length: count }, () => ({
                    role: "nope",
                })),
            };
            const result = schema.safeParse(body);
            expect(result.success).toBe(false);
            // Unpatched main materialized 2 issues per element (100k for this
            // body). With the cap + fixed zod this must be a single digit.
            if (!result.success) {
                expect(result.error.issues.length).toBeLessThanOrEqual(2);
            }
        },
    );

    it("keeps parsing legitimate conversations at the cap", () => {
        const atCap = {
            model: "x",
            max_tokens: 8,
            messages: Array.from(
                { length: MAX_MESSAGES_PER_REQUEST },
                (_, i) => validMessage(i),
            ),
        };
        expect(CreateMessageRequestSchema.safeParse(atCap).success).toBe(true);
        expect(
            CreateChatCompletionRequestSchema.safeParse({
                messages: atCap.messages,
            }).success,
        ).toBe(true);
    });

    it("rejects one message past the cap with a single clean issue", () => {
        const overCap = {
            model: "x",
            max_tokens: 8,
            messages: Array.from(
                { length: MAX_MESSAGES_PER_REQUEST + 1 },
                (_, i) => validMessage(i),
            ),
        };
        const result = CreateMessageRequestSchema.safeParse(overCap);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.length).toBe(1);
        }
    });

    it("caps the OpenAI tools array (128) without breaking valid requests", () => {
        const tool = (i: number) => ({
            type: "function",
            function: {
                name: `tool_${i}`,
                description: "test tool",
                parameters: { type: "object", properties: {} },
            },
        });
        expect(
            CreateChatCompletionRequestSchema.safeParse({
                messages: [validMessage(0)],
                tools: Array.from({ length: 128 }, (_, i) => tool(i)),
            }).success,
        ).toBe(true);
        const result = CreateChatCompletionRequestSchema.safeParse({
            messages: [validMessage(0)],
            tools: Array.from({ length: 5_000 }, (_, i) => ({ bad: i })),
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.length).toBeLessThanOrEqual(2);
        }
    });

    it("caps the embeddings multimodal parts array like the string batch", () => {
        const invalidParts = Array.from({ length: 40 }, () => ({
            type: "not-a-part",
        }));
        const result = CreateEmbeddingRequestSchema.safeParse({
            input: invalidParts,
        });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.error.issues.length).toBeLessThanOrEqual(3);
        }
        const validParts = Array.from({ length: 32 }, () => ({
            type: "text",
            text: "embed me",
        }));
        expect(
            CreateEmbeddingRequestSchema.safeParse({ input: validParts })
                .success,
        ).toBe(true);
    });
});

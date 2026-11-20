import {
    getCostDefinition,
} from "@shared/registry/registry.ts";
import { TEXT_FALLBACKS } from "@shared/registry/text-fallbacks.ts";
import { describe, expect, it } from "vitest";

/**
 * OpenRouter publishes endpoint-level pricing at
 * openrouter.ai/api/v1/models/<model>/endpoints (fetched 2026-11-19):
 *  - minimax/minimax-m2.7: the pinned novita/fp8 endpoint is delisted; the
 *    only live endpoint is gmicloud/fp8 at $0.21/$0.042/$0.84 per 1M.
 *  - qwen/qwen3-coder-next: the streamlake endpoint is delisted; the only
 *    live endpoint is parasail/bf16 at $0.12/$0.07/$0.80 per 1M — the rates
 *    the primary qwen sheet already carries.
 * Settlement bills the registry sheet against the endpoint that actually
 * serves the pinned route, so the sheets must describe live endpoints.
 */
const CREDIT_FEE = 1.055;
const perToken = (rate: number) => (rate * CREDIT_FEE) / 1_000_000;

describe("OpenRouter endpoint pin refresh (2026-11-19)", () => {
    it("minimax-m2.7 bills gmicloud/fp8, the only live endpoint serving it", () => {
        const cost = getCostDefinition("minimax/minimax-m2.7");
        expect(cost?.promptTextTokens).toBeCloseTo(perToken(0.21), 15);
        expect(cost?.promptCachedTokens).toBeCloseTo(perToken(0.042), 15);
        expect(cost?.completionTextTokens).toBeCloseTo(perToken(0.84), 15);
    });
    it("the qwen3-coder streamlake fallback bills parasail/bf16, the only live endpoint", () => {
        const fallback =
            TEXT_FALLBACKS["qwen/qwen3-coder-next"]?.[
                "qwen/qwen3-coder-next:openrouter:streamlake"
            ];
        expect(fallback?.cost?.promptTextTokens).toBeCloseTo(
            perToken(0.12),
            15,
        );
        expect(fallback?.cost?.promptCachedTokens).toBeCloseTo(
            perToken(0.07),
            15,
        );
        expect(fallback?.cost?.completionTextTokens).toBeCloseTo(
            perToken(0.8),
            15,
        );
    });
});

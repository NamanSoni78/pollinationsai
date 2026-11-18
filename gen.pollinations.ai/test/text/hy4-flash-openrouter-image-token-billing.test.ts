import { calculateUsageBilling } from "@shared/registry/registry.ts";
import { TEXT_SERVICES } from "@shared/registry/text.ts";
import { openaiUsageToUsage } from "@shared/registry/usage-headers.ts";
import { describe, expect, it } from "vitest";

describe("hy4-flash OpenRouter fallback image-token billing", () => {
    it("carries the image-token rate onto the fallback route sheet", () => {
        const fallback = TEXT_SERVICES["tencent/hy4-flash:openrouter"];
        expect(fallback.inputModalities).toContain("image");
        expect(fallback.provider).toBe("openrouter");
        // The route mirrors the primary's other rates with the 5.5%
        // OpenRouter credit fee; the image line must ride along, otherwise
        // the route inherits image input but never prices it. The parent
        // carries the quoted rate (expectInheritedRoute's invariant).
        const parent = TEXT_SERVICES["tencent/hy4-flash"];
        expect(parent.cost.promptImageTokens).toBeDefined();
        expect(fallback.cost.promptImageTokens).toBeDefined();
    });

    it("bills image input tokens when the OpenRouter route serves the request", () => {
        // OpenAI-compatible usage reports the image-token split; the usage
        // pipeline carves it out of promptTextTokens.
        const usage = openaiUsageToUsage({
            prompt_tokens: 1000,
            completion_tokens: 100,
            total_tokens: 1100,
            prompt_tokens_details: { image_tokens: 400 },
        });
        expect(usage).toMatchObject({
            promptTextTokens: 600,
            promptImageTokens: 400,
            completionTextTokens: 100,
        });
        const fallback = TEXT_SERVICES["tencent/hy4-flash:openrouter"];
        const billing = calculateUsageBilling({
            model: "tencent/hy4-flash",
            usage,
            servedBy: fallback,
            quotedBy: TEXT_SERVICES["tencent/hy4-flash"],
        });
        // convertUsage zero-fills unrated lines: without the image rate on
        // the served sheet, 400 image tokens contribute exactly $0 to cost
        // and servedPrice while OpenRouter bills the platform for them.
        expect(billing.cost.promptImageTokens ?? 0).toBeGreaterThan(0);
        const openrouterImageRate = (0.035 * 1.055) / 1e6;
        expect(billing.cost.promptImageTokens).toBeCloseTo(
            400 * openrouterImageRate,
            12,
        );
        expect(billing.servedPrice).toBeCloseTo(
            (600 * 0.035 * 1.055 + 400 * 0.035 * 1.055 + 100 * 0.1405 * 1.055) /
                1e6,
            8,
        );
    });
});

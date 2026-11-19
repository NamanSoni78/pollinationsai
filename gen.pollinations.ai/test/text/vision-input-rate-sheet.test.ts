import { calculateUsageBilling } from "@shared/registry/registry.ts";
import { TEXT_SERVICES } from "@shared/registry/text.ts";
import { describe, expect, it } from "vitest";

// Every route below advertises image (or cached-prompt) input in
// inputModalities and is served by a provider whose usage responses split
// prompt_tokens_details.image_tokens / cached_tokens out of prompt_tokens
// (pinned in-repo: Azure Grok + AWS Bedrock in generateTextPortkey.test.ts,
// DeepInfra Kimi K2.6 in static-provider-fallbacks.test.ts, Vercel AI Gateway
// in the issue-45 report, OpenRouter/Novita/Fireworks on their sibling
// sheets). convertUsage bills any reported usage line that has no rate at $0
// (registry.ts "Missing conversion rate"), and openaiUsageToUsage subtracts
// the split details from promptTextTokens, so an image-capable sheet without
// promptImageTokens gives the input away for free.
//
// The expected rate for each route is its own promptTextTokens rate — the
// convention every already-priced sibling follows (kimi-k2.6 azure/deepinfra,
// muse-wonder vercel, mistral-small-4 openrouter, glm-5.3-flash fireworks,
// qwen3-vl-235b alibaba, llama-4-scout vercel, mimo-v2.6 novita).
//
// Excluded on purpose: the Anthropic Claude family (images fold into input
// tokens family-wide — a documented provider convention, not a missing rate),
// qwen/qwen4-max:vercel (carried by the pending issue-45 PR), and
// mistralai/mistral-large-3:aws (its sheet documents "Bedrock US Standard
// reports image input in the prompt total" — fold-in verified by maintainers).

const IMAGE_ROUTES: [string, string][] = [
    // Primaries.
    ["tencent/hy4-flash", "tencent/hy4-flash"],
    ["moonshotai/kimi-k3.1-pro-highspeed", "moonshotai/kimi-k3.1-pro-highspeed"],
    ["moonshotai/kimi-k3", "moonshotai/kimi-k3"],
    ["nvidia/nemotron-3.5-super-vl", "nvidia/nemotron-3.5-super-vl"],
    ["minimax/minimax-m3", "minimax/minimax-m3"],
    ["minimax/minimax-m3.1-flash", "minimax/minimax-m3.1-flash"],
    ["meta/muse-spark-1.2", "meta/muse-spark-1.2"],
    ["meta/muse-spark-1.3", "meta/muse-spark-1.3"],
    ["meta/muse-spark-open", "meta/muse-spark-open"],
    ["qwen/qwen3-vl-30b-a3b-instruct", "qwen/qwen3-vl-30b-a3b-instruct"],
    ["stepfun/step-5-preview", "stepfun/step-5-preview"],
    ["stepfun/step-3.7-flash", "stepfun/step-3.7-flash"],
    ["mistralai/mistral-small-3.2", "mistralai/mistral-small-3.2"],
    ["cohere/command-a-plus", "cohere/command-a-plus"],
    ["xiaomi/mimo-v2.5", "xiaomi/mimo-v2.5"],
    ["nex-agi/nex-n2.5-mini", "nex-agi/nex-n2.5-mini"],
    ["nex-agi/nex-n2.5-pro", "nex-agi/nex-n2.5-pro"],
    ["mistralai/mistral-large-3", "mistralai/mistral-large-3"],
    ["meta/llama-4-maverick", "meta/llama-4-maverick"],
    // Fallback routes (served by the route, quoted by the primary).
    ["tencent/hy4-flash:openrouter", "tencent/hy4-flash"],
    ["moonshotai/kimi-k3.1-pro:vercel", "moonshotai/kimi-k3.1-pro"],
    ["moonshotai/kimi-k3:deepinfra", "moonshotai/kimi-k3"],
    ["moonshotai/kimi-k3:fireworks", "moonshotai/kimi-k3"],
    ["nvidia/nemotron-3.5-super-vl:openrouter:together", "nvidia/nemotron-3.5-super-vl"],
    ["qwen/qwen3-vl-30b-a3b-instruct:openrouter:deepinfra", "qwen/qwen3-vl-30b-a3b-instruct"],
    ["xiaomi/mimo-v2.6-flash:deepinfra", "xiaomi/mimo-v2.6-flash"],
    ["xiaomi/mimo-v2.6-pro:deepinfra", "xiaomi/mimo-v2.6-pro"],
    ["minimax/minimax-m3:deepinfra", "minimax/minimax-m3"],
    ["meta/muse-spark-open:vercel:baseten", "meta/muse-spark-open"],
    ["stepfun/step-5-preview:vercel", "stepfun/step-5-preview"],
    ["stepfun/step-3.7-flash:vercel", "stepfun/step-3.7-flash"],
    ["mistralai/mistral-small-3.2:deepinfra", "mistralai/mistral-small-3.2"],
    ["deepseek/deepseek-v4.1-flash:fireworks", "deepseek/deepseek-v4.1-flash"],
    ["deepseek/deepseek-v4.1-flash-1017:fireworks", "deepseek/deepseek-v4.1-flash-1017"],
];

// Routes whose dropped line is the cached-prompt rate (Bedrock and DeepInfra
// both report cached_tokens; pinned by the AWS Bedrock test and the DeepInfra
// cached rates on the mimo/glm/kimi sheets).
const CACHED_ROUTES: [string, string][] = [
    ["qwen/qwen3-coder-30b-a3b-instruct:aws", "qwen/qwen3-coder-30b-a3b-instruct"],
    ["google/gemma-4-31b-it:deepinfra", "google/gemma-4-31b-it"],
];

describe("vision-capable rate sheets price their advertised input lines", () => {
    const rateOf = (
        id: string,
        line: "promptImageTokens" | "promptCachedTokens",
    ): number | undefined => {
        const def = TEXT_SERVICES[id as keyof typeof TEXT_SERVICES] as
            | { cost?: Record<string, number | undefined> }
            | undefined;
        return def?.cost?.[line];
    };

    it.each(IMAGE_ROUTES)(
        "%s defines a promptImageTokens rate",
        (routeId, quotedId) => {
            const route = TEXT_SERVICES[routeId as keyof typeof TEXT_SERVICES];
            const quoted =
                TEXT_SERVICES[quotedId as keyof typeof TEXT_SERVICES];
            expect(route).toBeDefined();
            expect(quoted).toBeDefined();
            expect(route?.inputModalities).toContain("image");
            expect(rateOf(routeId, "promptImageTokens")).toBeDefined();
        },
    );

    it.each(IMAGE_ROUTES)(
        "%s bills reported image input tokens",
        (routeId, quotedId) => {
            const route = TEXT_SERVICES[routeId as keyof typeof TEXT_SERVICES];
            const quoted =
                TEXT_SERVICES[quotedId as keyof typeof TEXT_SERVICES];
            const rate = rateOf(routeId, "promptImageTokens");
            expect(rate).toBeDefined();
            const base = {
                model: quotedId,
                usage: {
                    promptTextTokens: 1000,
                    completionTextTokens: 100,
                },
                servedBy: route,
                quotedBy: quoted,
            };
            const withImages = calculateUsageBilling({
                ...base,
                usage: {
                    promptTextTokens: 1000,
                    promptImageTokens: 2000,
                    completionTextTokens: 100,
                },
            });
            const textOnly = calculateUsageBilling(base);
            // 2000 image tokens at the route's own rate must be charged, not $0.
            expect(withImages.cost.totalCost).toBeCloseTo(
                textOnly.cost.totalCost + 2000 * (rate as number),
                15,
            );
        },
    );

    it.each(CACHED_ROUTES)(
        "%s defines and bills a promptCachedTokens rate",
        (routeId, quotedId) => {
            const route = TEXT_SERVICES[routeId as keyof typeof TEXT_SERVICES];
            const quoted =
                TEXT_SERVICES[quotedId as keyof typeof TEXT_SERVICES];
            expect(route).toBeDefined();
            expect(quoted).toBeDefined();
            const rate = rateOf(routeId, "promptCachedTokens");
            expect(rate).toBeDefined();
            const base = {
                model: quotedId,
                usage: {
                    promptTextTokens: 1000,
                    completionTextTokens: 100,
                },
                servedBy: route,
                quotedBy: quoted,
            };
            const withCached = calculateUsageBilling({
                ...base,
                usage: {
                    promptTextTokens: 1000,
                    promptCachedTokens: 2000,
                    completionTextTokens: 100,
                },
            });
            const cold = calculateUsageBilling(base);
            expect(withCached.cost.totalCost).toBeCloseTo(
                cold.cost.totalCost + 2000 * (rate as number),
                15,
            );
        },
    );

    it("mistral-large-3:aws quotes at the AWS list sheet, not the inherited Azure discount", () => {
        // Every other AWS fallback pins priceMultiplier 1 (the issue-37 fix
        // convention): the 0.75 Azure discount must not leak onto the Bedrock
        // list sheet.
        const route =
            TEXT_SERVICES["mistralai/mistral-large-3:aws" as keyof typeof TEXT_SERVICES];
        expect(route?.priceMultiplier).toBe(1);
    });
});

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { FinishReason, ToolSet } from "ai";
import {
    type CompletionUsage,
    CompletionUsageSchema,
} from "../schemas/openai.ts";
import type { AgentUsage } from "./types.ts";

type AgentStep = {
    providerMetadata?: Record<string, Record<string, unknown>>;
};

export function createAgentModelProvider({
    baseURL,
    fetch: fetcher,
    apiKey,
}: {
    baseURL: string;
    fetch: typeof fetch;
    apiKey?: string;
}) {
    return createOpenAICompatible({
        name: "pollinations",
        ...(apiKey ? { apiKey } : {}),
        baseURL,
        fetch: fetcher,
        metadataExtractor: {
            async extractMetadata({ parsedBody }) {
                // A completion that finished with finish_reason=error is a
                // failed generation. Reject the step here — the raw provider
                // marker is dropped by the AI SDK's finish-reason mapping
                // (unknown -> "other"), so without this gate the run resolves
                // with its partial output as a successful, billed step.
                const finishError = finishErrorMessage(parsedBody);
                if (finishError) throw new Error(finishError);
                return {
                    pollinations: {
                        completionUsage: completionUsageFromBody(parsedBody),
                    },
                };
            },
            createStreamExtractor() {
                let usage: unknown;
                let finishError: string | undefined;
                return {
                    processChunk(chunk) {
                        if (
                            chunk &&
                            typeof chunk === "object" &&
                            "usage" in chunk &&
                            chunk.usage != null
                        ) {
                            // Providers may send provisional counts before final usage.
                            usage = chunk.usage;
                        }
                        finishError ??= finishErrorMessage(chunk);
                    },
                    buildMetadata() {
                        if (finishError) throw new Error(finishError);
                        return {
                            pollinations: {
                                completionUsage:
                                    usage == null
                                        ? null
                                        : completionUsage(usage),
                            },
                        };
                    },
                };
            },
        },
    });
}

/**
 * The provider's terminal failure marker for a chat completion: any choice
 * finishing with finish_reason=error. Returns the message to fail the step
 * with, or undefined when the completion finished normally.
 */
function finishErrorMessage(body: unknown): string | undefined {
    if (!body || typeof body !== "object") return undefined;
    const choices = (body as { choices?: unknown }).choices;
    if (!Array.isArray(choices)) return undefined;
    for (const choice of choices) {
        if (
            !choice ||
            typeof choice !== "object" ||
            (choice as { finish_reason?: unknown }).finish_reason !== "error"
        ) {
            continue;
        }
        const message = (
            choice as { error?: { message?: unknown } }
        ).error?.message;
        return typeof message === "string" && message
            ? message
            : "Upstream ended generation with finish_reason=error";
    }
    return undefined;
}

/** Whether the run stopped on calls only the caller can answer (no execute). */
export function awaitsCaller(
    steps: { toolCalls: { toolName: string; invalid?: boolean }[] }[],
    tools: ToolSet,
): boolean {
    return (
        steps
            .at(-1)
            ?.toolCalls.some(
                (call) =>
                    !call.invalid &&
                    Object.hasOwn(tools, call.toolName) &&
                    !tools[call.toolName].execute,
            ) ?? false
    );
}

export function openAIFinishReason(reason: FinishReason): string {
    if (reason === "tool-calls") return "tool_calls";
    if (reason === "content-filter") return "content_filter";
    if (reason === "stop" || reason === "length") return reason;
    return "stop";
}

function completionUsage(value: unknown): CompletionUsage | null {
    const parsed = CompletionUsageSchema.safeParse(value);
    // Reject invalid usage only after the SDK resolves its result. Throwing
    // inside metadata extraction also rejects the SDK's sibling promises.
    return parsed.success ? parsed.data : null;
}

function completionUsageFromBody(body: unknown): CompletionUsage | null {
    if (!body || typeof body !== "object" || !("usage" in body)) {
        return null;
    }
    return completionUsage(body.usage);
}

function sumUsageField(
    usages: CompletionUsage[],
    value: (usage: CompletionUsage) => number | null | undefined,
): number | undefined {
    let found = false;
    let total = 0;
    for (const usage of usages) {
        const amount = value(usage);
        if (amount == null) continue;
        found = true;
        total += amount;
    }
    return found ? total : undefined;
}

export function strictAgentUsage(steps: AgentStep[]): AgentUsage {
    const usages = steps.map((step) => {
        const usage = completionUsage(
            step.providerMetadata?.pollinations?.completionUsage,
        );
        if (!usage) throw new Error("Agent response omitted valid usage");
        return usage;
    });
    if (usages.length === 0) {
        throw new Error("Agent response omitted valid usage");
    }
    return {
        inputTokens: sumUsageField(usages, (usage) => usage.prompt_tokens),
        inputTokenDetails: {
            cacheReadTokens: sumUsageField(
                usages,
                (usage) => usage.prompt_tokens_details?.cached_tokens,
            ),
            cacheWriteTokens: sumUsageField(
                usages,
                (usage) => usage.prompt_tokens_details?.cache_write_tokens,
            ),
        },
        outputTokens: sumUsageField(usages, (usage) => usage.completion_tokens),
        outputTokenDetails: {
            reasoningTokens: sumUsageField(
                usages,
                (usage) =>
                    usage.completion_tokens_details?.reasoning_tokens ??
                    usage.reasoning_tokens,
            ),
        },
        totalTokens: sumUsageField(usages, (usage) => usage.total_tokens),
    };
}

import { describe, expect, it } from "vitest";
import { UpstreamError } from "@shared/error.ts";
import { throwTextError } from "../../src/text/errors.ts";
import type { ServiceError } from "../../src/text/types.ts";

describe("text error funnel", () => {
    it("propagates a paid failure's billedUsage through the wrap", () => {
        // The shape a client attaches when the provider completed a paid step
        // before the failure (e.g. Vercel two-step search's step 1, issue 88).
        const paid: ServiceError = Object.assign(
            new Error("Vercel search returned no answer to format"),
            {
                status: 502,
                upstreamStatus: 502,
                billedUsage: {
                    promptTextTokens: 60,
                    completionTextTokens: 10,
                },
            },
        );

        let wrapped: UpstreamError | undefined;
        try {
            throwTextError(paid);
        } catch (error) {
            wrapped = error as UpstreamError;
        }
        expect(wrapped).toBeInstanceOf(UpstreamError);
        expect(wrapped?.billedUsage).toEqual({
            promptTextTokens: 60,
            completionTextTokens: 10,
        });
    });

    it("leaves ordinary service errors unbilled", () => {
        const plain: ServiceError = Object.assign(new Error("upstream 5xx"), {
            status: 502,
        });

        let wrapped: UpstreamError | undefined;
        try {
            throwTextError(plain);
        } catch (error) {
            wrapped = error as UpstreamError;
        }
        expect(wrapped).toBeInstanceOf(UpstreamError);
        expect(wrapped?.billedUsage).toBeUndefined();
    });
});

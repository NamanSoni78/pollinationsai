import { UpstreamError } from "@shared/error.ts";
import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { assertNonEmptyMedia } from "../../src/image/handler.ts";

function capture(fn: () => void): unknown {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return undefined;
}

describe("assertNonEmptyMedia post-paid settlement", () => {
    it("settles the model's reported usage when the buffer is empty", () => {
        const error = capture(() =>
            assertNonEmptyMedia(Buffer.alloc(0), "Image provider", {
                promptImageTokens: 3,
                completionImageTokens: 1,
            }),
        ) as UpstreamError;
        expect(error).toBeInstanceOf(UpstreamError);
        expect(error.status).toBe(502);
        expect(error.message).toBe("Image provider returned an empty response");
        expect(error.billedUsage).toEqual({
            promptImageTokens: 3,
            completionImageTokens: 1,
        });
    });

    it("falls back to one completion token when the model reported no usage", () => {
        const error = capture(() =>
            assertNonEmptyMedia(Buffer.alloc(0), "Video provider", undefined),
        ) as UpstreamError;
        expect(error).toBeInstanceOf(UpstreamError);
        expect(error.billedUsage).toEqual({ completionImageTokens: 1 });
    });

    it("passes a non-empty buffer through without throwing", () => {
        expect(
            capture(() =>
                assertNonEmptyMedia(
                    Buffer.from([1, 2, 3]),
                    "Image provider",
                    undefined,
                ),
            ),
        ).toBeUndefined();
    });
});

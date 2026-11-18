import { afterEach, describe, expect, it, vi } from "vitest";
import {
    buildImageUrl,
    fetchAuthorizedImage,
    hasEmbeddedKey,
    persistableImage,
} from "./imageUrls.ts";

afterEach(() => vi.restoreAllMocks());

describe("image URL key hygiene", () => {
    it("builds image URLs without the API key", () => {
        const url = buildImageUrl("a dark forest, torchlight", {
            width: 1024,
            height: 768,
            seed: 1234,
        });
        expect(new URL(url).searchParams.has("key")).toBe(false);
        expect(new URL(url).searchParams.get("width")).toBe("1024");
        expect(new URL(url).searchParams.get("height")).toBe("768");
        expect(new URL(url).searchParams.get("model")).toBe("flux");
        expect(new URL(url).searchParams.get("seed")).toBe("1234");
        expect(url).toContain(encodeURIComponent("a dark forest, torchlight"));
    });

    it("sends the API key in the Authorization header, never in the URL", async () => {
        const fetchMock = vi.fn(async () => new Response("image-bytes"));
        vi.stubGlobal("fetch", fetchMock);
        // Node has no URL.createObjectURL; stand in for the browser API.
        const createObjectURL = vi.fn(() => "blob:session-image");
        const descriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
        Object.defineProperty(URL, "createObjectURL", {
            value: createObjectURL,
            configurable: true,
            writable: true,
        });

        try {
            const url = buildImageUrl("a dragon", { width: 512, height: 512 });
            const result = await fetchAuthorizedImage(url, "sk_test");

            expect(new URL(url).searchParams.has("key")).toBe(false);
            expect(fetchMock).toHaveBeenCalledWith(url, {
                headers: { Authorization: "Bearer sk_test" },
            });
            expect(result).toBe("blob:session-image");
        } finally {
            vi.unstubAllGlobals();
            if (descriptor) Object.defineProperty(URL, "createObjectURL", descriptor);
            else delete (URL as { createObjectURL?: unknown }).createObjectURL;
        }
    });

    it("refuses to persist keyed and session-only image URLs", () => {
        expect(
            persistableImage(
                "https://gen.pollinations.ai/image/x?model=flux&key=sk_secret",
            ),
        ).toBe("");
        expect(persistableImage("blob:session-image")).toBe("");
        expect(
            persistableImage("https://media.pollinations.ai/id/abc.png"),
        ).toBe("https://media.pollinations.ai/id/abc.png");
        expect(persistableImage("")).toBe("");
        expect(persistableImage(undefined)).toBe("");
    });

    it("detects legacy keyed URLs anywhere in a save", () => {
        expect(hasEmbeddedKey("https://x/i.png?width=1&key=sk_secret")).toBe(
            true,
        );
        expect(hasEmbeddedKey("https://x/i.png?key=sk_secret&width=1")).toBe(
            true,
        );
        expect(hasEmbeddedKey("https://x/i.png?width=1&height=1")).toBe(false);
    });
});

import {
    fetchValidatedUserMedia,
    MAX_USER_MEDIA_REDIRECTS,
    UserMediaRedirectError,
    UserMediaTooManyRedirectsError,
    validateUserMediaUrl,
} from "@shared/user-media-url.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
    vi.restoreAllMocks();
});

function redirectResponse(location: string): Response {
    return new Response(null, {
        status: 302,
        headers: { location },
    });
}

describe("validateUserMediaUrl (policy baseline)", () => {
    it("refuses loopback, private and literal-IP hosts directly", () => {
        for (const url of [
            "http://127.0.0.1/",
            "http://10.0.0.1/",
            "http://93.184.216.34/",
            "http://localhost/",
            "file:///etc/passwd",
        ]) {
            expect(validateUserMediaUrl(url).ok).toBe(false);
        }
        expect(validateUserMediaUrl("https://example.com/x").ok).toBe(true);
    });
});

describe("fetchValidatedUserMedia", () => {
    it("returns a non-redirect response untouched", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockResolvedValue(new Response("payload", { status: 200 }));
        const response = await fetchValidatedUserMedia(
            new URL("https://example.com/media.png"),
        );
        expect(await response.text()).toBe("payload");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][1]).toMatchObject({
            redirect: "manual",
        });
    });

    it("follows a redirect to a public host (shortener UX preserved)", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (input) => {
                const url = String(input);
                if (url === "https://short.example/x")
                    return redirectResponse("https://cdn.example/real.png");
                return new Response("image-bytes", { status: 200 });
            });

        const response = await fetchValidatedUserMedia(
            new URL("https://short.example/x"),
        );
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("image-bytes");
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(String(fetchSpy.mock.calls[1][0])).toBe(
            "https://cdn.example/real.png",
        );
    });

    it("refuses a redirect hop to a loopback destination", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (input) => {
                const url = String(input);
                if (url === "https://attacker.example/r")
                    return redirectResponse("http://127.0.0.1:8080/admin");
                throw new Error("must not be reached");
            });

        const thrown = await fetchValidatedUserMedia(
            new URL("https://attacker.example/r"),
        ).catch((cause) => cause);

        expect(thrown).toBeInstanceOf(UserMediaRedirectError);
        expect(thrown.target).toEqual(new URL("http://127.0.0.1:8080/admin"));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("refuses a redirect hop to the cloud metadata address", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = String(input);
            if (url === "https://attacker.example/m")
                return redirectResponse("http://169.254.169.254/latest/");
            throw new Error("must not be reached");
        });

        const thrown = await fetchValidatedUserMedia(
            new URL("https://attacker.example/m"),
        ).catch((cause) => cause);
        expect(thrown).toBeInstanceOf(UserMediaRedirectError);
        expect(thrown.reason).toBe("private");
    });

    it("refuses a redirect hop to a non-HTTP protocol", async () => {
        vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
            redirectResponse("file:///etc/passwd"),
        );

        const thrown = await fetchValidatedUserMedia(
            new URL("https://attacker.example/f"),
        ).catch((cause) => cause);
        expect(thrown).toBeInstanceOf(UserMediaRedirectError);
        expect(thrown.reason).toBe("protocol");
    });

    it("resolves relative redirect targets against the current hop", async () => {
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (input) => {
                const url = String(input);
                if (url === "https://example.com/a")
                    return redirectResponse("/b");
                return new Response("ok", { status: 200 });
            });

        const response = await fetchValidatedUserMedia(
            new URL("https://example.com/a"),
        );
        expect(response.status).toBe(200);
        expect(String(fetchSpy.mock.calls[1][0])).toBe("https://example.com/b");
    });

    it(`caps the chain at ${MAX_USER_MEDIA_REDIRECTS} hops`, async () => {
        let hops = 0;
        vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
            hops += 1;
            return redirectResponse(`/hop/${hops}`);
        });

        const thrown = await fetchValidatedUserMedia(
            new URL("https://example.com/loop"),
        ).catch((cause) => cause);
        expect(thrown).toBeInstanceOf(UserMediaTooManyRedirectsError);
        expect(hops).toBe(MAX_USER_MEDIA_REDIRECTS + 1);
    });

    it("surfaces a 3xx without a location as-is", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            new Response(null, { status: 304 }),
        );
        const response = await fetchValidatedUserMedia(
            new URL("https://example.com/none"),
        );
        expect(response.status).toBe(304);
    });
});

describe("downloadUserImage (image path, default redirect mode)", () => {
    it("refuses a shortener that bounces to a loopback destination", async () => {
        const { downloadUserImage } = await import(
            "../src/image/utils/imageDownload.ts"
        );
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (input) => {
                const url = String(input);
                if (url === "https://short.example/loop")
                    return redirectResponse("http://127.0.0.1:55288/api/keys");
                throw new Error("must not be reached");
            });

        const error = await downloadUserImage(
            "https://short.example/loop",
        ).catch((cause) => cause);
        expect(error).toMatchObject({
            errorCode: "invalid_image_url",
        });
        expect(String(error.message)).toContain("127.0.0.1");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("still follows a redirect to a public CDN host", async () => {
        const { downloadUserImage } = await import(
            "../src/image/utils/imageDownload.ts"
        );
        vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
            const url = String(input);
            if (url === "https://short.example/ok")
                return redirectResponse("https://cdn.example/real.png");
            return new Response(new Uint8Array([1, 2, 3]), {
                status: 200,
                headers: { "content-type": "image/png" },
            });
        });

        const { buffer, mimeType } = await downloadUserImage(
            "https://short.example/ok",
        );
        expect(mimeType).toBe("image/png");
        expect(buffer.byteLength).toBe(3);
    });
});

describe("fetchUserImage (strict manual mode)", () => {
    it("still refuses redirects outright", async () => {
        const { fetchUserImage } = await import("../src/userImage.ts");
        vi.spyOn(globalThis, "fetch").mockResolvedValue(
            redirectResponse("https://cdn.example/real.png"),
        );
        const error = await fetchUserImage("https://example.com/x", {
            redirect: "manual",
        }).catch((cause) => cause);
        expect(error).toMatchObject({ errorCode: "invalid_image_url" });
    });
});

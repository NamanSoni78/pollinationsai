import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import {
    IMAGE_JSON_BODY_LIMIT_BYTES,
    imageJsonBodyLimit,
} from "../../src/routes/generation-handlers.js";

function contextFor(headers: Record<string, string>) {
    const rawHeaders = new Headers(headers);
    return {
        req: {
            header: (name: string) => rawHeaders.get(name.toLowerCase()),
            raw: { headers: rawHeaders },
        },
    };
}

async function run(headers: Record<string, string>) {
    const next = vi.fn();
    const thrown = await imageJsonBodyLimit(
        contextFor(headers) as never,
        next,
    ).then(
        () => undefined,
        (error: unknown) => error,
    );
    return { thrown, next };
}

describe("imageJsonBodyLimit", () => {
    it("rejects a declared JSON body over the 52 MiB limit", async () => {
        const { thrown, next } = await run({
            "content-type": "application/json",
            "content-length": String(IMAGE_JSON_BODY_LIMIT_BYTES + 1),
        });
        expect(thrown).toBeInstanceOf(HTTPException);
        expect((thrown as HTTPException).status).toBe(413);
        expect((thrown as HTTPException).message).toBe(
            "JSON request body exceeds the 52 MiB limit",
        );
        expect(next).not.toHaveBeenCalled();
    });

    it("allows a declared JSON body exactly at the limit", async () => {
        const { thrown, next } = await run({
            "content-type": "application/json",
            "content-length": String(IMAGE_JSON_BODY_LIMIT_BYTES),
        });
        expect(thrown).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
    });

    it("leaves non-JSON bodies to their own limits", async () => {
        const { thrown, next } = await run({
            "content-type": "multipart/form-data; boundary=x",
            "content-length": String(IMAGE_JSON_BODY_LIMIT_BYTES + 1024),
        });
        expect(thrown).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
    });

    it("lets chunked JSON bodies through to the post-parse caps", async () => {
        const { thrown, next } = await run({
            "content-type": "application/json",
        });
        expect(thrown).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
    });

    it("ignores a malformed content-length", async () => {
        const { thrown, next } = await run({
            "content-type": "application/json",
            "content-length": "not-a-number",
        });
        expect(thrown).toBeUndefined();
        expect(next).toHaveBeenCalledOnce();
    });
});

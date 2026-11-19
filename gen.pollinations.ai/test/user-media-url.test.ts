import { describe, expect, it } from "vitest";
import { validateUserMediaUrl } from "@shared/user-media-url.ts";

// RFC 6761: resolvers answer the absolute form "localhost." with the
// loopback. WHATWG URL keeps the root dot in the hostname, so the validator
// must canonicalize before matching its blocked-name rules.
describe("user-media URL policy: absolute-name canonicalization", () => {
    it.each([
        "http://localhost./x",
        "http://foo.localhost./x",
        "https://LOCALHOST./y",
        "https://FOO.LOCALHOST./y",
    ])("blocks loopback names with a trailing root dot %s", (value) => {
        expect(validateUserMediaUrl(value)).toMatchObject({ ok: false });
    });
    it.each([
        "http://localhost/x",
        "http://foo.localhost/x",
        "http://127.0.0.1/x",
        "http://127.0.0.1./x",
        "http://[::1]/x",
    ])("still blocks the canonical loopback and literal forms %s", (value) => {
        expect(validateUserMediaUrl(value)).toMatchObject({ ok: false });
    });
    it.each([
        "https://example.com./x",
        "https://example.com/x",
        "http://sub.example.com./a",
    ])("still allows public absolute names %s", (value) => {
        expect(validateUserMediaUrl(value)).toMatchObject({ ok: true });
    });
});

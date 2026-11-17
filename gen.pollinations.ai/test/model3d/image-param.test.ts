import { DEFAULT_3D_MODEL } from "@shared/registry/model3d.ts";
import { describe, expect, it } from "vitest";
import { Model3dParamsSchema } from "@/model3d/params.ts";
import { Generate3dRequestQueryParamsSchema } from "@/schemas/model3d.ts";

describe.each([
    ["3d query", Generate3dRequestQueryParamsSchema],
    ["3d runtime", Model3dParamsSchema],
] as const)("%s image param", (_name, schema) => {
    const parseImage = (image: string) =>
        schema.parse({ model: DEFAULT_3D_MODEL, image }).image;

    it("keeps commas inside a single reference URL", () => {
        const url =
            "https://res.cloudinary.com/demo/image/upload/w_512,h_512/sample.jpg";
        expect(parseImage(url)).toEqual([url]);
    });

    it("still splits comma- and pipe-separated URLs", () => {
        expect(
            parseImage(
                "https://a.example/1.png, https://b.example/w_1,h_2.png",
            ),
        ).toEqual(["https://a.example/1.png", "https://b.example/w_1,h_2.png"]);
        expect(
            parseImage("https://a.example/1,2.png|https://b.example/2.png"),
        ).toEqual(["https://a.example/1,2.png", "https://b.example/2.png"]);
    });
});

describe("3d runtime image param URL policy", () => {
    const parseImage = (image: unknown) =>
        Model3dParamsSchema.parse({ model: DEFAULT_3D_MODEL, image }).image;

    it("accepts public HTTP(S) reference URLs", () => {
        expect(parseImage("https://example.com/ref.jpg")).toEqual([
            "https://example.com/ref.jpg",
        ]);
    });

    it("rejects loopback, private and literal-IP reference URLs", () => {
        for (const url of [
            "http://127.0.0.1:8080/admin",
            "http://10.0.0.5/internal",
            "http://169.254.169.254/latest/meta-data/",
            "http://localhost/x.png",
            "file:///etc/passwd",
            "https://user:pass@example.com/ref.jpg",
        ]) {
            const result = Model3dParamsSchema.safeParse({
                model: DEFAULT_3D_MODEL,
                image: url,
            });
            expect(result.success).toBe(false);
            if (!result.success) {
                expect(result.error.issues[0].message).toBe(
                    "Reference images must use public HTTP(S) URLs without credentials or literal IP hosts.",
                );
            }
        }
    });

    it("rejects a private URL mixed into a valid list", () => {
        const result = Model3dParamsSchema.safeParse({
            model: DEFAULT_3D_MODEL,
            image: ["https://example.com/ok.png", "http://192.168.1.4/x.png"],
        });
        expect(result.success).toBe(false);
    });
});

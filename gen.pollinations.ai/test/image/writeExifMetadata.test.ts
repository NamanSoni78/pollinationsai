import { load, TagValues } from "piexif-ts";
import { describe, expect, it } from "vitest";
import { writeExifMetadata } from "../../src/image/writeExifMetadata.ts";

// 1x1 white JPEG (base64 encoded), minimum valid input piexif's segment parser accepts.
const MINIMAL_JPEG = Buffer.from(
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wgARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH8AP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Af//Z",
    "base64",
);

describe("writeExifMetadata", () => {
    it("writes Make and UserComment to a JPEG", async () => {
        const params = { model: "flux", prompt: "a cat", width: 512 };
        const maturity = { isMature: false, isChild: false };

        const out = await writeExifMetadata(MINIMAL_JPEG, params, maturity);

        let bin = "";
        for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
        const exif = load(bin);

        expect(exif["0th"]?.[TagValues.ImageIFD.Make]).toBe("flux");
        const userComment = exif.Exif?.[
            TagValues.ExifIFD.UserComment
        ] as string;
        expect(userComment).toBeTruthy();
        expect(JSON.parse(userComment)).toMatchObject({
            model: "flux",
            prompt: "a cat",
            isMature: false,
        });
    });

    it("returns the original buffer for non-JPEG input", async () => {
        const png = Buffer.from([
            0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
        ]);
        const out = await writeExifMetadata(png, { model: "x" }, {});
        expect(out).toEqual(png);
    });
});

describe("writeExifMetadata embedding limits", () => {
    it("never embeds caller-supplied input media URLs", async () => {
        const params = {
            model: "flux",
            prompt: "a cat",
            image: [
                "https://private.example/signed.png?token=SECRET-SIGNED-URL-TOKEN",
            ],
            reference_images: ["https://private.example/ref.png?sig=abc123"],
            reference_videos: ["https://private.example/ref.mp4?sig=def456"],
            reference_audios: ["https://private.example/ref.mp3?sig=ghi789"],
        };

        const out = await writeExifMetadata(MINIMAL_JPEG, params, {});

        let bin = "";
        for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
        const exif = load(bin);
        const userComment = exif.Exif?.[
            TagValues.ExifIFD.UserComment
        ] as string;

        expect(userComment).not.toContain("SECRET-SIGNED-URL-TOKEN");
        expect(userComment).not.toContain("ref.png");
        expect(userComment).not.toContain("ref.mp4");
        expect(userComment).not.toContain("ref.mp3");
        expect(userComment).not.toContain("private.example");
        expect(JSON.parse(userComment)).toMatchObject({
            model: "flux",
            prompt: "a cat",
        });
    });

    it("caps the embedded payload for a 32k-character prompt", async () => {
        const hugePrompt = "A".repeat(32_000);
        const out = await writeExifMetadata(
            MINIMAL_JPEG,
            {
                model: "flux",
                prompt: hugePrompt,
                originalPrompt: hugePrompt,
            },
            { isMature: false },
        );

        let bin = "";
        for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
        const exif = load(bin);
        const userComment = exif.Exif?.[
            TagValues.ExifIFD.UserComment
        ] as string;

        // Pre-fix this embedded the full 32k prompt (and hosted it verbatim on
        // the public media cache); now it is a truncated, still-parseable
        // provenance object.
        expect(userComment.length).toBeLessThanOrEqual(4_096);
        const parsed = JSON.parse(userComment) as { prompt: string };
        expect(parsed.prompt.length).toBeLessThanOrEqual(1_001);
        expect(parsed.prompt.startsWith("AAAA")).toBe(true);
    });

    it("keeps ordinary prompts intact", async () => {
        const out = await writeExifMetadata(
            MINIMAL_JPEG,
            { model: "flux", prompt: "a watercolor lighthouse at dawn" },
            {},
        );
        let bin = "";
        for (let i = 0; i < out.length; i++) bin += String.fromCharCode(out[i]);
        const exif = load(bin);
        const userComment = exif.Exif?.[
            TagValues.ExifIFD.UserComment
        ] as string;
        expect(JSON.parse(userComment)).toMatchObject({
            prompt: "a watercolor lighthouse at dawn",
        });
    });
});

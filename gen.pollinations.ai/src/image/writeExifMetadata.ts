import debug from "debug";
import { dump, type IExif, insert, TagValues } from "piexif-ts";

const logPerf = debug("pollinations:perf");

/**
 * Cap on the JSON payload embedded in the output image's EXIF UserComment.
 * The comment rides along on every copy of the image, including the
 * publicly-readable media-cache object, so it must not become an arbitrary
 * high-volume content channel: request prompts are allowed up to 32k
 * characters, and every one of them would otherwise be hosted verbatim (and
 * kept alive indefinitely by the TTL refresh on read). Provenance only needs
 * a preview of the prompt plus the bounded generation parameters.
 */
const MAX_EXIF_USER_COMMENT_CHARS = 4_096;

/** Prompt fields are truncated to this length before the final backstop cap. */
const MAX_EXIF_PROMPT_CHARS = 1_000;

/**
 * Caller-supplied input media URLs. They can carry signed-URL credentials in
 * the query string and have no provenance value for the output image, so they
 * are never embedded.
 */
const EXIF_OMITTED_INPUT_URL_FIELDS = [
    "image",
    "reference_images",
    "reference_videos",
    "reference_audios",
] as const;

function buildUserComment(safeParams: object, resultMetadata: object): string {
    const params = safeParams as Record<string, unknown>;
    const embeddable = Object.fromEntries(
        Object.entries(params).filter(
            ([key]) =>
                !(EXIF_OMITTED_INPUT_URL_FIELDS as readonly string[]).includes(
                    key,
                ),
        ),
    );
    const truncate = (value: unknown): unknown =>
        typeof value === "string" && value.length > MAX_EXIF_PROMPT_CHARS
            ? `${value.slice(0, MAX_EXIF_PROMPT_CHARS)}…`
            : value;
    const comment = JSON.stringify({
        ...embeddable,
        prompt: truncate(embeddable.prompt),
        originalPrompt: truncate(embeddable.originalPrompt),
        ...resultMetadata,
    });
    if (comment.length <= MAX_EXIF_USER_COMMENT_CHARS) return comment;
    // Backstop for pathological parameter sets: cut the serialization and
    // mark it, rather than exceeding the embedded-payload budget.
    return `${comment.slice(0, MAX_EXIF_USER_COMMENT_CHARS - 1)}…`;
}

export async function writeExifMetadata(
    buffer: Buffer,
    safeParams: object,
    resultMetadata: object,
): Promise<Buffer> {
    const startTime = Date.now();
    try {
        let binaryString = "";
        for (let i = 0; i < buffer.length; i++) {
            binaryString += String.fromCharCode(buffer[i]);
        }

        const params = safeParams as Record<string, unknown>;
        const model = typeof params.model === "string" ? params.model : "";

        const exifObj: IExif = {
            "0th": {
                [TagValues.ImageIFD.Make]: model,
            },
            Exif: {
                [TagValues.ExifIFD.UserComment]: buildUserComment(
                    safeParams,
                    resultMetadata,
                ),
            },
        };

        const exifBytes = dump(exifObj);
        const newBinaryString = insert(exifBytes, binaryString);

        const newBuffer = Buffer.alloc(newBinaryString.length);
        for (let i = 0; i < newBinaryString.length; i++) {
            newBuffer[i] = newBinaryString.charCodeAt(i);
        }

        logPerf(`EXIF writing duration: ${Date.now() - startTime}ms`);
        return newBuffer;
    } catch (err) {
        logPerf(`EXIF writing skipped (${Date.now() - startTime}ms): ${err}`);
        return buffer;
    }
}

import { UpstreamError } from "@shared/error.ts";
import { fetchUserImage, MAX_IMAGE_SIZE } from "../../userImage.ts";
import { arrayBufferToBase64 } from "../../util.ts";
import type { TransformFn } from "../types.ts";

/**
 * Video MIME types as the Portkey Bedrock adapter names them: it turns a
 * `file` part into a Converse `video` block only for these, using the subtype
 * as the Converse `format`. Standard names map onto them.
 */
const BEDROCK_VIDEO_TYPES: Record<string, string> = {
    "video/mp4": "video/mp4",
    "video/quicktime": "video/mov",
    "video/mov": "video/mov",
    "video/x-matroska": "video/mkv",
    "video/mkv": "video/mkv",
    "video/webm": "video/webm",
    "video/x-flv": "video/flv",
    "video/flv": "video/flv",
    "video/mpeg": "video/mpeg",
    "video/mpg": "video/mpg",
    "video/x-ms-wmv": "video/wmv",
    "video/wmv": "video/wmv",
};

/**
 * Bedrock Converse accepts a single inline video per request: the Nova model
 * docs publish "Number of objects: 1" for embedded video (both Nova
 * generations), so a second video part is a guaranteed provider 400 — and,
 * before this cap, one more sequential server-side fetch the caller controls.
 * Video parts are counted nowhere else (the capability check counts only
 * image_url/input_image), so this transform is the place the limit lives.
 */
const MAX_BEDROCK_VIDEOS = 1;

/**
 * AWS caps an inline video payload at 25 MB including the base64 encoding:
 * 18.75 MB of raw bytes become 25 MB once encoded, so a larger download
 * could only ever fail at the provider after the bytes were spent.
 */
const MAX_BEDROCK_VIDEO_BYTES = 18_750_000;

function badRequest(message: string): never {
    throw new UpstreamError(400, { message });
}

type VideoPart = {
    type: "video_url";
    video_url?: { url?: unknown; mime_type?: unknown } | null;
};

async function videoToFile(part: VideoPart, budget: { bytes: number }) {
    const { url, mime_type } = part.video_url ?? {};
    if (typeof url !== "string") {
        badRequest(
            "Invalid video part: video_url.url must be a URL string or data URI.",
        );
    }
    if (mime_type !== undefined && typeof mime_type !== "string") {
        badRequest("Invalid video part: video_url.mime_type must be a string.");
    }
    const { bytes, mimeType } = await fetchUserImage(url, {
        maxBytes: Math.min(budget.bytes, MAX_BEDROCK_VIDEO_BYTES),
        redirect: "manual",
    });
    budget.bytes -= bytes.byteLength;
    const declared = (mime_type ?? mimeType).split(";")[0].trim().toLowerCase();
    const bedrockType = BEDROCK_VIDEO_TYPES[declared];
    if (!bedrockType) {
        badRequest(
            `Unsupported video format ${declared}: expected MP4, MOV, MKV, WebM, FLV, MPEG or WMV.`,
        );
    }
    return {
        type: "file",
        file: { file_data: arrayBufferToBase64(bytes), mime_type: bedrockType },
    };
}

/**
 * Bedrock Converse takes video as inline bytes, which Portkey builds from a
 * `file` part. Without this, `video_url` parts are dropped on the way and the
 * model answers as if no video was sent. The gateway's Bedrock adapter has no
 * audio mapping, so audio is refused instead of being dropped the same way.
 */
export const mediaToBedrock: TransformFn = async (messages, options) => {
    const budget = { bytes: MAX_IMAGE_SIZE, videos: 0 };
    const processed = [];
    for (const message of messages) {
        if (!Array.isArray(message.content)) {
            processed.push(message);
            continue;
        }
        const content = [];
        for (const part of message.content) {
            const type = (part as { type?: string } | null)?.type;
            if (type === "input_audio") {
                badRequest(
                    "This model does not support audio input. Use a model with audio in its input_modalities.",
                );
            }
            if (type === "video_url") {
                budget.videos += 1;
                if (budget.videos > MAX_BEDROCK_VIDEOS) {
                    badRequest(
                        `This model supports at most ${MAX_BEDROCK_VIDEOS} video${MAX_BEDROCK_VIDEOS === 1 ? "" : "s"} per request.`,
                    );
                }
                content.push(await videoToFile(part as VideoPart, budget));
            } else {
                content.push(part);
            }
        }
        processed.push({ ...message, content });
    }
    return { messages: processed, options };
};

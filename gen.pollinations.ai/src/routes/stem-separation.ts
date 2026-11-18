import {
    errorResponseDescriptions,
    mediaResponseHeaders,
} from "@shared/utils/api-docs.ts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { describeRoute } from "hono-openapi";
import {
    handleStemSeparation,
    STEM_VARIATIONS,
} from "../audio/stem-separation.ts";
import type { Env } from "../env.ts";
import { auth } from "../middleware/auth.ts";
import { balance } from "../middleware/balance.ts";
import { prepareGenerationRequest } from "../middleware/generation-cache.ts";
import { deduplicateGeneration } from "../middleware/generation-deduplication.ts";
import { audioCache } from "../middleware/media-cache.ts";
import { resolveModel } from "../middleware/model.ts";
import { edgeRateLimit } from "../middleware/rate-limit-edge.ts";
import { track } from "../middleware/track.ts";
import {
    apiKeyBudgetReservation,
    generationAccess,
} from "../utils/generation-access.ts";

const STEM_UPLOAD_BODY_LIMIT_BYTES = 52 * 1024 * 1024;

/**
 * Pre-parse cap for the stem-separation upload. This router is mounted
 * separately from the audio routes, and its request body is fully buffered
 * by `resolveModel` and `prepareGenerationRequest` before `generationAccess`
 * can reject an anonymous request, so an un-gated body kills the shared
 * isolate long before the documented 50 MB file check inside the handler.
 * The cap mirrors the family precedent (52 MiB multipart envelope, 32 MiB
 * JSON ceilings on other routes) and, unlike a content-length-only gate,
 * hono's `bodyLimit` also enforces the ceiling on streamed bodies that
 * arrive without a declaration.
 */
export const stemBodyLimit = bodyLimit({
    maxSize: STEM_UPLOAD_BODY_LIMIT_BYTES,
    onError: () => {
        throw new HTTPException(413, {
            message: "Request body exceeds the 52 MiB limit",
        });
    },
});

export const stemSeparationRoutes = new Hono<Env>()
    .use("/alpha/audio/stem-separation", edgeRateLimit)
    .use("/alpha/audio/stem-separation", stemBodyLimit)
    .use("/alpha/audio/stem-separation", auth(), balance)
    .post(
        "/alpha/audio/stem-separation",
        describeRoute({
            tags: ["🔊 Audio"],
            summary: "Separate Audio Stems",
            description:
                "Separate an uploaded audio file into vocals and instrumental, or vocals, drums, bass, guitar, piano, and other. Returns a ZIP of stereo 44.1 kHz MP3 files at 128 kbps. Pricing uses input duration and the selected stem variation; see /audio/models. This native alpha endpoint has no OpenAI-compatible equivalent; its request and response may change.",
            requestBody: {
                required: true,
                content: {
                    "multipart/form-data": {
                        schema: {
                            type: "object",
                            required: ["file"],
                            properties: {
                                model: {
                                    type: "string",
                                    default: "elevenlabs/stem-separation",
                                },
                                file: {
                                    type: "string",
                                    format: "binary",
                                    description:
                                        "Source audio, up to 50 MB, with a readable duration.",
                                },
                                stem_variation_id: {
                                    type: "string",
                                    enum: [...STEM_VARIATIONS],
                                    default: "six_stems_v1",
                                },
                            },
                        },
                    },
                },
            },
            responses: {
                200: {
                    description: "ZIP containing the separated MP3 tracks",
                    headers: mediaResponseHeaders,
                    content: {
                        "application/zip": {
                            schema: { type: "string", format: "binary" },
                        },
                    },
                },
                ...errorResponseDescriptions(400, 401, 402, 403, 413, 500, 502),
            },
        }),
        resolveModel("generate.audio", {
            defaultModel: "elevenlabs/stem-separation",
            supportedEndpoint: "/alpha/audio/stem-separation",
        }),
        track("generate.audio"),
        prepareGenerationRequest,
        audioCache,
        generationAccess,
        deduplicateGeneration,
        apiKeyBudgetReservation,
        handleStemSeparation,
    );

import {
    getDefaultErrorMessage,
    remapUpstreamStatus,
    UpstreamError,
} from "@shared/error.ts";
import { ValidationError } from "@shared/http/validation-error.ts";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
    CONTENT_POLICY_STATUS,
    isContentPolicyViolation,
} from "../image/utils/contentModeration.ts";
import type { ServiceError } from "./types.js";

function serializeDetails(details: unknown): string | undefined {
    if (details === undefined || details === null) return undefined;
    return typeof details === "string" ? details : JSON.stringify(details);
}

/** Classify provider errors consistently for HTTP responses and stream metrics. */
export function apiErrorStatus(details: unknown, status: number): number {
    // Classify the provider's error, not echoed request data beside it. Keep
    // nested diagnostics such as OpenRouter's error.metadata.raw available.
    if (details && typeof details === "object" && "error" in details) {
        details = details.error;
    }
    const serialized = serializeDetails(details) ?? "";
    if (isContentPolicyViolation(serialized)) return CONTENT_POLICY_STATUS;
    if (
        /no endpoints found that support (?:image|audio|video) input|multimodal processing failed|(?:image|audio) decode error|invalid or unsupported audio file|failed to load image|cannot identify image file|image URL must be a valid and downloadable URL or look like data:|Tool call id was [^\r\n]* but must be a-z, A-Z, 0-9, with a length of 9\./i.test(
            serialized,
        )
    )
        return 400;
    return remapUpstreamStatus(status);
}

export function throwTextError(error: ServiceError): never {
    // Preserve local refusals and already classified upstream errors, including
    // their status, remedy links, and the type used by text notices.
    if (error instanceof HTTPException || error instanceof ValidationError)
        throw error;
    const status =
        typeof error.status === "number"
            ? error.status
            : typeof error.code === "number"
              ? error.code
              : 500;

    throw new UpstreamError(status as ContentfulStatusCode, {
        // A community attempt's message is redacted only when it is
        // upstream-derived (the publisher's error text, headers, or network
        // failure, which can name their infrastructure): answer with the
        // gateway default instead. Gateway-authored messages — thrown as
        // UpstreamError/HTTPException above, or flagged as our own — keep
        // their actionable diagnostics.
        message:
            error.redactUpstream === true && error.upstreamMessage === true
                ? getDefaultErrorMessage(status as ContentfulStatusCode)
                : error.message || "Text generation failed",
        // Propagate only — the code is decided at the throw site.
        errorCode: error.errorCode,
        requestUrl: error.requestUrl,
        upstreamStatus: error.upstreamStatus,
        responseBody:
            error.responseBody ??
            serializeDetails(error.details || error.response?.data),
        upstreamHeaders: error.upstreamHeaders,
        // Community-endpoint attempts keep the publisher's diagnostics out of
        // the client response; the flag comes from the community pipeline.
        redactUpstream: error.redactUpstream,
        cause: error,
    });
}

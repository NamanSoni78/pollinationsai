import { MAX_COMMUNITY_TEXT_RESPONSE_BYTES } from "@shared/community-endpoints.ts";
import { readResponseText } from "@shared/response-bytes.ts";
import type {
    ChatCompletion,
    ChatMessage,
    ServiceError,
    TransformOptions,
} from "../types.js";
import { chatToResponsesRequest } from "./chatRequest.js";
import {
    responsesToChatCompletion,
    streamingChatCompletion,
} from "./chatResponse.js";
import { callDirectResponses, responsesTargetFromConfig } from "./client.js";

function clientError(
    message: string,
    status = 500,
    requestUrl?: URL,
): ServiceError {
    const error = new Error(message) as ServiceError;
    error.status = status;
    error.requestUrl = requestUrl;
    return error;
}

// Community endpoints are untrusted servers; their buffered bodies are capped.
function communityBodyTooLarge(total: number): ServiceError {
    return clientError(
        `Community endpoint response is too large (${total} bytes)`,
        502,
    );
}

/** Call a native Responses provider while preserving the public Chat contract. */
export async function callChatViaResponses(
    messages: ChatMessage[],
    options: TransformOptions,
    fetcher: typeof fetch = fetch,
): Promise<ChatCompletion> {
    const model = options.model;
    if (!model) throw clientError("Model is required");

    const target = responsesTargetFromConfig(model, options.modelConfig ?? {});
    if (!target) {
        throw clientError(
            `Responses endpoint is not configured for model ${model}`,
        );
    }

    const request = chatToResponsesRequest(messages, options);
    const { response, requestUrl } = await callDirectResponses(
        request,
        target,
        fetcher,
    );

    if (request.stream) {
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
            throw clientError(
                `Responses provider returned non-stream content-type: ${contentType}`,
                502,
                requestUrl,
            );
        }
        return streamingChatCompletion(
            response.body as ReadableStream<Uint8Array<ArrayBuffer>>,
            model,
            requestUrl,
        );
    }

    let data: unknown;
    const bodyText = target.communityEndpoint
        ? await readResponseText(
              response,
              MAX_COMMUNITY_TEXT_RESPONSE_BYTES,
              communityBodyTooLarge,
          )
        : null;
    try {
        data = bodyText === null ? await response.json() : JSON.parse(bodyText);
    } catch (cause) {
        const error = clientError(
            "Responses provider returned invalid JSON",
            502,
            requestUrl,
        );
        error.details = cause;
        throw error;
    }
    return responsesToChatCompletion(data, model, requestUrl);
}

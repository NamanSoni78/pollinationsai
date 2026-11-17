import {
    AGENT_RUN_TOKEN_TTL_SECONDS,
    signAgentRunToken,
} from "@shared/auth/agent-run-token.ts";
import {
    type CommunityEndpointRuntime,
    COMMUNITY_ENDPOINT_TIMEOUT_MS,
    isFreeCommunityEndpoint,
    normalizeCommunityEndpointBearerToken,
    usesAgentRunToken,
} from "@shared/community-endpoints.ts";
import { MAX_COMMUNITY_MEDIA_RESPONSE_BYTES } from "@shared/community-media.ts";
import { UpstreamError } from "@shared/error.ts";
import type { ModelDefinition } from "@shared/registry/registry.ts";
import { decryptSecret } from "@shared/secret-encryption.ts";
import type { RequestData, TransformOptions } from "./types.js";

/**
 * A community endpoint is a self-hosted third-party server, not one of our
 * providers: image, embeddings and audio already bound their fetches to
 * COMMUNITY_ENDPOINT_TIMEOUT_MS, but the text path passed no signal at all,
 * so a wedged endpoint tarpitted the request until the platform's own
 * timeout kicked in. Every fetch this module originates carries the
 * community deadline; official providers are unaffected.
 */
export function communityEndpointFetch(
    input: string,
    init?: RequestInit,
): Promise<Response> {
    return fetch(input, {
        ...init,
        signal: AbortSignal.timeout(COMMUNITY_ENDPOINT_TIMEOUT_MS),
    }).then((response) => capCommunityEndpointResponse(response));
}

function communityResponseTooLarge(total: number): UpstreamError {
    return UpstreamError.fromProvider(502, {
        message: `Community endpoint response is larger than ${MAX_COMMUNITY_MEDIA_RESPONSE_BYTES} bytes (saw ${total})`,
    });
}

/**
 * Bound how many bytes a community text response may buffer before the
 * JSON/SSE relay paths read it. Media endpoints already cap what a publisher
 * can return (MAX_COMMUNITY_MEDIA_RESPONSE_BYTES via readResponseBytes), but
 * the text clients buffered the whole upstream body: a publisher could relay
 * a 60–100 MB JSON or SSE stream — free while calling their own model — and
 * OOM the isolate that is also serving other callers. Content-Length is
 * checked first when present; the running total is enforced while streaming
 * because the header can be absent or wrong, and the underlying body is
 * cancelled so the endpoint cannot keep streaming into a request that has
 * already failed.
 */
function capCommunityEndpointResponse(response: Response): Response {
    const declared = Number.parseInt(
        response.headers.get("content-length") ?? "",
        10,
    );
    if (
        Number.isFinite(declared) &&
        declared > MAX_COMMUNITY_MEDIA_RESPONSE_BYTES
    ) {
        void response.body?.cancel().catch(() => {});
        throw communityResponseTooLarge(declared);
    }
    if (!response.body) return response;

    const reader = response.body.getReader();
    let total = 0;
    const capped = new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                    return;
                }
                total += value.byteLength;
                if (total > MAX_COMMUNITY_MEDIA_RESPONSE_BYTES) {
                    await reader.cancel().catch(() => {});
                    controller.error(communityResponseTooLarge(total));
                    return;
                }
                controller.enqueue(value);
            } catch (error) {
                controller.error(error);
            }
        },
        cancel(reason) {
            return reader.cancel(reason);
        },
    });
    return new Response(capped, response);
}

/**
 * The run token a delegating endpoint authenticates with, or undefined.
 *
 * Agent-style endpoints call back into the generation API on the caller's
 * behalf, so they need spend authority — but never the caller's own key. They
 * get a run token: short-lived, with the caller key's permissions, billed to it.
 *
 * It replaces the endpoint's saved bearer rather than riding alongside it, so a
 * delegating endpoint stays a plain OpenAI-compatible server with no
 * Pollinations-specific header to implement, and never holds a credential it
 * could spend as its own. It is not a weaker proof of origin than the static
 * secret it replaces: the endpoint can verify it against `/account/key`, which
 * a shared string cannot do.
 *
 * Every agent kind delegates and a proxy never does — the listing's type says
 * so, and no flag can make a proxy delegate. The other two conditions are
 * invariants, so they throw: the endpoint must be free, since charging a
 * wrapper price on top of the generation it bills the caller for is double
 * billing, and the request must carry a key to bill, since falling back to the
 * saved bearer would quietly move the cost of the agent's work onto the
 * endpoint owner.
 */
async function mintDelegatedToken({
    endpoint,
    parentApiKeyId,
    parentRunExpiresAt,
    parentRequestId,
    secret,
}: {
    endpoint: CommunityEndpointRuntime;
    parentApiKeyId: string | undefined;
    parentRunExpiresAt?: number;
    parentRequestId: string;
    secret: string;
}): Promise<string | undefined> {
    if (!usesAgentRunToken(endpoint)) return undefined;
    if (!isFreeCommunityEndpoint(endpoint)) {
        throw new Error(
            `Community endpoint '${endpoint.modelId}' delegates generation but is not free`,
        );
    }
    if (!parentApiKeyId) {
        throw new Error(
            `Community endpoint '${endpoint.modelId}' delegates generation but the request has no API key to bill`,
        );
    }
    // A token minted inside an agent run expires when that run does. Clock
    // skew can put that expiry just behind us (the run token is accepted for a
    // few seconds past it) or just over a full lifetime ahead, so the issue
    // time is clamped rather than the expiry moved.
    const now = Math.floor(Date.now() / 1000);
    const issuedAt =
        parentRunExpiresAt === undefined
            ? now
            : Math.min(
                  Math.max(
                      now,
                      parentRunExpiresAt - AGENT_RUN_TOKEN_TTL_SECONDS,
                  ),
                  parentRunExpiresAt - 1,
              );
    return signAgentRunToken({
        secret,
        parentApiKeyId,
        parentRequestId,
        // The managed runtime uses the listing id (also its upstream model) to
        // select the prompt config. An external agent only needs spend scope.
        managedAgentId:
            endpoint.type === "prompt_agent" || endpoint.type === "code_agent"
                ? endpoint.id
                : undefined,
        agentModelId: endpoint.modelId,
        now: issuedAt,
        expiresIn:
            parentRunExpiresAt === undefined
                ? undefined
                : parentRunExpiresAt - issuedAt,
    });
}

export async function communityEndpointGatewayContext({
    endpoint,
    modelDefinition,
    requestData,
    secret,
    portkeyGatewayUrl,
    userApiKey,
    parentRequestId,
    parentApiKeyId,
    parentRunExpiresAt,
}: {
    endpoint: CommunityEndpointRuntime;
    modelDefinition: ModelDefinition;
    requestData: RequestData;
    secret: string;
    portkeyGatewayUrl: string;
    userApiKey: string;
    parentRequestId: string;
    parentApiKeyId?: string;
    parentRunExpiresAt?: number;
}): Promise<TransformOptions> {
    const { messages: _messages, ...requestDataWithoutMessages } = requestData;
    const modelConfig = await communityEndpointModelConfig({
        endpoint,
        secret,
        parentRequestId,
        parentApiKeyId,
        parentRunExpiresAt,
    });
    return {
        ...requestDataWithoutMessages,
        modelConfig,
        modelDef: modelDefinition,
        requestedModel: endpoint.modelId,
        portkeyGatewayUrl,
        userApiKey,
    };
}

export async function communityEndpointModelConfig({
    endpoint,
    secret,
    parentRequestId,
    parentApiKeyId,
    parentRunExpiresAt,
}: {
    endpoint: CommunityEndpointRuntime;
    secret: string;
    parentRequestId: string;
    parentApiKeyId?: string;
    parentRunExpiresAt?: number;
}): Promise<Record<string, unknown>> {
    const runToken = await mintDelegatedToken({
        endpoint,
        parentApiKeyId,
        parentRunExpiresAt,
        parentRequestId,
        secret,
    });
    // Only a proxy stores and receives its registered upstream bearer secret.
    // Neither agent kind receives a Pollinations API key: each gets a
    // short-lived run token instead. mintDelegatedToken always returns one for
    // an agent, so a missing token means the caller had no key to bill.
    const authKey =
        endpoint.type === "proxy"
            ? normalizeCommunityEndpointBearerToken(
                  await decryptSecret(endpoint.bearerTokenCiphertext, secret),
              )
            : runToken;
    if (!authKey) throw new Error("Agent request has no agent run token");

    return {
        provider: "openai",
        authKey,
        model: endpoint.upstreamModel,
        ...(endpoint.api === "responses"
            ? { responsesEndpoint: endpoint.baseUrl }
            : { directEndpoint: endpoint.baseUrl }),
        // Only a proxy talks to an unvetted third-party server, so only a
        // proxy gets the deadline- and size-bound fetcher. Managed agents
        // run on in-repo clients that already own their transport and
        // billing, and their fetcher must keep winning over this one. The
        // chat path reads "fetcher", the responses adapter "responsesFetcher".
        ...(endpoint.type === "proxy" && endpoint.api === "responses"
            ? { responsesFetcher: communityEndpointFetch }
            : {}),
        ...(endpoint.type === "proxy" && endpoint.api !== "responses"
            ? { fetcher: communityEndpointFetch }
            : {}),
    };
}

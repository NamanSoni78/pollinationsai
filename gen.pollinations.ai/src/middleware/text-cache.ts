/**
 * Text cache middleware for gen.pollinations.ai
 * Caches by caller identity: a keyed generation is replayed only to the key
 * that paid for it, while keyless (anonymous) traffic keeps sharing entries.
 * Adapted from gen.pollinations.ai/cloudflare-cache
 */

import { IMMUTABLE_CACHE_CONTROL } from "@shared/http/cache-control.ts";
import { authenticateApiKeyRequest } from "@shared/auth/api-key.ts";
import {
    createCaptureStream,
    generateCacheKey,
    getCachedResponse,
} from "@/utils/text-cache.ts";
import type { AuthVariables } from "./auth.ts";
import {
    callerCacheScope,
    createGenerationCache,
    createGenerationExecutionCache,
    type GenerationCacheAdapter,
} from "./generation-cache.ts";
import { getRequiredSafetyFeatures, type ModelVariables } from "./model.ts";

/**
 * Text cache middleware
 * - Partitions the cache by caller identity (see resolveCacheAuth below)
 * - Returns immediately on cache HIT
 * - On MISS: continues to auth/rate limiting/origin
 * - After origin response: caches it (handles both streaming and non-streaming)
 *
 * Note: Only apply this middleware to cacheable routes (e.g., /v1/chat/completions, /text/:prompt)
 * Non-cacheable routes like /v1/models should NOT use this middleware
 */

/**
 * Resolve a caller identity for cache partitioning. The cache lookup runs
 * before the route's auth middleware, so the shared helper does the same
 * read-only key lookup here. Returns undefined for anonymous callers and on
 * lookup failures (the auth middleware rejects bad keys later on a MISS).
 */
async function resolveCacheAuth(
    c: Parameters<GenerationCacheAdapter["getKey"]>[0],
): Promise<string | undefined> {
    try {
        const authResult = await authenticateApiKeyRequest({
            request: c.req.raw,
            env: c.env,
            ctx: c.executionCtx,
        });
        if (authResult?.apiKey?.id) return `key:${authResult.apiKey.id}`;
        if (authResult?.user?.id) return `user:${authResult.user.id}`;
        return undefined;
    } catch {
        return undefined;
    }
}

const textCacheAdapter: GenerationCacheAdapter = {
    storage: "text",
    label: "text-cache",
    async getKey(c) {
        // Hono caches body text across c.req.json()/text(), so this still works
        // after upstream validators have parsed JSON.
        let bodyText: string | undefined;
        if (c.req.method === "POST" || c.req.method === "PUT") {
            bodyText = c.var.generationCacheBody ?? (await c.req.text());
        }

        const variables = c.var as typeof c.var &
            Partial<AuthVariables & ModelVariables>;
        // seed -1 asks for a fresh generation, so each request gets its own entry.
        const seed =
            c.req.method === "GET" || c.req.method === "HEAD"
                ? Number(c.req.query("seed"))
                : (
                      c.req.valid("json" as never) as
                          | { seed?: number }
                          | undefined
                  )?.seed;
        if (variables.model?.requested?.includes(",") || seed === -1) {
            c.set("generationCachePrivate", true);
        }
        // The cache lookup runs before the auth middleware, so the identity
        // variables are not populated yet: authenticate here (the same
        // read-only helper the auth middleware uses) to partition the key. A
        // failed lookup must not break caching, so it falls back to the
        // anonymous scope and auth rejects the request later on a MISS.
        const cacheAuth = await resolveCacheAuth(c);
        // A keyed generation belongs to the key that paid for it: replay it
        // only to that caller, mirroring the agent-run partition below.
        if (cacheAuth) c.set("generationCachePrivate", true);
        // Agent runs are unique; caller lists are stable per key because their
        // choices depend on that key's permissions and available budget.
        const cacheScope = variables.model?.cacheScope;
        const partition = cacheScope
            ? `${cacheScope}:key:${variables.auth?.apiKey?.id ?? "anonymous"}:run:${c.var.requestId}`
            : seed === -1
              ? `random-seed:${crypto.randomUUID()}`
              : variables.model?.requested?.includes(",")
                ? `caller-list:${callerCacheScope(variables.auth)}`
                : cacheAuth
                  ? `caller:${cacheAuth}`
                  : undefined;
        const cacheVersions = [
            variables.model?.definition.cacheVersion,
            ...(variables.model?.fallbackEntries?.map(
                ({ definition }) => definition.cacheVersion,
            ) ?? []),
        ].filter((version): version is string => version !== undefined);
        return generateCacheKey(
            c.req.raw,
            bodyText,
            cacheVersions.length
                ? JSON.stringify([partition, ...new Set(cacheVersions)])
                : partition,
            getRequiredSafetyFeatures(variables.model),
        );
    },
    async get(c, cacheKey) {
        const response = await getCachedResponse(c, cacheKey);
        if (response && c.var.generationCachePrivate) {
            response.headers.set("Cache-Control", "private, no-store");
        }
        return response;
    },
    shouldCache(response) {
        return response.status === 200 && response.body !== null;
    },
    capture(c, cacheKey, response) {
        const capture = createCaptureStream(c, cacheKey, response);
        const captured = new Response(capture.stream, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
        captured.headers.set("X-Cache", "MISS");
        captured.headers.set("X-Cache-Key", cacheKey.substring(0, 16));
        captured.headers.set(
            "Cache-Control",
            c.var.generationCachePrivate
                ? "private, no-store"
                : IMMUTABLE_CACHE_CONTROL,
        );
        return { response: captured, write: capture.write };
    },
};

export const textCache = createGenerationCache(textCacheAdapter);
export const textExecutionCache =
    createGenerationExecutionCache(textCacheAdapter);

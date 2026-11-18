/**
 * Generic fal.ai queue API client for generation models.
 *
 * Contract confirmed against fal.ai docs (no precedent client existed in this
 * repo before this file): submit to POST https://queue.fal.run/{endpoint},
 * auth via "Authorization: Key $FAL_KEY", poll the returned status_url until
 * COMPLETED, then fetch the returned response_url for the result.
 * fal.ai's 3D-generation models consistently return the mesh under a
 * `model_mesh: { url, content_type, file_name, file_size }` field (confirmed
 * for fal-ai/triposr and fal-ai/trellis/multi; assumed for the others —
 * verify against each model's /api docs page if output extraction fails).
 */

import { sleep } from "../../image/util.ts";
import { UpstreamError } from "@shared/error.ts";
import type { Usage } from "@shared/registry/registry.ts";
import { getModel3dEnv } from "../env.ts";

const QUEUE_BASE = "https://queue.fal.run";
const POLL_INTERVAL_MS = 5000;

export class FalError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly responseBody?: string,
    ) {
        super(message);
        this.name = "FalError";
    }
}

interface FalQueueSubmitResponse {
    status_url: string;
    response_url: string;
}

interface FalQueueStatusResponse {
    status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED";
}

export interface FalModelMesh {
    url: string;
    content_type?: string;
    file_name?: string;
    file_size?: number;
}

export interface RunFalJobOptions {
    endpoint: string;
    input: Record<string, unknown>;
}

function requireFalApiKey(): string {
    const apiKey = getModel3dEnv("FAL_KEY");
    if (!apiKey) {
        throw new FalError("FAL_KEY environment variable is required");
    }
    return apiKey;
}

/** Settle a post-completion fal failure onto the caller's usage. */
function settleFalError(error: unknown, paidUsage: Usage): UpstreamError {
    if (error instanceof UpstreamError) {
        return error.billedUsage === undefined
            ? Object.assign(error, { billedUsage: paidUsage })
            : error;
    }
    return UpstreamError.fromProvider(
        error instanceof FalError ? (error.status ?? 502) : 502,
        {
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof FalError && error.responseBody !== undefined
                ? { responseBody: error.responseBody }
                : {}),
            billedUsage: paidUsage,
        },
    );
}

export async function runFalJob(
    opts: RunFalJobOptions,
    apiKey = requireFalApiKey(),
    paidUsage?: Usage,
): Promise<Record<string, unknown>> {
    const response = await runFalJobResponse(opts, apiKey, paidUsage);
    if (paidUsage === undefined) {
        return (await response.json()) as Record<string, unknown>;
    }
    try {
        return (await response.json()) as Record<string, unknown>;
    } catch (error) {
        // fal billed the completed queue job; a malformed result body must
        // still settle it.
        throw settleFalError(error, paidUsage);
    }
}

/** Preserve the result headers for callers that use fal's reported billing units. */
export async function runFalJobResponse(
    opts: RunFalJobOptions,
    apiKey = requireFalApiKey(),
    paidUsage?: Usage,
): Promise<Response> {
    const submitted = await falFetch(apiKey, {
        method: "POST",
        url: `${QUEUE_BASE}/${opts.endpoint}`,
        body: opts.input,
    });
    const submission = (await submitted.json()) as FalQueueSubmitResponse;

    // Fal still runs and bills a job we stop polling, so wait until it
    // finishes. The durable generation alarm bounds the wait.
    while (true) {
        await sleep(POLL_INTERVAL_MS);
        const polled = await falFetch(apiKey, {
            method: "GET",
            url: submission.status_url,
        });
        const status = (await polled.json()) as FalQueueStatusResponse;
        if (status.status === "COMPLETED") {
            try {
                return await falFetch(apiKey, {
                    method: "GET",
                    url: submission.response_url,
                });
            } catch (error) {
                // The queue reported completion, so fal bills the job: a
                // failed result fetch settles the caller's usage. A 422 at
                // this fetch is fal's content checker — whether that
                // rejection happened before or after generation (and thus
                // whether it was billed) is model-specific, so let FalError
                // 422s through unconverted for the caller to classify.
                if (paidUsage === undefined) throw error;
                if (error instanceof FalError && error.status === 422) {
                    throw error;
                }
                throw settleFalError(error, paidUsage);
            }
        }
    }
}

// fal.ai's 3D models use either `model_mesh` (triposr, trellis/multi, rodin,
// tripo3d) or `model_glb` (trellis-2, hunyuan-3d) for the primary output file
// — confirmed per-model via each endpoint's /api docs page, no single
// consistent field name across all of fal's 3D catalog.
export function extractFalModelMesh(
    result: Record<string, unknown>,
): FalModelMesh {
    const modelMesh = (result.model_mesh ?? result.model_glb) as
        | FalModelMesh
        | undefined;
    if (!modelMesh?.url) {
        throw new FalError(
            "fal.ai 3D generation succeeded but model_mesh/model_glb output is missing",
        );
    }
    return modelMesh;
}

async function falFetch(
    apiKey: string,
    args: {
        method: "GET" | "POST";
        url: string;
        body?: Record<string, unknown>;
    },
): Promise<Response> {
    const headers: Record<string, string> = {
        Authorization: `Key ${apiKey}`,
    };
    if (args.body) headers["Content-Type"] = "application/json";

    const response = await fetch(args.url, {
        method: args.method,
        headers,
        body: args.body ? JSON.stringify(args.body) : undefined,
    });

    if (!response.ok) {
        const text = await response.text().catch(() => "<no body>");
        throw new FalError(
            `fal.ai ${args.method} ${args.url} failed (HTTP ${response.status}): ${text}`,
            classifyFalHttpStatus(response.status),
            text,
        );
    }
    return response;
}

export function classifyFalHttpStatus(httpStatus: number): number {
    // 429 → 429 so clients can back off. 400/422 → pass through (input
    // validation). Other 4xx and all 5xx → 502 (our config / upstream outage).
    if (httpStatus === 429) return 429;
    if (httpStatus === 400 || httpStatus === 422) return httpStatus;
    return 502;
}

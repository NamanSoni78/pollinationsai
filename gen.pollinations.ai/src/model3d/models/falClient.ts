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
import { getModel3dEnv } from "../env.ts";

const QUEUE_BASE = "https://queue.fal.run";
const POLL_INTERVAL_MS = 5000;
// A queue job that never terminates must not pin the request (or the
// generation alarm) forever. 20 minutes keeps the documented slow-job
// polling semantics (an 11-minute triposr job is pinned by test) while
// bounding the wait when no external timeout arrives.
const JOB_TIMEOUT_MS = 20 * 60 * 1_000;
const TIMEOUT_MESSAGE = "fal.ai generation timed out after 1200 seconds";

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
    // FAILED is fal's documented terminal status for a job that ran and did
    // not produce output; any other unknown value is also terminal-garbage,
    // not a pollable state.
    status?: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | string;
    error?: string;
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

export async function runFalJob(
    opts: RunFalJobOptions,
    apiKey = requireFalApiKey(),
): Promise<Record<string, unknown>> {
    return (await runFalJobResponse(opts, apiKey)).json();
}

/** Preserve the result headers for callers that use fal's reported billing units. */
export async function runFalJobResponse(
    opts: RunFalJobOptions,
    apiKey = requireFalApiKey(),
): Promise<Response> {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    const submitted = await falFetch(apiKey, {
        method: "POST",
        url: `${QUEUE_BASE}/${opts.endpoint}`,
        body: opts.input,
        deadline,
    });
    const submission = (await submitted.json()) as FalQueueSubmitResponse;

    // Fal still runs and bills a job we stop polling, so wait until it
    // finishes. The deadline bounds the wait even when the durable
    // generation alarm is slow or absent.
    while (true) {
        await sleep(Math.min(POLL_INTERVAL_MS, remainingTime(deadline)));
        const polled = await falFetch(apiKey, {
            method: "GET",
            url: submission.status_url,
            deadline,
        });
        const status = (await polled.json()) as FalQueueStatusResponse;
        if (status.status === "COMPLETED") {
            return falFetch(apiKey, {
                method: "GET",
                url: submission.response_url,
                deadline,
            });
        }
        if (status.status === "FAILED") {
            throw new FalError(
                status.error ||
                    `fal.ai job FAILED: ${submission.status_url}`,
                502,
            );
        }
        if (
            status.status !== "IN_QUEUE" &&
            status.status !== "IN_PROGRESS"
        ) {
            throw new FalError(
                `fal.ai returned an invalid status: ${JSON.stringify(status.status)}`,
                502,
            );
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
        deadline: number;
    },
): Promise<Response> {
    const headers: Record<string, string> = {
        Authorization: `Key ${apiKey}`,
    };
    if (args.body) headers["Content-Type"] = "application/json";

    const signal = AbortSignal.timeout(remainingTime(args.deadline));
    let response: Response;
    try {
        response = await fetch(args.url, {
            method: args.method,
            headers,
            body: args.body ? JSON.stringify(args.body) : undefined,
            signal,
        });
    } catch (error) {
        if (signal.aborted || Date.now() >= args.deadline) {
            throw new FalError(TIMEOUT_MESSAGE, 504);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new FalError(
            `fal.ai ${args.method} ${args.url} failed: ${message}`,
            502,
        );
    }

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

function remainingTime(deadline: number): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        throw new FalError(TIMEOUT_MESSAGE, 504);
    }
    return remaining;
}

export function classifyFalHttpStatus(httpStatus: number): number {
    // 429 → 429 so clients can back off. 400/422 → pass through (input
    // validation). Other 4xx and all 5xx → 502 (our config / upstream outage).
    if (httpStatus === 429) return 429;
    if (httpStatus === 400 || httpStatus === 422) return httpStatus;
    return 502;
}

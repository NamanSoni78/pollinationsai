import { Buffer } from "node:buffer";
import { UpstreamError } from "@shared/error.ts";
import type { Usage } from "@shared/registry/registry.ts";
import { FalError } from "./models/falClient.ts";
import { InferenceportError } from "./models/inferenceportClient.ts";
import type { Model3dParams } from "./params.ts";

// 3D meshes are a few MB in practice; 64 MiB leaves generous headroom while
// keeping a runaway provider artifact from buffering the whole isolate.
const MESH_MAX_BYTES = 64 * 1024 * 1024;
// Image-fleet artifact downloads use fetchUpstream's bounded signal; this
// is the 3D fleet's equivalent.
const MESH_DOWNLOAD_TIMEOUT_MS = 60 * 1_000;

export function toUpstreamError(
    err: unknown,
    fallbackMessage = "3D generation failed",
): UpstreamError {
    if (err instanceof UpstreamError) return err;
    if (err instanceof InferenceportError || err instanceof FalError) {
        return UpstreamError.fromProvider(err.status ?? 502, {
            message: err.message,
            responseBody: err.responseBody,
        });
    }
    const message = err instanceof Error ? err.message : String(err);
    return UpstreamError.fromProvider(500, {
        message: message || fallbackMessage,
    });
}

export function requireImages(params: Model3dParams, modelLabel: string): void {
    if (params.image.length === 0) {
        throw UpstreamError.fromProvider(400, {
            message: `${modelLabel} requires at least one reference image (image= param)`,
        });
    }
}

export function requirePrompt(prompt: string, modelLabel: string): void {
    if (!prompt.trim()) {
        throw UpstreamError.fromProvider(400, {
            message: `${modelLabel} requires a text prompt`,
        });
    }
}

export async function downloadMesh(url: string): Promise<Buffer> {
    const response = await fetch(url, {
        signal: AbortSignal.timeout(MESH_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok) {
        throw UpstreamError.fromProvider(502, {
            message: `Failed to download generated 3D model (HTTP ${response.status})`,
        });
    }
    const declared = Number(response.headers.get("content-length"));
    if (
        Number.isFinite(declared) &&
        declared > MESH_MAX_BYTES
    ) {
        await response.body?.cancel();
        throw UpstreamError.fromProvider(502, {
            message: `Generated 3D model is too large to download (${Math.round(declared / (1024 * 1024))} MiB > 64 MiB cap)`,
        });
    }
    // Stream and count: a lying content-length cannot exceed the cap.
    const reader = response.body?.getReader();
    if (!reader) {
        throw UpstreamError.fromProvider(502, {
            message: "3D provider returned no model body",
        });
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > MESH_MAX_BYTES) {
                await reader.cancel();
                throw UpstreamError.fromProvider(502, {
                    message: `Generated 3D model exceeded the 64 MiB download cap`,
                });
            }
            chunks.push(value);
        }
    } catch (error) {
        if (error instanceof UpstreamError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw UpstreamError.fromProvider(502, {
            message: `Failed to download generated 3D model: ${message}`,
        });
    }
    return Buffer.concat(chunks);
}

export function assertGlb(buffer: Buffer): void {
    if (
        buffer.length < 20 ||
        buffer.toString("ascii", 0, 4) !== "glTF" ||
        buffer.readUInt32LE(4) !== 2 ||
        buffer.readUInt32LE(8) !== buffer.length
    ) {
        throw UpstreamError.fromProvider(502, {
            message: "3D provider returned an invalid GLB file",
        });
    }
}

import type { Model3dGenerationResult } from "../createAndReturnModel3d.ts";
import { downloadMesh, requireImages, toUpstreamError } from "../modelUtils.ts";
import type { Model3dParams } from "../params.ts";
import { extractFalModelMesh, runFalJob } from "./falClient.ts";

const RESOLUTION = {
    low: 512,
    medium: 1024,
    high: 1536,
} as const;

export async function callTrellis2Fal(
    params: Model3dParams,
): Promise<Model3dGenerationResult> {
    requireImages(params, "microsoft/trellis-2");

    try {
        // fal bills the queue job at COMPLETED; settle the success path's
        // usage on any post-completion failure.
        const paidUsage = { completionImageTokens: 1 };
        const result = await runFalJob(
            {
                endpoint: "fal-ai/trellis-2",
                input: {
                    image_url: params.image[0],
                    resolution: RESOLUTION[params.resolution],
                },
            },
            undefined,
            paidUsage,
        );
        try {
            const mesh = extractFalModelMesh(result);
            return {
                buffer: await downloadMesh(mesh.url),
                contentType: "model/gltf-binary",
                trackingData: {
                    actualModel: "microsoft/trellis-2:fal",
                    usage: paidUsage,
                },
            };
        } catch (error) {
            throw Object.assign(toUpstreamError(error), {
                billedUsage: paidUsage,
            });
        }
    } catch (error) {
        throw toUpstreamError(error);
    }
}

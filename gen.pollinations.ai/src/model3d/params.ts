import { MODEL3D_SERVICES } from "@shared/registry/model3d.ts";
import { validateUserMediaUrl } from "@shared/user-media-url.ts";
import { z } from "zod";

const VALID_3D_MODELS = [
    ...Object.keys(MODEL3D_SERVICES),
    ...Object.values(MODEL3D_SERVICES).flatMap((service) => service.aliases),
] as const;

export const Model3dParamsSchema = z.object({
    model: z.enum(VALID_3D_MODELS as unknown as [string, ...string[]]),
    resolution: z.enum(["low", "medium", "high"]).default("low"),
    image: z
        .union([z.array(z.string()), z.string(), z.null(), z.undefined()])
        .transform((value?: string[] | string | null) => {
            if (!value) return [];
            if (Array.isArray(value)) return value;
            // Keep commas inside URLs, matching the public query schema.
            const urls = value.includes("|")
                ? value.split("|")
                : value.split(/,(?=\s*https?:\/\/)/);
            return urls.map((url) => url.trim()).filter(Boolean);
        })
        .catch([])
        // The image URLs are fetched server-side by the 3D providers
        // (InferencePort, fal, Rodin), so they are held to the same public
        // HTTP(S) URL policy as every other user-supplied media fetch — a
        // loopback/private/literal-IP target would otherwise be fetched from
        // inside the provider's network with no validation on this path.
        // After the catch so a policy failure surfaces as its own 400 rather
        // than collapsing to "no images".
        .refine((urls) => urls.every((url) => validateUserMediaUrl(url).ok), {
            message:
                "Reference images must use public HTTP(S) URLs without credentials or literal IP hosts.",
        }),
    // Not passed to either provider unless it natively supports seeds (see
    // rodinModel.ts/trellis2Model.ts) — still accepted here so it becomes
    // part of the media-cache key, letting callers force a fresh generation
    // for the same prompt by varying the seed.
    seed: z.coerce.number().int().optional().catch(undefined),
    safe: z
        .union([z.string(), z.boolean()])
        .transform((value) => {
            if (typeof value === "boolean") return value;
            return value?.toString()?.toLowerCase?.() === "true";
        })
        .catch(false),
});

export type Model3dParams = z.infer<typeof Model3dParamsSchema>;

import { afterEach, describe, expect, it, vi } from "vitest";
import {
    getCostDefinition,
    getRegistryModelDefinition,
} from "@shared/registry/registry.ts";

// fal.ai's FLUX 3 Max page (fetched 2026-11-19): "FLUX 3 Max is 50% off
// until November 21 … $0.085 / second [720p]. List $0.17, this rate ends
// November 21". Settlement bills the registry's per-second rate against
// fal's reported billable seconds, so the sheet must quote the live price.
afterEach(() => {
    vi.useRealTimers();
});

describe("flux-3-max per-second rates track the live fal promotion", () => {
    it("quotes the 50%-off promo rates before 2026-11-21", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-19T12:00:00Z"));
        const base = getCostDefinition("black-forest-labs/flux-3-max");
        expect(base?.completionVideoSeconds).toBeCloseTo(0.085, 10);
        const variant =
            getRegistryModelDefinition("black-forest-labs/flux-3-max")
                ?.costVariants?.["1080p"];
        expect(variant?.completionVideoSeconds).toBeCloseTo(0.145, 10);
    });
    it("quotes the fal list rates from 2026-11-22", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-11-22T00:00:00Z"));
        const base = getCostDefinition("black-forest-labs/flux-3-max");
        expect(base?.completionVideoSeconds).toBeCloseTo(0.17, 10);
        const variant =
            getRegistryModelDefinition("black-forest-labs/flux-3-max")
                ?.costVariants?.["1080p"];
        expect(variant?.completionVideoSeconds).toBeCloseTo(0.29, 10);
    });
});

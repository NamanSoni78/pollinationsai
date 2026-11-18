import { canCoverEstimatedCharge } from "@shared/billing/bucket-selection.ts";
import {
    DEFAULT_3D_MODEL,
    MODEL3D_SERVICES,
} from "@shared/registry/model3d.ts";
import { describe, expect, it } from "vitest";
// Same loading path the docs route uses, so the test sees exactly what ships.
import doc from "../src/docs/3d-generation.md?raw";

// The docs' 3D note drifted from the registry once already (it claimed the
// default model works with the Quest balance while `paidOnly: true` — the
// documented default flow 402'd for every Quest-funded caller). These tests
// pin the prose to the registry so they cannot drift apart again.

function noteText(): string {
    return doc
        .split("\n")
        .filter((line) => line.startsWith(">"))
        .join(" ");
}

describe("3D docs ↔ registry parity", () => {
    it("no model the docs claim is Quest-eligible is paidOnly in the registry", () => {
        const note = noteText();
        const questSentence = note.match(
            /([^.]*?)works with the Quest balance/,
        );
        const claimed = questSentence
            ? [...questSentence[1].matchAll(/`([^`]+)`/g)].map((m) => m[1])
            : [];
        for (const id of claimed) {
            const definition = (
                MODEL3D_SERVICES as Record<string, { paidOnly: boolean }>
            )[id];
            expect(
                definition?.paidOnly,
                `${id} is documented as Quest-balance eligible`,
            ).toBe(false);
        }
    });

    it("every paidOnly 3D model is documented as requiring the paid balance", () => {
        const note = noteText();
        expect(note).toContain("require the paid balance");
        for (const [id, definition] of Object.entries(MODEL3D_SERVICES)) {
            if (!definition.paidOnly) continue;
            // Fallback route variants (`:fal`) document under their primary id.
            const documentedId = id.replace(/:.*$/, "");
            expect(
                note,
                `${id} is paidOnly and ${documentedId} must be named in the paid-balance note`,
            ).toContain(`\`${documentedId}\``);
        }
    });

    it("the registry gate keeps Quest-only balances off paidOnly 3D models", () => {
        const definition = MODEL3D_SERVICES[DEFAULT_3D_MODEL];
        expect(definition.paidOnly).toBe(true);
        const flatUnit = (
            definition.cost as { completionImageTokens: number }
        ).completionImageTokens;
        expect(
            canCoverEstimatedCharge(
                { tierBalance: 5, packBalance: 0 },
                flatUnit,
                definition.paidOnly,
            ),
        ).toBe(false);
    });
});

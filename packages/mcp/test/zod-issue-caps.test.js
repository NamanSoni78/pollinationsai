import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { z } from "zod";
import { imageTools } from "../src/services/imageService.js";

// GHSA-mrhx-c7xc-m3w5: zod < 4.6.6 materializes one issue per failing array
// element with no cap, so an MCP tool call whose image array had tens of
// thousands of invalid entries allocated a proportional amount of memory in
// the worker before the tool ran. With zod >= 4.6.6 a violated .max()
// short-circuits to a single issue — these tests pin that behavior and the
// 20-URL cap on the image tools.

const require = createRequire(import.meta.url);
const zodVersion = require("zod/package.json").version;

test("runs a zod version with the advisory fix (>= 4.6.6)", () => {
    const [major, minor, patch] = zodVersion.split(".").map(Number);
    assert.ok(
        major > 4 ||
            (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))),
        `zod ${zodVersion} is still vulnerable to GHSA-mrhx-c7xc-m3w5`,
    );
});

for (const toolName of ["generateImage", "generateVideo"]) {
    const schemaOf = () => {
        const shape = imageTools.find(([name]) => name === toolName)[2];
        return z.object(shape);
    };

    test(`${toolName} input short-circuits an oversized invalid image array`, () => {
        const result = schemaOf().safeParse({
            image: Array.from({ length: 50_000 }, () => ({ not: "a url" })),
        });
        assert.equal(result.success, false);
        // Unpatched: one issue per element (50k). Patched: the violated
        // .max(20) aborts with a single issue.
        assert.ok(
            result.error.issues.length <= 2,
            `expected a short-circuit, got ${result.error.issues.length} issues`,
        );
    });

    test(`${toolName} accepts up to 20 reference URLs`, () => {
        const result = schemaOf().safeParse({
            prompt: "test",
            image: Array.from(
                { length: 20 },
                (_, i) => `https://example.com/ref-${i}.png`,
            ),
        });
        assert.equal(result.success, true);
    });
}

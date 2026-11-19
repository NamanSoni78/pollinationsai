/**
 * Spill-to-disk capture for oversized tool output.
 *
 * Output strictly larger than `threshold` bytes (default 4096) is archived to
 * `<workspace>/.agent/logs/<uuid>.txt`. The preview keeps the first and last
 * `lines` lines plus a `… [N lines total, M more] …` marker and a
 * `Full output: <path>` pointer. Never throws on write failure: the preview
 * is still returned with `path` null.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { atomicWrite } from "./context.js";

const DEFAULT_THRESHOLD = 4096;
const DEFAULT_LINES = 25;

const previewOf = (output, path, lines) => {
    const all = output.split("\n");
    const hidden = Math.max(0, all.length - lines * 2);
    const head = all.slice(0, lines).join("\n");
    const tail = all.slice(-lines).join("\n");
    const marker = `… [${all.length} lines total, ${hidden} more] …`;
    const footer = `Full output: ${path ?? "unavailable"}`;
    return `${head}\n${marker}\n${tail}\n${footer}`;
};

/**
 * Capture tool output, spilling oversized payloads to disk.
 *
 * @param {string} text captured output
 * @param {{workspace?: string, threshold?: number, lines?: number}} [options]
 * @returns {{preview: string, path: string|null}} `path` is set only when the
 *   output was over the threshold AND the archive write succeeded
 */
export function captureOutput(
    text,
    { workspace, threshold = DEFAULT_THRESHOLD, lines = DEFAULT_LINES } = {},
) {
    const output = String(text ?? "");
    if (Buffer.byteLength(output, "utf8") <= threshold) {
        return { preview: output, path: null };
    }
    let path = null;
    if (workspace) {
        try {
            path = join(workspace, ".agent", "logs", `${randomUUID()}.txt`);
            atomicWrite(path, output);
        } catch {
            path = null;
        }
    }
    return { preview: previewOf(output, path, lines), path };
}

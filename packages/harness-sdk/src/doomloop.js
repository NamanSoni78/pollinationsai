/**
 * Doom-loop breaker: tracks consecutive identical tool failures (same tool,
 * same normalized args, same error signature) and injects a consult_expert
 * intervention directive on the third.
 */
import { createHash } from "node:crypto";

const sortKeysDeep = (value) => {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, sortKeysDeep(value[key])]),
        );
    }
    return value;
};

/**
 * Track one tool call outcome.
 *
 * @param {object} state agent state; keeps the counter on `state.doomLoop`
 *   ({signature, consecutive}) and pushes directives into
 *   `state.telemetry.directives`
 * @param {string} tool tool name
 * @param {object} args call arguments (key order is normalized)
 * @param {Error|{message: string}|null} error failure (null/undefined on success)
 * @returns {{signature: string, consecutive: number, intervene?: "consult_expert"}}
 */
export function trackCall(state, tool, args, error) {
    const errorText = String(error?.message ?? error ?? "").slice(0, 200);
    const signature = createHash("sha1")
        .update(
            `${tool}${JSON.stringify(sortKeysDeep(args ?? {}))}${errorText}`,
        )
        .digest("hex");
    state.doomLoop ??= { signature: null, consecutive: 0 };
    const tracker = state.doomLoop;
    let result;
    if (error == null) {
        tracker.signature = null;
        tracker.consecutive = 0;
        result = { signature, consecutive: 0 };
    } else if (tracker.signature === signature) {
        tracker.consecutive += 1;
        result = { signature, consecutive: tracker.consecutive };
    } else {
        tracker.signature = signature;
        tracker.consecutive = 1;
        result = { signature, consecutive: 1 };
    }
    if (result.consecutive === 3) {
        result.intervene = "consult_expert";
        state.telemetry ??= {};
        state.telemetry.directives ??= [];
        state.telemetry.directives.push(
            `doom-loop: tool "${tool}" failed 3 times identically (signature ${signature.slice(0, 8)}) — consult_expert before retrying`,
        );
        // Require a fresh triple before intervening again.
        tracker.signature = null;
        tracker.consecutive = 0;
    }
    return result;
}

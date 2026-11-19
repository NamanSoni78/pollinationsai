// Phase machine for the Agent Ground closed loop. States and legal
// transitions are frozen by the spec; any other move throws
// {code: "invalid_transition", from, to}.

export const PHASES = Object.freeze([
    "IM_CHAT",
    "PREFLIGHT_INTERVIEW",
    "AUTONOMOUS_EXECUTION",
    "WARDEN_AUDIT",
    "COMPLETED",
    "BUDGET_PAUSED",
]);

export const TRANSITIONS = Object.freeze({
    IM_CHAT: ["PREFLIGHT_INTERVIEW"],
    PREFLIGHT_INTERVIEW: ["AUTONOMOUS_EXECUTION"],
    AUTONOMOUS_EXECUTION: ["WARDEN_AUDIT", "BUDGET_PAUSED"],
    WARDEN_AUDIT: ["AUTONOMOUS_EXECUTION", "COMPLETED"],
    BUDGET_PAUSED: ["AUTONOMOUS_EXECUTION"],
    COMPLETED: [],
});

const PHASE_SET = new Set(PHASES);

/**
 * True when `from -> to` is a legal transition. Unknown phase names are
 * never legal.
 *
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isValidTransition(from, to) {
    if (!PHASE_SET.has(from) || !PHASE_SET.has(to)) {
        return false;
    }
    return TRANSITIONS[from].includes(to);
}

function invalidTransition(from, to) {
    return Object.assign(new Error(`invalid transition ${from} -> ${to}`), {
        code: "invalid_transition",
        from,
        to,
    });
}

function unknownPhase(phase) {
    return Object.assign(new Error(`unknown phase: ${phase}`), {
        code: "unknown_phase",
        phase,
    });
}

/**
 * Create a finite-state machine over the closed-loop phases.
 *
 * @param {string} initialPhase defaults to "IM_CHAT"; must be a known phase
 * @param {{onTransition?: (from: string, to: string) => void}=} hooks
 * @returns {{phase: () => string, can: (to: string) => boolean, transition: (to: string) => string, set: (phase: string) => string}}
 */
export function createFsm(initialPhase = "IM_CHAT", hooks = {}) {
    if (!PHASE_SET.has(initialPhase)) {
        throw unknownPhase(initialPhase);
    }
    let current = initialPhase;
    return {
        phase: () => current,
        can: (to) => isValidTransition(current, to),
        /**
         * Move to `to`; throws {code:"invalid_transition", from, to} when the
         * move is not in TRANSITIONS.
         */
        transition(to) {
            if (!isValidTransition(current, to)) {
                throw invalidTransition(current, to);
            }
            const from = current;
            current = to;
            if (typeof hooks.onTransition === "function") {
                hooks.onTransition(from, to);
            }
            return to;
        },
        /**
         * Force-set the phase. Used only by crash recovery (resumeFromDisk):
         * a restored process continues exactly where it stopped, so the
         * transition table is bypassed — but the phase name must still be
         * a known state.
         */
        set(phase) {
            if (!PHASE_SET.has(phase)) {
                throw unknownPhase(phase);
            }
            current = phase;
            return phase;
        },
    };
}

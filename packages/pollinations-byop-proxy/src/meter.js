// Pollen budget metering: response costing, the 75/90/100 threshold state
// machine, the call ledger, and balance reconciliation. The state functions
// mutate the given state object in place and return {state, events} so tests
// can drive the machine directly. 1 Pollen = 1 unit of balance.

import { EventEmitter } from "node:events";

export const CONSERVATION_PCT = 75;
export const WRAPUP_PCT = 90;
export const CUTOFF_PCT = 100;

const PHASE_RANK = {
    normal: 0,
    conservation: 1,
    wrapup: 2,
    cutoff: 3,
    paused: 0,
};

/** Pollen precision: the balance API reports 8 decimals (1.90942313), so
 * metering rounds to 1e-8 — 2-decimal rounding would erase micro-spend. */
const roundPollen = (n) => Math.round(n * 1e8) / 1e8;

/** Fresh meter state; `identity` is filled in by the proxy once known. */
export function createMeterState({ maxPollen }) {
    return {
        maxPollen: Number(maxPollen),
        spent: 0,
        pct: 0,
        phase: "normal",
        identity: null,
    };
}

/** Budget percentage, rounded to 2 decimals (0 when there is no cap). */
export function computePct(spent, maxPollen) {
    if (!(Number(maxPollen) > 0)) return 0;
    return roundPollen((Number(spent) / Number(maxPollen)) * 100);
}

/** Map a percentage to the strictest phase it implies. */
export function phaseForPct(pct) {
    if (pct >= CUTOFF_PCT) return "cutoff";
    if (pct >= WRAPUP_PCT) return "wrapup";
    if (pct >= CONSERVATION_PCT) return "conservation";
    return "normal";
}

/**
 * Cost in Pollen = prompt_tokens x pricing.promptTextTokens +
 * completion_tokens x pricing.completionTextTokens. API pricing values are
 * strings and are parsed here. Returns null when usage or pricing is missing
 * or non-numeric; callers then fall back to reconciliation.
 *
 * @param {object|null} usage - `{prompt_tokens, completion_tokens}`
 * @param {object|null} pricing - `{promptTextTokens, completionTextTokens}`
 * @returns {number|null}
 */
export function computeCost(usage, pricing) {
    if (!usage || typeof usage !== "object") return null;
    if (!pricing || typeof pricing !== "object") return null;
    const promptTokens = Number(usage.prompt_tokens);
    const completionTokens = Number(usage.completion_tokens);
    const promptRate = Number(pricing.promptTextTokens);
    const completionRate = Number(pricing.completionTextTokens);
    const values = [promptTokens, completionTokens, promptRate, completionRate];
    if (values.some((value) => !Number.isFinite(value))) return null;
    return promptTokens * promptRate + completionTokens * completionRate;
}

/**
 * Recompute pct/phase after spend or the cap changed. Emits one
 * `budget.threshold` per newly crossed level (75, 90) and `budget.cutoff`
 * at >=100 — each exactly once per upward crossing. Downward moves never
 * emit here (topUp emits `budget.resumed` separately).
 */
export function applySpend(state) {
    const pct = computePct(state.spent, state.maxPollen);
    const phase = phaseForPct(pct);
    const before = PHASE_RANK[state.phase] ?? 0;
    const after = PHASE_RANK[phase] ?? 0;
    const events = [];
    if (after > before) {
        if (after >= 1 && before < 1) {
            events.push({
                type: "budget.threshold",
                level: "conservation",
                pct,
            });
        }
        if (after >= 2 && before < 2) {
            events.push({ type: "budget.threshold", level: "wrapup", pct });
        }
        if (phase === "cutoff") {
            events.push({ type: "budget.cutoff", pct: CUTOFF_PCT });
        }
    }
    state.pct = pct;
    state.phase = phase;
    return { state, events };
}

/** Raise the cap by `amount`; leaving cutoff emits `budget.resumed`. */
export function applyTopUp(state, amount) {
    const add = Number(amount);
    if (!Number.isFinite(add) || add <= 0) return { state, events: [] };
    state.maxPollen = roundPollen(state.maxPollen + add);
    return finishBudgetChange(state);
}

/** Set the cap to `next`; leaving cutoff emits `budget.resumed`. */
export function applySetBudget(state, next) {
    const cap = Number(next);
    if (!Number.isFinite(cap) || cap <= 0) return { state, events: [] };
    state.maxPollen = cap;
    return finishBudgetChange(state);
}

function finishBudgetChange(state) {
    const wasCutoff = state.phase === "cutoff";
    const { events } = applySpend(state);
    if (wasCutoff && state.phase !== "cutoff") {
        events.push({ type: "budget.resumed", maxPollen: state.maxPollen });
    }
    return { state, events };
}

/**
 * Reconcile against the live balance: when the startup baseline is higher
 * than the current balance, trust the larger of (already-counted spend,
 * baseline drop). Never lowers `spent` — the balance can rise for reasons
 * outside this proxy.
 */
export function applyReconcile(state, baseline, balance) {
    if (baseline === null || baseline === undefined) return applySpend(state);
    const from = Number(baseline);
    const to = Number(balance);
    if (Number.isFinite(from) && Number.isFinite(to) && from > to) {
        const dropped = roundPollen(from - to);
        if (dropped > state.spent) state.spent = dropped;
    }
    return applySpend(state);
}

/**
 * Pull `{usage, model}` out of an upstream body. Handles plain JSON and
 * OpenAI-style SSE streams (the last data chunk carrying usage wins).
 * Returns `{usage: null, model: null}` when nothing can be extracted.
 */
export function extractUsageAndModel(buffer, contentType = "") {
    const text = buffer.toString("utf8");
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = null;
    }
    const looksLikeSse =
        contentType.includes("event-stream") || /(^|\n)data:/.test(text);
    if (!parsed && looksLikeSse) {
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            const payload = trimmed.startsWith("data:")
                ? trimmed.slice(5).trim()
                : "";
            if (!payload || payload === "[DONE]") continue;
            try {
                const chunk = JSON.parse(payload);
                if (
                    chunk &&
                    typeof chunk === "object" &&
                    (chunk.usage || !parsed)
                )
                    parsed = chunk;
            } catch {
                // Ignore malformed SSE lines; metering falls back to reconcile.
            }
        }
    }
    if (!parsed || typeof parsed !== "object")
        return { usage: null, model: null };
    return { usage: parsed.usage ?? null, model: parsed.model ?? null };
}

/**
 * Stateful meter used by the proxy: owns the live state object (the same
 * reference exposed as `proxy.state`), the ledger, and event emission.
 * Events are emitted as `{type, at, ...payload}` per the platform contract.
 */
export function createMeter({ maxPollen, events = new EventEmitter() }) {
    const state = createMeterState({ maxPollen });
    const ledger = [];
    const emitAll = (emitted) => {
        for (const event of emitted) {
            events.emit(event.type, {
                type: event.type,
                at: new Date().toISOString(),
                ...event,
            });
        }
    };
    return {
        state,
        ledger,
        /** Add a costed spend (Pollen) and run the threshold machine. */
        addCost(cost) {
            const value = Number(cost);
            if (!Number.isFinite(value) || value <= 0) return [];
            state.spent = roundPollen(state.spent + value);
            const { events: emitted } = applySpend(state);
            emitAll(emitted);
            return emitted;
        },
        /** Append a ledger entry `{at, model, usage, cost, mode}`. */
        record(entry) {
            const record = {
                at: new Date().toISOString(),
                model: entry?.model ?? null,
                usage: entry?.usage ?? null,
                cost: entry?.cost ?? null,
                mode: entry?.mode ?? "reconcile",
            };
            ledger.push(record);
            return record;
        },
        topUp(amount) {
            const result = applyTopUp(state, amount);
            emitAll(result.events);
            return result;
        },
        setBudget(next) {
            const result = applySetBudget(state, next);
            emitAll(result.events);
            return result;
        },
        reconcile(baseline, balance) {
            const result = applyReconcile(state, baseline, balance);
            emitAll(result.events);
            return result;
        },
        lastEntries(n = 20) {
            return ledger.slice(-n);
        },
    };
}

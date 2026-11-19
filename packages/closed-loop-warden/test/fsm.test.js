import assert from "node:assert/strict";
import test from "node:test";
import {
    createFsm,
    isValidTransition,
    PHASES,
    TRANSITIONS,
} from "../src/fsm.js";

test("PHASES is exactly the six spec states", () => {
    assert.deepEqual(PHASES, [
        "IM_CHAT",
        "PREFLIGHT_INTERVIEW",
        "AUTONOMOUS_EXECUTION",
        "WARDEN_AUDIT",
        "COMPLETED",
        "BUDGET_PAUSED",
    ]);
});

test("TRANSITIONS is exactly the spec table", () => {
    assert.deepEqual(TRANSITIONS, {
        IM_CHAT: ["PREFLIGHT_INTERVIEW"],
        PREFLIGHT_INTERVIEW: ["AUTONOMOUS_EXECUTION"],
        AUTONOMOUS_EXECUTION: ["WARDEN_AUDIT", "BUDGET_PAUSED"],
        WARDEN_AUDIT: ["AUTONOMOUS_EXECUTION", "COMPLETED"],
        BUDGET_PAUSED: ["AUTONOMOUS_EXECUTION"],
        COMPLETED: [],
    });
});

test("fsm starts in IM_CHAT by default and honours a custom initial phase", () => {
    assert.equal(createFsm().phase(), "IM_CHAT");
    assert.equal(createFsm("BUDGET_PAUSED").phase(), "BUDGET_PAUSED");
    assert.throws(
        () => createFsm("SLEEPING"),
        (err) => err.code === "unknown_phase" && err.phase === "SLEEPING",
    );
});

test("happy chain: IM_CHAT -> PREFLIGHT -> AUTONOMOUS -> AUDIT -> COMPLETED", () => {
    const fsm = createFsm();
    assert.equal(fsm.transition("PREFLIGHT_INTERVIEW"), "PREFLIGHT_INTERVIEW");
    assert.equal(
        fsm.transition("AUTONOMOUS_EXECUTION"),
        "AUTONOMOUS_EXECUTION",
    );
    assert.equal(fsm.transition("WARDEN_AUDIT"), "WARDEN_AUDIT");
    assert.equal(fsm.transition("COMPLETED"), "COMPLETED");
    assert.equal(fsm.phase(), "COMPLETED");
});

test("reject cycle returns to AUTONOMOUS_EXECUTION", () => {
    const fsm = createFsm("WARDEN_AUDIT");
    assert.equal(
        fsm.transition("AUTONOMOUS_EXECUTION"),
        "AUTONOMOUS_EXECUTION",
    );
});

test("budget pause cycle: AUTONOMOUS -> BUDGET_PAUSED -> AUTONOMOUS", () => {
    const fsm = createFsm("AUTONOMOUS_EXECUTION");
    fsm.transition("BUDGET_PAUSED");
    assert.equal(fsm.phase(), "BUDGET_PAUSED");
    fsm.transition("AUTONOMOUS_EXECUTION");
    assert.equal(fsm.phase(), "AUTONOMOUS_EXECUTION");
});

test("invalid transitions throw {code, from, to}", () => {
    const cases = [
        ["IM_CHAT", "COMPLETED"],
        ["IM_CHAT", "WARDEN_AUDIT"],
        ["IM_CHAT", "AUTONOMOUS_EXECUTION"],
        ["COMPLETED", "AUTONOMOUS_EXECUTION"],
        ["PREFLIGHT_INTERVIEW", "WARDEN_AUDIT"],
        ["BUDGET_PAUSED", "COMPLETED"],
        ["WARDEN_AUDIT", "BUDGET_PAUSED"],
        ["PREFLIGHT_INTERVIEW", "PREFLIGHT_INTERVIEW"],
        ["AUTONOMOUS_EXECUTION", "PREFLIGHT_INTERVIEW"],
    ];
    for (const [from, to] of cases) {
        const fsm = createFsm(from);
        assert.throws(
            () => fsm.transition(to),
            (err) =>
                err.code === "invalid_transition" &&
                err.from === from &&
                err.to === to,
            `expected ${from} -> ${to} to be invalid`,
        );
    }
    assert.equal(isValidTransition("IM_CHAT", "PREFLIGHT_INTERVIEW"), true);
    assert.equal(isValidTransition("IM_CHAT", "NOWHERE"), false);
});

test("transition to an unknown phase name is an invalid transition", () => {
    const fsm = createFsm();
    assert.throws(
        () => fsm.transition("DELETED"),
        (err) =>
            err.code === "invalid_transition" &&
            err.from === "IM_CHAT" &&
            err.to === "DELETED",
    );
});

test("can() reports legality without moving", () => {
    const fsm = createFsm();
    assert.equal(fsm.can("PREFLIGHT_INTERVIEW"), true);
    assert.equal(fsm.can("WARDEN_AUDIT"), false);
    assert.equal(fsm.phase(), "IM_CHAT");
});

test("set() force-sets a known phase and rejects unknown ones", () => {
    const fsm = createFsm();
    assert.equal(fsm.set("WARDEN_AUDIT"), "WARDEN_AUDIT");
    assert.equal(fsm.phase(), "WARDEN_AUDIT");
    assert.throws(
        () => fsm.set("PAUSED"),
        (err) => err.code === "unknown_phase",
    );
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { trackCall } from "../src/doomloop.js";

const mkState = () => ({
    telemetry: { directives: [] },
    doomLoop: { signature: null, consecutive: 0 },
});
const boom = () => new Error("ECONNREFUSED 127.0.0.1:5432");

test("three consecutive identical failures trigger the consult_expert intervention (acceptance d)", () => {
    const state = mkState();
    const first = trackCall(state, "run_tests", { a: 1 }, boom());
    assert.equal(first.consecutive, 1);
    assert.equal(first.intervene, undefined);
    const second = trackCall(state, "run_tests", { a: 1 }, boom());
    assert.equal(second.consecutive, 2);
    assert.equal(second.intervene, undefined);
    const third = trackCall(state, "run_tests", { a: 1 }, boom());
    assert.equal(third.consecutive, 3);
    assert.equal(third.intervene, "consult_expert");
    assert.equal(state.telemetry.directives.length, 1);
    assert.ok(state.telemetry.directives[0].includes("run_tests"));
    assert.ok(state.telemetry.directives[0].includes("consult_expert"));
    const fourth = trackCall(state, "run_tests", { a: 1 }, boom());
    assert.equal(
        fourth.consecutive,
        1,
        "counter restarts after the intervention",
    );
    assert.equal(fourth.intervene, undefined);
});

test("a different error or args resets the signature", () => {
    const state = mkState();
    trackCall(state, "run_tests", { a: 1 }, boom());
    trackCall(state, "run_tests", { a: 1 }, boom());
    const other = trackCall(
        state,
        "run_tests",
        { a: 1 },
        new Error("ENOENT: no such file"),
    );
    assert.equal(
        other.consecutive,
        1,
        "different error signature resets the streak",
    );
    trackCall(state, "run_tests", { b: 2 }, boom());
    const reset = trackCall(state, "run_tests", { a: 1 }, boom());
    assert.equal(
        reset.consecutive,
        1,
        "different args in between reset the streak",
    );
});

test("a successful call breaks the loop", () => {
    const state = mkState();
    trackCall(state, "deploy", {}, boom());
    trackCall(state, "deploy", {}, boom());
    const success = trackCall(state, "deploy", {}, null);
    assert.equal(success.consecutive, 0);
    const next = trackCall(state, "deploy", {}, boom());
    assert.equal(next.consecutive, 1);
});

test("signature normalizes argument key order", () => {
    const a = trackCall(mkState(), "t", { a: 1, b: { x: 1, y: 2 } }, boom());
    const b = trackCall(mkState(), "t", { b: { y: 2, x: 1 }, a: 1 }, boom());
    assert.equal(a.signature, b.signature);
    const c = trackCall(mkState(), "t", { a: 2, b: { x: 1, y: 2 } }, boom());
    assert.notEqual(a.signature, c.signature);
});

test("long error messages are capped at 200 characters in the signature", () => {
    const longA = new Error(`${"x".repeat(500)}A`);
    const longB = new Error(`${"x".repeat(500)}B`);
    const a = trackCall(mkState(), "t", {}, longA);
    const b = trackCall(mkState(), "t", {}, longB);
    assert.equal(
        a.signature,
        b.signature,
        "differences past 200 chars do not matter",
    );
});

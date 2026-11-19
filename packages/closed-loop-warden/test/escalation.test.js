import assert from "node:assert/strict";
import test from "node:test";
import { escalateOnDoubleReject } from "../src/escalation.js";

const verdict = {
    approved: false,
    summary: "Warden audit: 0/1 must-pass requirement(s) verified; rejected",
    results: [
        {
            req_id: "REQ-1",
            status: "FAIL",
            defect: "pattern not found in a.txt",
        },
    ],
    required_actions: [
        { req_id: "REQ-1", action: "Fix requirement REQ-1: pattern not found" },
    ],
};

test("no escalation below two consecutive rejections", () => {
    assert.deepEqual(escalateOnDoubleReject({}, "REQ-1", verdict), {
        escalate: false,
        packet: null,
    });
    assert.equal(
        escalateOnDoubleReject({ "REQ-1": 1 }, "REQ-1", verdict).escalate,
        false,
    );
    assert.equal(
        escalateOnDoubleReject(null, "REQ-1", verdict).escalate,
        false,
    );
    assert.equal(
        escalateOnDoubleReject({ "REQ-1": 1 }, "REQ-2", verdict).escalate,
        false,
    );
});

test("double reject produces the exact consult_expert packet", () => {
    const decision = escalateOnDoubleReject({ "REQ-1": 2 }, "REQ-1", verdict);
    assert.equal(decision.escalate, true);
    assert.deepEqual(decision.packet, {
        req_id: "REQ-1",
        defect: "pattern not found in a.txt",
        required_actions: ["Fix requirement REQ-1: pattern not found"],
        critique: verdict.summary,
    });
});

test("packet stays well-formed when the verdict lacks the requirement", () => {
    const other = {
        approved: false,
        summary: "nope",
        results: [{ req_id: "REQ-9", status: "FAIL", defect: "x" }],
        required_actions: [],
    };
    const decision = escalateOnDoubleReject({ "REQ-1": 3 }, "REQ-1", other);
    assert.equal(decision.escalate, true);
    assert.deepEqual(decision.packet, {
        req_id: "REQ-1",
        defect: null,
        required_actions: [],
        critique: "nope",
    });
});

test("escalation tolerates missing verdict pieces", () => {
    const decision = escalateOnDoubleReject({ "REQ-1": 2 }, "REQ-1", undefined);
    assert.equal(decision.escalate, true);
    assert.deepEqual(decision.packet, {
        req_id: "REQ-1",
        defect: null,
        required_actions: [],
        critique: "",
    });
});

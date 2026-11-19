import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
    applyReconcile,
    applySetBudget,
    applySpend,
    applyTopUp,
    computeCost,
    computePct,
    createMeter,
    createMeterState,
    extractUsageAndModel,
    phaseForPct,
} from "../src/meter.js";

test("computeCost prices usage against string pricing fields", () => {
    const pricing = { promptTextTokens: "2", completionTextTokens: "5" };
    assert.equal(
        computeCost({ prompt_tokens: 100, completion_tokens: 50 }, pricing),
        450,
    );
    assert.equal(
        computeCost({ prompt_tokens: 0, completion_tokens: 0 }, pricing),
        0,
    );
    assert.equal(computeCost(null, pricing), null);
    assert.equal(computeCost({ prompt_tokens: 1 }, pricing), null);
    assert.equal(
        computeCost({ prompt_tokens: 1, completion_tokens: 1 }, null),
        null,
    );
    assert.equal(
        computeCost({ prompt_tokens: "x", completion_tokens: 1 }, pricing),
        null,
    );
});

test("computePct and phaseForPct boundaries", () => {
    assert.equal(computePct(1, 4), 25);
    assert.equal(computePct(5, 0), 0);
    assert.equal(phaseForPct(0), "normal");
    assert.equal(phaseForPct(74.99), "normal");
    assert.equal(phaseForPct(75), "conservation");
    assert.equal(phaseForPct(89.99), "conservation");
    assert.equal(phaseForPct(90), "wrapup");
    assert.equal(phaseForPct(99.99), "wrapup");
    assert.equal(phaseForPct(100), "cutoff");
    assert.equal(phaseForPct(142), "cutoff");
});

test("applySpend emits each threshold exactly once per crossing", () => {
    const state = createMeterState({ maxPollen: 1000 });
    const seen = [];
    const drive = (spend) => {
        state.spent = spend;
        seen.push(...applySpend(state).events);
    };
    drive(500);
    assert.equal(state.phase, "normal");
    drive(760);
    assert.deepEqual(seen, [
        { type: "budget.threshold", level: "conservation", pct: 76 },
    ]);
    drive(760); // no new spend: no duplicate event
    assert.equal(seen.length, 1);
    drive(905);
    assert.deepEqual(seen[1], {
        type: "budget.threshold",
        level: "wrapup",
        pct: 90.5,
    });
    drive(1000);
    assert.deepEqual(seen[2], { type: "budget.cutoff", pct: 100 });
    assert.equal(state.phase, "cutoff");
    assert.equal(state.pct, 100);
    drive(1100); // already cut off: no further events, pct keeps climbing
    assert.equal(seen.length, 3);
    assert.equal(state.pct, 110);
});

test("applySpend jumps emit every newly crossed level", () => {
    const state = createMeterState({ maxPollen: 100 });
    state.spent = 100;
    const { events } = applySpend(state);
    assert.deepEqual(
        events.map((event) => event.type),
        ["budget.threshold", "budget.threshold", "budget.cutoff"],
    );
    assert.deepEqual(
        events.map((event) => event.level ?? "cutoff"),
        ["conservation", "wrapup", "cutoff"],
    );
});

test("applyTopUp raises the cap and resumes from cutoff", () => {
    const state = createMeterState({ maxPollen: 100 });
    state.spent = 100;
    applySpend(state);
    assert.equal(state.phase, "cutoff");
    const { events } = applyTopUp(state, 100);
    assert.equal(state.maxPollen, 200);
    assert.equal(state.pct, 50);
    assert.equal(state.phase, "normal");
    assert.deepEqual(events, [{ type: "budget.resumed", maxPollen: 200 }]);

    // Resuming into wrapup (not normal) still emits budget.resumed.
    const tight = createMeterState({ maxPollen: 100 });
    tight.spent = 100;
    applySpend(tight);
    const tightResult = applyTopUp(tight, 1);
    assert.equal(tight.phase, "wrapup");
    assert.deepEqual(tightResult.events, [
        { type: "budget.resumed", maxPollen: 101 },
    ]);

    // topUp below cutoff never emits budget.resumed.
    const warm = createMeterState({ maxPollen: 100 });
    warm.spent = 80;
    applySpend(warm);
    assert.deepEqual(applyTopUp(warm, 100).events, []);
    assert.equal(warm.phase, "normal");

    // Invalid amounts are ignored.
    assert.deepEqual(
        applyTopUp(createMeterState({ maxPollen: 1 }), -5).events,
        [],
    );
});

test("applySetBudget replaces the cap and can resume from cutoff", () => {
    const state = createMeterState({ maxPollen: 100 });
    state.spent = 100;
    applySpend(state);
    const { events } = applySetBudget(state, 400);
    assert.equal(state.maxPollen, 400);
    assert.equal(state.pct, 25);
    assert.equal(state.phase, "normal");
    assert.deepEqual(events, [{ type: "budget.resumed", maxPollen: 400 }]);
    assert.deepEqual(applySetBudget(state, 0).events, []);
});

test("applyReconcile adopts balance drops but never lowers spend", () => {
    const state = createMeterState({ maxPollen: 10 });
    state.spent = 2;
    applySpend(state);
    let { events } = applyReconcile(state, 10, 8);
    assert.equal(state.spent, 2); // drop 2 == spent: no change
    assert.deepEqual(events, []);
    ({ events } = applyReconcile(state, 10, 5)); // drop 5 > spent 2
    assert.equal(state.spent, 5);
    assert.equal(state.phase, "normal"); // 50%: below the first threshold
    assert.deepEqual(events, []);
    ({ events } = applyReconcile(state, 10, 2)); // drop 8 -> 80%: crosses conservation
    assert.equal(state.spent, 8);
    assert.equal(state.phase, "conservation");
    assert.deepEqual(
        events.map((event) => event.level),
        ["conservation"],
    );
    ({ events } = applyReconcile(state, 10, 9)); // balance recovered: spend stays
    assert.equal(state.spent, 8);
    assert.deepEqual(events, []);
    ({ events } = applyReconcile(state, null, 1)); // missing baseline: no-op
    assert.equal(state.spent, 8);
    assert.deepEqual(events, []);
});

test("extractUsageAndModel reads JSON bodies and SSE streams", () => {
    const json = Buffer.from(
        JSON.stringify({
            model: "m/x",
            usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
    );
    assert.deepEqual(extractUsageAndModel(json, "application/json"), {
        usage: { prompt_tokens: 3, completion_tokens: 4 },
        model: "m/x",
    });

    const sse = Buffer.from(
        [
            'data: {"model":"m/x","choices":[]}',
            "",
            'data: {"model":"m/x","usage":{"prompt_tokens":10,"completion_tokens":2}}',
            "",
            "data: [DONE]",
        ].join("\n"),
    );
    assert.deepEqual(extractUsageAndModel(sse, "text/event-stream"), {
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        model: "m/x",
    });

    assert.deepEqual(
        extractUsageAndModel(Buffer.from("not json at all"), "text/plain"),
        {
            usage: null,
            model: null,
        },
    );
});

test("createMeter wires state, ledger and event emission", () => {
    const events = new EventEmitter();
    const received = [];
    events.on("budget.threshold", (event) => received.push(event));
    const meter = createMeter({ maxPollen: 100, events });
    meter.addCost(80);
    assert.equal(meter.state.phase, "conservation");
    meter.record({
        model: "m/x",
        usage: { prompt_tokens: 80, completion_tokens: 0 },
        cost: 80,
        mode: "usage",
    });
    meter.addCost(15);
    meter.record({ model: null, usage: null, cost: null, mode: "reconcile" });
    assert.equal(meter.state.phase, "wrapup");
    assert.equal(meter.ledger.length, 2);
    assert.equal(meter.ledger[0].mode, "usage");
    assert.ok(!Number.isNaN(Date.parse(meter.ledger[0].at)));
    assert.equal(received.length, 2);
    assert.equal(received[0].type, "budget.threshold");
    assert.equal(received[0].level, "conservation");
    assert.equal(received[0].pct, 80);
    assert.ok(!Number.isNaN(Date.parse(received[0].at)));
    for (let i = 0; i < 25; i++)
        meter.record({ model: "m/x", mode: "reconcile" });
    assert.equal(meter.lastEntries(20).length, 20);
    assert.equal(meter.lastEntries(20)[0].mode, "reconcile");
});

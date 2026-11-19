import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createByopProxy, resolveBaseUrl, resolvePort } from "../src/index.js";

const FAKE_KEY = "sk-byop-fake-key-1234567890";

const MODELS = {
    data: [
        {
            id: "openai/gpt-5.4-nano",
            name: "openai/gpt-5.4-nano",
            pricing: {
                currency: "pollen",
                promptTextTokens: "1",
                completionTextTokens: "0",
            },
        },
        {
            id: "m/x",
            name: "m/x",
            pricing: {
                currency: "pollen",
                promptTextTokens: "2",
                completionTextTokens: "5",
            },
        },
    ],
};

// Chat response with a known usage: prompt_tokens x 1 Pollen (gpt-5.4-nano).
const usageResponse = (promptTokens, model = "openai/gpt-5.4-nano") => ({
    id: "chatcmpl-test",
    model,
    usage: {
        prompt_tokens: promptTokens,
        completion_tokens: 0,
        total_tokens: promptTokens,
    },
});

async function startStubGen(t, overrides = {}) {
    const state = {
        profile: overrides.profile ?? { githubUsername: "octo-agent" },
        profileStatus: overrides.profileStatus ?? 200,
        balance: overrides.balance ?? 10,
        models: overrides.models ?? MODELS,
        chatResponses: overrides.chatResponses
            ? [...overrides.chatResponses]
            : [],
    };
    const seen = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            seen.push({
                method: req.method,
                path: req.url,
                auth: req.headers.authorization ?? null,
            });
            res.setHeader("content-type", "application/json");
            if (req.method === "GET" && req.url === "/account/profile") {
                res.statusCode = state.profileStatus;
                res.end(JSON.stringify(state.profile));
            } else if (req.method === "GET" && req.url === "/account/balance") {
                res.end(JSON.stringify({ balance: state.balance }));
            } else if (req.method === "GET" && req.url === "/v1/models") {
                res.end(JSON.stringify(state.models));
            } else if (
                req.method === "POST" &&
                req.url === "/v1/chat/completions"
            ) {
                res.end(
                    JSON.stringify(
                        state.chatResponses.shift() ?? usageResponse(0),
                    ),
                );
            } else {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "not found" }));
            }
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
        server.closeAllConnections?.();
        return new Promise((resolve) => server.close(resolve));
    });
    return {
        server,
        state,
        seen,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
    };
}

async function startProxy(t, stub, options = {}) {
    const proxy = await createByopProxy({
        apiKey: FAKE_KEY,
        port: 0,
        baseUrl: stub.baseUrl,
        ...options,
    });
    t.after(() => proxy.stop());
    return proxy;
}

function chat(
    proxy,
    body = {
        model: "openai/gpt-5.4-nano",
        messages: [{ role: "user", content: "hi" }],
    },
) {
    return fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

async function waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline)
            throw new Error("waitFor: condition not met in time");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

test("thresholds: 75/90/100 emit once each, then metered calls get 402 while unmetered pass", async (t) => {
    const stub = await startStubGen(t, {
        chatResponses: [
            usageResponse(500),
            usageResponse(260),
            usageResponse(145),
            usageResponse(95),
            usageResponse(7),
        ],
    });
    const proxy = await startProxy(t, stub, { maxPollenBudget: 1000 });
    const thresholds = [];
    const cutoffs = [];
    proxy.events.on("budget.threshold", (event) => thresholds.push(event));
    proxy.events.on("budget.cutoff", (event) => cutoffs.push(event));

    await chat(proxy); // 500/1000 = 50%
    assert.equal(proxy.state.phase, "normal");
    assert.equal(thresholds.length, 0);

    await chat(proxy); // 760/1000 = 76% -> conservation
    assert.equal(proxy.state.phase, "conservation");
    assert.deepEqual(
        thresholds.map((event) => event.level),
        ["conservation"],
    );
    assert.equal(thresholds[0].type, "budget.threshold");
    assert.equal(thresholds[0].pct, 76);
    assert.ok(!Number.isNaN(Date.parse(thresholds[0].at)));

    await chat(proxy); // 905/1000 = 90.5% -> wrapup
    assert.equal(proxy.state.phase, "wrapup");
    assert.deepEqual(
        thresholds.map((event) => event.level),
        ["conservation", "wrapup"],
    );
    assert.equal(thresholds[1].pct, 90.5);

    await chat(proxy); // 1000/1000 = 100% -> cutoff
    assert.equal(proxy.state.phase, "cutoff");
    assert.equal(proxy.state.pct, 100);
    assert.equal(cutoffs.length, 1);
    assert.deepEqual(cutoffs[0], {
        type: "budget.cutoff",
        at: cutoffs[0].at,
        pct: 100,
    });

    const blocked = await chat(proxy);
    assert.equal(blocked.status, 402);
    const body = await blocked.json();
    assert.equal(body.error.code, "insufficient_pollen");
    assert.equal(body.error.spent, 1000);
    assert.equal(body.error.maxPollen, 1000);
    assert.equal(typeof body.error.message, "string");
    assert.ok(body.error.message.length > 0);
    assert.ok(!JSON.stringify(body).includes(FAKE_KEY));
    // The blocked call never reached the upstream.
    assert.equal(
        stub.seen.filter((entry) => entry.path === "/v1/chat/completions")
            .length,
        4,
    );

    // Unmetered paths still pass through at cutoff.
    const models = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
    assert.equal(models.status, 200);
    const balance = await fetch(
        `http://127.0.0.1:${proxy.port}/account/balance`,
    );
    assert.equal(balance.status, 200);
    assert.equal((await balance.json()).balance, 10);
});

test("topUp raises the cap and resumes metered calls after cutoff", async (t) => {
    const stub = await startStubGen(t, {
        chatResponses: [
            usageResponse(500),
            usageResponse(260),
            usageResponse(145),
            usageResponse(95),
            usageResponse(500),
        ],
    });
    const proxy = await startProxy(t, stub, { maxPollenBudget: 1000 });
    for (let i = 0; i < 4; i++) await chat(proxy);
    assert.equal(proxy.state.phase, "cutoff");
    assert.equal((await chat(proxy)).status, 402);

    const resumed = [];
    proxy.events.on("budget.resumed", (event) => resumed.push(event));
    const result = proxy.topUp(1000);
    assert.equal(proxy.state.maxPollen, 2000);
    assert.equal(proxy.state.pct, 50);
    assert.equal(proxy.state.phase, "normal");
    assert.ok(result.events.some((event) => event.type === "budget.resumed"));
    assert.deepEqual(resumed, [
        { type: "budget.resumed", at: resumed[0].at, maxPollen: 2000 },
    ]);

    const ok = await chat(proxy);
    assert.equal(ok.status, 200);
    const json = await ok.json();
    assert.equal(json.usage.prompt_tokens, 500);
    assert.equal(proxy.state.spent, 1500);

    // topUp while not cutoff emits no budget.resumed.
    const quiet = [];
    proxy.events.on("budget.resumed", (event) => quiet.push(event));
    proxy.topUp(1000);
    assert.equal(quiet.length, 0);
});

test("usage-based costing: ledger costs match hand-computed values", async (t) => {
    const stub = await startStubGen(t, {
        chatResponses: [
            {
                model: "m/x",
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 50,
                    total_tokens: 150,
                },
            },
            {
                model: "m/x",
                usage: {
                    prompt_tokens: 10,
                    completion_tokens: 4,
                    total_tokens: 14,
                },
            },
        ],
    });
    const proxy = await startProxy(t, stub, { maxPollenBudget: 100000 });
    await chat(proxy, { model: "m/x", messages: [] }); // 100x2 + 50x5 = 450
    await chat(proxy, { model: "m/x", messages: [] }); // 10x2 + 4x5 = 40
    const ledger = proxy.ledger();
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0].cost, 450);
    assert.equal(ledger[1].cost, 40);
    assert.equal(ledger[0].mode, "usage");
    assert.equal(ledger[0].model, "m/x");
    assert.deepEqual(ledger[0].usage, {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
    });
    assert.ok(!Number.isNaN(Date.parse(ledger[0].at)));
    assert.equal(proxy.state.spent, 490);
    assert.equal(proxy.state.pct, 0.49);
});

test("reconcile: no-usage and unknown-model calls fall back to the live balance", async (t) => {
    const stub = await startStubGen(t, {
        balance: 5,
        chatResponses: [{ id: "chatcmpl-test", model: "openai/gpt-5.4-nano" }],
    });
    const proxy = await startProxy(t, stub, {
        maxPollenBudget: 1,
        reconcileMs: 50,
    });
    const cutoffs = [];
    proxy.events.on("budget.cutoff", (event) => cutoffs.push(event));

    const response = await chat(proxy); // response without usage
    assert.equal(response.status, 200);
    let ledger = proxy.ledger();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].mode, "reconcile");
    assert.equal(ledger[0].cost, null);
    assert.equal(proxy.state.spent, 0);

    stub.state.chatResponses.push({
        model: "m/missing",
        usage: { prompt_tokens: 1000, completion_tokens: 0 },
    });
    await chat(proxy); // usage present but model not in the pricing list
    ledger = proxy.ledger();
    assert.equal(ledger[1].mode, "reconcile");
    assert.equal(ledger[1].cost, null);
    assert.equal(proxy.state.spent, 0);

    stub.state.balance = 4.25; // baseline 5 -> drop 0.75
    await proxy.reconcileNow();
    assert.equal(proxy.state.spent, 0.75);
    assert.equal(proxy.state.phase, "conservation");

    stub.state.balance = 4.9; // balance recovered: spend must not drop
    await proxy.reconcileNow();
    assert.equal(proxy.state.spent, 0.75);

    stub.state.balance = 4; // the reconcileMs timer adopts this without manual help
    await waitFor(() => proxy.state.phase === "cutoff");
    assert.equal(proxy.state.spent, 1);
    assert.equal(cutoffs.length, 1);
});

test("identity resolves from the profile with a noreply fallback email", async (t) => {
    const stub = await startStubGen(t, {
        profile: { githubUsername: "octo-agent" },
    });
    const proxy = await startProxy(t, stub);
    assert.deepEqual(proxy.identity(), {
        username: "octo-agent",
        email: "octo-agent@users.noreply.github.com",
        source: "pollinations",
    });
    assert.equal(
        proxy.state.identity.email,
        "octo-agent@users.noreply.github.com",
    );
});

test("a profile email wins over the fallback", async (t) => {
    const stub = await startStubGen(t, {
        profile: { githubUsername: "octo-agent", email: "octo@example.com" },
    });
    const proxy = await startProxy(t, stub);
    assert.equal(proxy.identity().email, "octo@example.com");
});

test("identity failure does not block startup", async (t) => {
    const stub = await startStubGen(t, { profileStatus: 500 });
    const proxy = await startProxy(t, stub);
    assert.equal(proxy.identity(), null);
    assert.equal((await chat(proxy)).status, 200);
});

test("metered calls carry the BYOP key upstream; unmetered keep the caller's credentials", async (t) => {
    const stub = await startStubGen(t, { chatResponses: [usageResponse(10)] });
    const proxy = await startProxy(t, stub);
    await chat(proxy);
    const chatSeen = stub.seen.find(
        (entry) => entry.path === "/v1/chat/completions",
    );
    assert.equal(chatSeen.auth, `Bearer ${FAKE_KEY}`);

    await fetch(`http://127.0.0.1:${proxy.port}/v1/models`, {
        headers: { authorization: "Bearer caller-token" },
    });
    const modelsSeen = stub.seen
        .filter((entry) => entry.path === "/v1/models")
        .at(-1);
    assert.equal(modelsSeen.auth, "Bearer caller-token");
});

test("GET /internal/state serves dashboards and setBudget adjusts the cap", async (t) => {
    const stub = await startStubGen(t, { chatResponses: [usageResponse(100)] });
    const proxy = await startProxy(t, stub, { maxPollenBudget: 1000 });
    await chat(proxy);
    const response = await fetch(
        `http://127.0.0.1:${proxy.port}/internal/state`,
    );
    assert.equal(response.status, 200);
    const json = await response.json();
    assert.equal(json.maxPollen, 1000);
    assert.equal(json.spent, 100);
    assert.equal(json.pct, 10);
    assert.equal(json.phase, "normal");
    assert.equal(json.identity.username, "octo-agent");
    assert.equal(json.ledger.length, 1);
    assert.equal(json.ledger[0].cost, 100);
    assert.ok(!JSON.stringify(json).includes(FAKE_KEY));

    proxy.setBudget(500);
    const after = await (
        await fetch(`http://127.0.0.1:${proxy.port}/internal/state`)
    ).json();
    assert.equal(after.maxPollen, 500);
    assert.equal(after.pct, 20);
    assert.equal(after.phase, "normal");
});

test("env helpers: resolvePort and resolveBaseUrl", () => {
    assert.equal(resolvePort(0), 0);
    assert.equal(resolvePort(9000), 9000);
    assert.throws(() => resolvePort("nope"));
    const previous = process.env.AGENT_BYOP_PORT;
    process.env.AGENT_BYOP_PORT = "9001";
    assert.equal(resolvePort(undefined), 9001);
    delete process.env.AGENT_BYOP_PORT;
    assert.equal(resolvePort(undefined), 8878);
    if (previous !== undefined) process.env.AGENT_BYOP_PORT = previous;
    assert.equal(resolveBaseUrl("http://x///"), "http://x");
});

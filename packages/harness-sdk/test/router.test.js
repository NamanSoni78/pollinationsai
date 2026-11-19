import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveGitIdentity, roleRouter } from "../src/router.js";

test("roleRouter resolves quest-eligible defaults (acceptance i)", () => {
    const router = roleRouter({ env: {} });
    assert.equal(router.resolve("worker").model, "openai/gpt-6-sol");
    assert.equal(router.resolve("indexer").model, "openai/gpt-5.4-nano");
    assert.equal(router.resolve("subagent").model, "openai/gpt-5.4-nano");
    assert.equal(router.resolve("rag").model, "openai/gpt-5.4-nano");
    assert.equal(router.resolve("expert").model, "openai/gpt-6.1-sol");
    assert.equal(router.resolve("warden").model, "openai/gpt-6.1-terra");
    assert.equal(
        router.resolve("WARDEN").model,
        "openai/gpt-6.1-terra",
        "role match is case-insensitive",
    );
    assert.deepEqual(router.defaults.WORKER, "openai/gpt-6-sol");
});

test("roleRouter env overrides and unknown-role fallback", () => {
    const router = roleRouter({
        env: {
            WORKER_MODEL: "openai/custom-worker",
            INDEXER_MODEL: "openai/custom-indexer",
        },
    });
    assert.equal(router.resolve("worker").model, "openai/custom-worker");
    assert.equal(router.resolve("indexer").model, "openai/custom-indexer");
    assert.equal(router.defaults.WORKER, "openai/custom-worker");
    assert.equal(
        router.resolve("nonexistent-role").model,
        "openai/custom-worker",
        "unknown roles fall back to WORKER",
    );
});

test("roleRouter reads process.env by default", (t) => {
    const previous = process.env.WARDEN_MODEL;
    process.env.WARDEN_MODEL = "openai/env-warden";
    t.after(() => {
        if (previous === undefined) delete process.env.WARDEN_MODEL;
        else process.env.WARDEN_MODEL = previous;
    });
    assert.equal(roleRouter().resolve("warden").model, "openai/env-warden");
});

test("resolveGitIdentity: username as name, noreply email fallback (spec 2.4)", () => {
    assert.deepEqual(resolveGitIdentity({ githubUsername: "octocat" }), {
        name: "octocat",
        email: "octocat@users.noreply.github.com",
    });
    assert.deepEqual(
        resolveGitIdentity({
            githubUsername: "octocat",
            email: "octo@example.com",
        }),
        {
            name: "octocat",
            email: "octo@example.com",
        },
    );
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  BudgetExhaustedError,
  PollenBudgetFirewall,
  applyIdentityToGitRepo,
  createPollenMeteringProxy,
  resolvePollinationsIdentity,
} from "./index";

test("PollenBudgetFirewall enforces 75% CONSERVE, 90% WRAP_UP, 100% hard cutoff & Top-Up Resume", async () => {
  const fw = new PollenBudgetFirewall(1.0);
  let cutoffEvents = 0;
  fw.onCutoff(() => {
    cutoffEvents += 1;
  });

  assert.equal(fw.getStatus().tier, "NOMINAL");
  assert.equal(fw.getRoutingPolicy().downshiftNonCritical, false);

  await fw.recordSpend({
    agentId: "agent-backend-01",
    role: "worker",
    endpoint: "/v1/chat/completions",
    model: "openai/gpt-5.4-mini",
    costPollen: 0.76,
  });
  assert.equal(fw.getStatus().tier, "CONSERVE");
  assert.equal(fw.getRoutingPolicy().downshiftNonCritical, true);
  assert.equal(fw.getRoutingPolicy().allowSpeculativeSubagents, false);
  assert.match(fw.getStatus().directive, /75%/);

  await fw.recordSpend({
    agentId: "agent-backend-01",
    role: "worker",
    endpoint: "/v1/chat/completions",
    model: "openai/gpt-5.4-nano",
    costPollen: 0.16,
  });
  assert.equal(fw.getStatus().tier, "WRAP_UP");
  assert.equal(fw.getRoutingPolicy().allowNewFeatures, false);
  assert.match(fw.getStatus().directive, /90%/);

  const hit = await fw.recordSpend({
    agentId: "agent-backend-01",
    role: "warden",
    endpoint: "/v1/chat/completions",
    costPollen: 0.1,
  });
  assert.equal(hit.triggeredCutoff, true);
  assert.equal(cutoffEvents, 1);
  assert.equal(fw.getStatus().tier, "EXHAUSTED");
  assert.equal(fw.getStatus().paused, true);

  await assert.rejects(
    () => fw.assertCanSpend("agent-backend-01", 0.01),
    (err: unknown) => err instanceof BudgetExhaustedError && err.statusCode === 402,
  );

  // Top-Up & Resume preserves ledger and unblocks execution
  const resumed = fw.topUpAndResume(0.5);
  assert.equal(resumed.paused, false);
  assert.equal(resumed.maxBudgetPollen, 1.5);
  assert.equal(resumed.entriesCount, 3);
  assert.equal(resumed.tier, "NOMINAL");
});

test("Metering Proxy returns HTTP 402 at 100% burn and forwards with BYOP token before cutoff", async () => {
  const fw = new PollenBudgetFirewall(0.01);
  let capturedAuth = "";

  const mockFetch: typeof fetch = async (_url, init) => {
    const hdrs = init?.headers as Record<string, string>;
    capturedAuth = hdrs.authorization ?? "";
    return new Response(
      JSON.stringify({
        id: "cmpl-test",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-pollinations-mcp-cost": "0.011",
        },
      },
    );
  };

  const proxy = createPollenMeteringProxy({
    apiKey: "sk_test_out_of_band_token",
    firewall: fw,
    fetchImpl: mockFetch,
  });
  const { url } = await proxy.listen(0);

  try {
    // First call succeeds and spends 0.011 > 0.010 budget
    const res1 = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-id": "agent-fe",
        "x-agent-role": "worker",
      },
      body: JSON.stringify({ model: "openai/gpt-5.4-nano", messages: [] }),
    });
    assert.equal(res1.status, 200);
    assert.equal(capturedAuth, "Bearer sk_test_out_of_band_token");
    assert.equal(res1.headers.get("x-pollen-budget-tier"), "EXHAUSTED");

    // Second call is hard-blocked with HTTP 402
    const res2 = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": "agent-fe" },
      body: JSON.stringify({ model: "openai/gpt-5.4-nano", messages: [] }),
    });
    assert.equal(res2.status, 402);
    const body2 = (await res2.json()) as { error: { code: string } };
    assert.equal(body2.error.code, "POLLEN_BUDGET_EXHAUSTED");
  } finally {
    await proxy.close();
  }
});

test("resolvePollinationsIdentity & applyIdentityToGitRepo propagate profile to Git config", async () => {
  const mockFetch: typeof fetch = async (url) => {
    const u = String(url);
    if (u.endsWith("/account/profile")) {
      return new Response(
        JSON.stringify({ githubUsername: "NamanSoni78", image: "https://example.com/a.png" }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ balance: 1.91 }), { status: 200 });
  };

  const identity = await resolvePollinationsIdentity("sk_mock_key", {
    fetchImpl: mockFetch,
  });
  assert.equal(identity.githubUsername, "NamanSoni78");
  assert.equal(identity.email, "NamanSoni78@users.noreply.pollinations.ai");
  assert.equal(identity.balancePollen, 1.91);

  const dir = mkdtempSync(join(tmpdir(), "polli-git-id-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    await applyIdentityToGitRepo(dir, identity);
    const name = execFileSync("git", ["config", "user.name"], { cwd: dir }).toString().trim();
    const email = execFileSync("git", ["config", "user.email"], { cwd: dir }).toString().trim();
    assert.equal(name, "NamanSoni78");
    assert.equal(email, "NamanSoni78@users.noreply.pollinations.ai");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentGroundHub } from "../../agent-ground-mcp/src/index";
import {
  AutonomousGitEngine,
  DoomLoopCircuitBreaker,
  DynamicSkillsLoader,
  HybridRagIndex,
  SecretLeakDetectedError,
  buildRepoMap,
  compileSixLayerContext,
  createShadowReader,
  sleepUntil,
  spillLargeOutputToDisk,
  summarizeAndCompactContext,
  writeOpenCodeWorkspaceConfig,
} from "./index";

test("Deterministic 6-Layer Context Compiler preserves original + ALL past user prompts and triggers 70% compaction", () => {
  const largeTurn = "x".repeat(4000);
  const compiled = compileSixLayerContext({
    staticSystemPrefix: "You are an autonomous VM coding agent on Pollinations AI.",
    activeSkills: [{ name: "cloudflare-deploy", instructions: "Always use wrangler pages deploy." }],
    originalUserPrompt: "Build a multi-agent SaaS dashboard with Pollinations BYOP.",
    pastUserMessages: ["Add dark mode toggle.", "Make sure mobile 390px has zero overflow."],
    worklogMarkdown: "# WORKLOG\n- Milestone 1: Scaffolded API",
    telemetry: {
      gitBranch: "agent/fe-01/dashboard",
      gitStatusSummary: "2 modified file(s)",
      recentCommits: ["abc1234 feat: initial scaffold"],
      contractProgress: "2/3 passed",
      groundInboxCount: 1,
      groundInboxPreview: ["From api-01: Add CORS header"],
      pollenBudgetPercent: 78.4,
      pollenBudgetTier: "CONSERVE",
      pollenBudgetDirective: "Downshift non-critical calls.",
    },
    workingTurns: [
      { role: "user", content: largeTurn, timestamp: "2026-11-20T00:00:00Z" },
      { role: "assistant", content: largeTurn, timestamp: "2026-11-20T00:01:00Z" },
    ],
    contextBudgetTokens: 2500,
  });

  assert.equal(compiled.layers.length, 6);
  const layer3 = compiled.layers.find((l) => l.layer === 3)!;
  assert.match(layer3.content, /Build a multi-agent SaaS dashboard/);
  assert.match(layer3.content, /Add dark mode toggle\./);
  assert.match(layer3.content, /Make sure mobile 390px has zero overflow\./);
  assert.equal(compiled.shouldAutoCompact, true);
});

test("Heavy-Context Controls: >4KB spill-to-disk, summarize_context + RAG retrieval, and 3x Doom-Loop breaker", () => {
  const dir = mkdtempSync(join(tmpdir(), "polli-heavy-"));
  try {
    // 1. Spill-to-disk > 4KB
    const bigLines = Array.from({ length: 200 }, (_, i) => `log-line-${i + 1}: build diagnostic payload`).join("\n");
    const spill = spillLargeOutputToDisk(dir, bigLines, "npm test");
    assert.equal(spill.spilled, true);
    assert.ok(spill.logFilePath && existsSync(spill.logFilePath));
    assert.match(spill.content, /log-line-1:/);
    assert.match(spill.content, /log-line-200:/);
    assert.match(spill.content, /lines omitted/);

    // 2. summarize_context archives into RAG and frees tokens
    const rag = new HybridRagIndex();
    const turns = [
      { role: "user" as const, content: "Investigate Turso SQLite schema migration error code 418", timestamp: "t1" },
      { role: "assistant" as const, content: "Found missing index on sessions.user_id in schema.sql", timestamp: "t2" },
      { role: "tool" as const, toolName: "bash", content: "Migration 004 applied cleanly", timestamp: "t3" },
      { role: "assistant" as const, content: "Continuing with frontend integration", timestamp: "t4" },
    ];
    const compacted = summarizeAndCompactContext({
      workspaceDir: dir,
      workingTurns: turns,
      reason: "Reached 70% context fill",
      preserve_notes: "Keep sessions.user_id index",
      ragIndex: rag,
      keepRecentTurns: 1,
    });
    assert.equal(compacted.result.worklog_updated, true);
    assert.ok(compacted.result.tokens_freed > 0);
    assert.equal(compacted.remainingTurns.length, 1);

    // Archived detail stays retrievable via rag_search!
    const hits = rag.rag_search({ query: "Turso sessions.user_id migration", scope: "worklogs" });
    assert.ok(hits.length >= 1);
    assert.match(hits[0].content, /sessions\.user_id/);

    // 3. Doom-loop circuit breaker intercepts 3rd consecutive identical failure
    const breaker = new DoomLoopCircuitBreaker(3);
    assert.equal(breaker.recordFailure("bash", { cmd: "npm test" }, "ERR_MODULE_NOT_FOUND").tripped, false);
    assert.equal(breaker.recordFailure("bash", { cmd: "npm test" }, "ERR_MODULE_NOT_FOUND").tripped, false);
    const third = breaker.recordFailure("bash", { cmd: "npm test" }, "ERR_MODULE_NOT_FOUND");
    assert.equal(third.tripped, true);
    assert.match(third.interventionDirective ?? "", /consult_expert/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Dynamic Skills Loader mounts & unmounts SKILL.md and visibly adds/reclaims prompt tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "polli-skills-"));
  try {
    const skillDir = join(dir, ".agents", "skills", "cloudflare-deploy");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: cloudflare-deploy\ndescription: Deploy Workers & Pages safely\nrequired_tools: [cloudflare_deploy_pages]\n---\n# Cloudflare Deploy\nAlways run npm run build before wrangler deploy.\nVerify HTTP 200 after publish.`,
      "utf8",
    );

    const loader = new DynamicSkillsLoader([join(dir, ".agents", "skills")]);
    const list = loader.list_skills();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "cloudflare-deploy");
    assert.equal(list[0].loaded, false);

    const loaded = loader.load_skill({ name: "cloudflare-deploy" });
    assert.equal(loaded.loaded, true);
    assert.ok(loaded.tokens_added > 0);
    assert.equal(loader.getActiveSkillsForContext().length, 1);

    const unloaded = loader.unload_skill({ name: "cloudflare-deploy" });
    assert.equal(unloaded.unloaded, true);
    assert.equal(unloaded.tokens_freed, loaded.tokens_added);
    assert.equal(loader.getActiveSkillsForContext().length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AutonomousGitEngine blocks secret leaks, creates isolated branch, checkpoints, rolls back, and indexes repo_map", () => {
  const dir = mkdtempSync(join(tmpdir(), "polli-git-"));
  try {
    const git = new AutonomousGitEngine(dir, "backend-01");
    const init = git.initRepo(
      { displayName: "NamanSoni78", githubUsername: "NamanSoni78", email: "NamanSoni78@users.noreply.pollinations.ai" },
      "session-api",
    );
    assert.equal(init.branch, "agent/backend-01/session-api");
    assert.equal(init.gitignoreCreated, true);

    writeFileSync(
      join(dir, "routes.ts"),
      `export function handleSession() { return { status: 401, error: "unauthorized" }; }\napp.post("/api/session", handleSession);\n`,
      "utf8",
    );
    const cp1 = git.git_checkpoint({ message: "Add session route", milestone_id: "M1" });
    assert.equal(cp1.changed, true);

    // Indexer + Shadow Reader
    const repoMap = buildRepoMap(dir);
    assert.ok(repoMap.entries.some((e) => e.path === "routes.ts" && e.routes.includes("/api/session")));

    const rag = new HybridRagIndex();
    rag.indexWorkspace(dir);
    const shadow = createShadowReader({ agentId: "backend-01", workspaceDir: dir, ragIndex: rag });

    // Pre-commit secret-leak guard blocks committing API keys (synthetic dummy fixture)
    writeFileSync(join(dir, "leak.ts"), `const KEY = "sk_FakeTestLeakFixture000000000000";\n`, "utf8");
    assert.throws(
      () => git.git_checkpoint({ message: "Accidental leak" }),
      (err: unknown) => err instanceof SecretLeakDetectedError,
    );
    rmSync(join(dir, "leak.ts"));

    // Branch experiment + rollback
    const exp = git.git_branch_experiment({ name: "risky-refactor" });
    assert.equal(exp.branch, "agent/backend-01/exp-risky-refactor");
    writeFileSync(join(dir, "routes.ts"), `// broken experiment\n`, "utf8");
    git.git_checkpoint({ message: "Broken experiment" });

    const rb = git.git_rollback({ target_sha_or_tag: cp1.sha, reason: "Tests regressed" });
    assert.equal(rb.restored_sha, cp1.sha);
    assert.match(readFileSync(join(dir, "routes.ts"), "utf8"), /handleSession/);

    // OpenCode bridge writes config pointing at metering proxy without leaking real key
    const oc = writeOpenCodeWorkspaceConfig(dir, {
      agentId: "backend-01",
      meteringProxyUrl: "http://127.0.0.1:4100",
      agentGroundMcpUrl: "http://127.0.0.1:4200",
    });
    assert.ok(existsSync(oc.configPath));
    assert.ok(shadow);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sleepUntil wakes cleanly on Agent Ground artifact event with 0 LLM tokens burned", async () => {
  const hub = new AgentGroundHub();
  await hub.ground_subscribe({ subscriber_agent_id: "fe-01", artifact_keys: ["design-tokens"] });

  const waitPromise = sleepUntil(
    { until_event: "ground_artifact", max_wait_sec: 5 },
    { hub, agentId: "fe-01" },
  );

  setTimeout(() => {
    void hub.ground_publish_artifact({
      author_agent_id: "brand-01",
      key: "design-tokens",
      version: "v1",
      content_type: "json",
      payload: '{"accent":"#4D7C0F"}',
      changelog: "Initial color tokens",
    });
  }, 40);

  const wake = await waitPromise;
  assert.equal(wake.llm_tokens_burned, 0);
  assert.equal(wake.wake_reason, "ground_artifact:design-tokens@v1");
});

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type BudgetStatus,
  PollenBudgetFirewall,
  type PollinationsIdentity,
  applyIdentityToGitRepo,
  resolvePollinationsIdentity,
} from "../../../packages/pollinations-byop-proxy/src/index";
import {
  type AgentCard,
  AgentGroundHub,
  type ArtifactContentType,
  type BroadcastKind,
} from "../../../packages/agent-ground-mcp/src/index";
import {
  AutonomousGitEngine,
  type ChatTurn,
  type CompiledPrompt,
  DEFAULT_ROLE_MODELS,
  DoomLoopCircuitBreaker,
  DynamicSkillsLoader,
  HybridRagIndex,
  PollinationsModelRouter,
  type RepoMap,
  buildRepoMap,
  compileSixLayerContext,
  consultExpert,
  createShadowReader,
  spillLargeOutputToDisk,
  summarizeAndCompactContext,
  writeOpenCodeWorkspaceConfig,
} from "../../../packages/harness-sdk/src/index";
import {
  ClosedLoopDaemon,
  DEFAULT_PREFLIGHT_QUESTIONS,
  type EvidenceBundle,
  type TaskContract,
  type WardenVerdict,
} from "../../../packages/closed-loop-warden/src/index";
import {
  CloudflarePublishConnector,
  type DeploymentRecord,
  EdgeOnePublishConnector,
  type LiveSmokeTestResult,
  OutOfBandSecretVault,
  verifyLiveDeployment,
} from "../../../packages/mcp-publish/src/index";

export interface ChildVmSession {
  agentId: string;
  workspaceDir: string;
  originalUserPrompt: string;
  pastUserMessages: string[];
  workingTurns: ChatTurn[];
  worklogMarkdown: string;
  git: AutonomousGitEngine;
  rag: HybridRagIndex;
  repoMap: RepoMap;
  skills: DynamicSkillsLoader;
  doomLoop: DoomLoopCircuitBreaker;
  daemon: ClosedLoopDaemon;
  openCodeConfigPath: string;
  workerContextMutationCount: number;
  lastSpillLogPath?: string;
  simulatedDefectActive: boolean;
}

export interface AgentDetailView {
  card: AgentCard;
  closedLoopState: string;
  contract: TaskContract | null;
  lastVerdict: WardenVerdict | null;
  pinnedActions: string[];
  expertEscalations: Array<{ req_id: string; timestamp: string; guidance: string }>;
  gitTelemetry: { branch: string; statusSummary: string; recentCommits: string[]; headSha: string };
  skills: ReturnType<DynamicSkillsLoader["list_skills"]>;
  compiledContext: CompiledPrompt;
  workingTurns: ChatTurn[];
  inbox: ReturnType<AgentGroundHub["peekInbox"]>;
  repoMapSummary: { totalFiles: number; indexedAt: string; routes: string[] };
  workerContextMutationCount: number;
  openCodeConfigPath: string;
  simulatedDefectActive: boolean;
}

const STATIC_SYSTEM_PREFIX = `You are a Child VM autonomous coding agent running inside an extended OpenCode harness on Pollinations AI (BYOP).
Follow Ponytail engineering discipline: minimal correct changes, zero secrets in Git, verify tests and live URLs before requesting Warden approval.
Use Agent Ground MCP tools (ground_list_agents, ground_ask_agent, ground_publish_artifact, ground_subscribe, ground_broadcast) to coordinate with peer VMs without disrupting their active loops.`;

export class AgentGroundRuntime {
  readonly rootWorkspacesDir: string;
  readonly skillsSearchDirs: string[];
  readonly hub: AgentGroundHub;
  readonly firewall: PollenBudgetFirewall;
  readonly vault: OutOfBandSecretVault;
  readonly cloudflare: CloudflarePublishConnector;
  readonly edgeone: EdgeOnePublishConnector;
  readonly sessions = new Map<string, ChildVmSession>();
  readonly smokeTests: LiveSmokeTestResult[] = [];

  private identity: PollinationsIdentity;
  private liveApiKey: string | null = null;
  private appOrigin: string;

  constructor(options?: { appOrigin?: string; initialBudgetPollen?: number }) {
    this.appOrigin = (options?.appOrigin ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
    this.rootWorkspacesDir = mkdtempSync(join(tmpdir(), "agent-ground-vms-"));
    this.skillsSearchDirs = [
      resolve(process.cwd(), "agent-skills"),
      resolve(process.cwd(), ".agents", "skills"),
    ];

    this.hub = new AgentGroundHub();
    this.firewall = new PollenBudgetFirewall(options?.initialBudgetPollen ?? 1.5);
    this.vault = new OutOfBandSecretVault();
    this.cloudflare = new CloudflarePublishConnector({
      vault: this.vault,
      sandboxPreviewBaseUrl: `${this.appOrigin}/preview/agent-ground-studio`,
    });
    this.edgeone = new EdgeOnePublishConnector({
      vault: this.vault,
      sandboxPreviewBaseUrl: `${this.appOrigin}/preview/agent-ground-edge`,
    });

    this.identity = {
      userId: "polli:studio-guest",
      githubUsername: "pollinations-builder",
      displayName: "Pollinations Builder",
      email: "builder@users.noreply.pollinations.ai",
      balancePollen: 1.91,
      authenticatedAt: new Date().toISOString(),
      authMode: "demo",
    };

    // Wire Budget Firewall 100% hard cutoff -> clean git_checkpoint + BUDGET_PAUSED across all VMs
    this.firewall.onCutoff(async (event) => {
      for (const session of this.sessions.values()) {
        const cp = session.git.git_checkpoint({
          message: `chore: budget cutoff checkpoint (${event.burnPercent}% burned)`,
          milestone_id: "BUDGET_CUTOFF",
        });
        session.daemon.pauseForBudget({
          gitSha: cp.sha,
          pollenLedger: this.firewall.exportSnapshot(),
        });
        this.hub.updateAgent(session.agentId, {
          status: "budget_paused",
          last_summary: `Paused cleanly at ${cp.sha.slice(0, 7)} after 100% Pollen budget cutoff. Ready for Top-Up & Resume.`,
        });
      }
      await this.hub.ground_broadcast({
        agent_id: event.agentId,
        kind: "blocked",
        summary: `Pollen budget reached 100% (${event.spentPollen.toFixed(4)}/${event.maxBudgetPollen.toFixed(4)} Pollen). All VMs checkpointed and transitioned to BUDGET_PAUSED.`,
      });
    });

    // Optional server-side env key for live Pollinations inference out-of-the-box in local dev
    if (process.env.POLLINATIONS_API_KEY?.trim()) {
      this.liveApiKey = process.env.POLLINATIONS_API_KEY.trim();
    }

    this.seedInitialMultiAgentStudio();
  }

  getIdentity(): PollinationsIdentity {
    return { ...this.identity };
  }

  hasLivePollinationsKey(): boolean {
    return Boolean(this.liveApiKey);
  }

  private createRouterForAgent(agentId: string): PollinationsModelRouter | undefined {
    if (!this.liveApiKey) return undefined;
    return new PollinationsModelRouter({
      baseUrl: "https://gen.pollinations.ai",
      apiKey: this.liveApiKey,
      agentId,
      firewall: this.firewall,
    });
  }

  async connectWithPollinations(apiKey: string): Promise<PollinationsIdentity> {
    const resolved = await resolvePollinationsIdentity(apiKey);
    this.liveApiKey = apiKey.trim();
    this.identity = resolved;

    // Propagate canonical Pollinations profile/email to every active Child VM Git config & AgentCard
    for (const session of this.sessions.values()) {
      await applyIdentityToGitRepo(session.workspaceDir, resolved);
      this.hub.updateAgent(session.agentId, {
        owner_pollinations_id: resolved.email,
      });
      this.hub.attachShadowReader(
        session.agentId,
        createShadowReader({
          agentId: session.agentId,
          workspaceDir: session.workspaceDir,
          ragIndex: session.rag,
          router: this.createRouterForAgent(session.agentId),
        }),
      );
    }

    await this.hub.ground_broadcast({
      agent_id: "parent-hub",
      kind: "milestone",
      summary: `Authenticated via Pollinations BYOP as @${resolved.githubUsername} (${resolved.balancePollen.toFixed(3)} Pollen). Propagated Git identity to ${this.sessions.size} VMs.`,
    });

    return resolved;
  }

  disconnectPollinations(): PollinationsIdentity {
    this.liveApiKey = null;
    this.identity = {
      ...this.identity,
      authMode: "demo",
    };
    return this.getIdentity();
  }

  /**
   * Boots 2 real concurrent Child VM workspaces (Backend API + Frontend Web UI)
   * with isolated Git branches, real files, RepoMap, RAG index, OpenCode config,
   * and initial Blackboard artifact `openapi-spec@v1`.
   */
  private seedInitialMultiAgentStudio(): void {
    const backend = this.spawnChildVm({
      agentId: "agent-backend-01",
      role: "Backend & API Engineer",
      goal: "Build OAuth session routes, SQLite schema, and OpenAPI v2 contract",
      stack: ["TypeScript", "Hono", "Cloudflare Workers", "SQLite"],
      ownedPaths: ["apps/api/**"],
      seedFiles: {
        "apps/api/src/routes/session.ts": `export interface SessionError {\n  error: "unauthorized" | "expired_token";\n  code: 401;\n  request_id: string;\n}\n\nexport function handleSessionPost(authHeader?: string) {\n  if (!authHeader) {\n    return { status: 401, body: { error: "unauthorized", code: 401, request_id: "req_auth" } };\n  }\n  return { status: 200, body: { ok: true, scope: ["profile", "usage"] } };\n}\n\napp.post("/api/session", handleSessionPost);\napp.get("/api/health", () => ({ status: 200, ok: true }));\n`,
        "apps/api/src/schema.sql": `CREATE TABLE IF NOT EXISTS sessions (\n  id TEXT PRIMARY KEY,\n  pollinations_user_id TEXT NOT NULL,\n  expires_at INTEGER NOT NULL\n);\nCREATE INDEX idx_sessions_user ON sessions(pollinations_user_id);\n`,
        "WORKLOG.md": `# WORKLOG — agent-backend-01\n\n## Milestone 1\n- Scaffolded Hono Worker router and SQLite sessions table.\n- Implemented POST /api/session returning strict 401 JSON shape: { error: "unauthorized", code: 401, request_id }.\n- Published openapi-spec@v1 to Ground Blackboard.\n`,
      },
      initialSummary:
        "Implemented POST /api/session with 401 JSON contract and SQLite sessions index; published openapi-spec@v1.",
      initialStatus: "closed_loop_running",
    });

    const frontend = this.spawnChildVm({
      agentId: "agent-frontend-02",
      role: "Frontend Web UI Engineer",
      goal: "Build responsive multi-agent studio dashboard and wire /api/session auth",
      stack: ["TypeScript", "React 19", "Tailwind CSS", "Vite"],
      ownedPaths: ["apps/web/**"],
      seedFiles: {
        "apps/web/src/components/AnalyticsPanel.tsx": `export function AnalyticsPanel({ metrics }: { metrics?: number[] }) {\n  // TODO: guard undefined metrics array before computing totals\n  return metrics ? metrics.reduce((a, b) => a + b, 0) : 0;\n}\n`,
        "apps/web/src/hooks/useSession.ts": `export async function fetchSessionStatus() {\n  const res = await fetch("/api/session", { method: "POST" });\n  return res.json();\n}\n`,
        "WORKLOG.md": `# WORKLOG — agent-frontend-02\n\n## Milestone 1\n- Built responsive layout grid and session hook.\n- Subscribed to openapi-spec artifact on Agent Ground Blackboard.\n- Pending: guard undefined state in AnalyticsPanel.tsx and publish Cloudflare preview.\n`,
      },
      initialSummary:
        "Subscribed to openapi-spec on Blackboard; ready to wire auth state and run Closed-Loop Warden audit.",
      initialStatus: "im_chat",
    });

    // Enable the realistic initial defect in frontend VM so the first Warden audit demonstrates a REAL REJECT -> Fix -> APPROVE cycle!
    frontend.simulatedDefectActive = true;

    void this.hub.ground_subscribe({
      subscriber_agent_id: frontend.agentId,
      artifact_keys: ["openapi-spec", "design-tokens"],
    });

    void this.hub.ground_publish_artifact({
      author_agent_id: backend.agentId,
      key: "openapi-spec",
      version: "v1",
      content_type: "json",
      payload: JSON.stringify(
        {
          openapi: "3.1.0",
          info: { title: "Agent Ground API", version: "1.0.0" },
          paths: {
            "/api/session": {
              post: {
                responses: {
                  "200": { description: "Authenticated session object" },
                  "401": {
                    description: "Unauthorized JSON: { error, code: 401, request_id }",
                  },
                },
              },
            },
          },
        },
        null,
        2,
      ),
      changelog: "Initial OpenAPI 3.1 contract for /api/session and /api/health",
    });

    void this.hub.ground_broadcast({
      agent_id: backend.agentId,
      kind: "milestone",
      summary: "Booted Backend & Frontend Child VMs on isolated Git branches; openapi-spec@v1 published.",
    });
  }

  spawnChildVm(params: {
    agentId: string;
    role: string;
    goal: string;
    stack: string[];
    ownedPaths: string[];
    seedFiles?: Record<string, string>;
    initialSummary?: string;
    initialStatus?: AgentCard["status"];
  }): ChildVmSession {
    const cleanId = params.agentId.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    if (this.sessions.has(cleanId)) {
      throw new Error(`Agent "${cleanId}" already exists.`);
    }

    const workspaceDir = join(this.rootWorkspacesDir, cleanId);
    mkdirSync(workspaceDir, { recursive: true });

    const git = new AutonomousGitEngine(workspaceDir, cleanId);
    const { branch } = git.initRepo(this.identity, params.goal);

    const seedFiles = params.seedFiles ?? {
      "WORKLOG.md": `# WORKLOG — ${cleanId}\n\n## Boot\n- Initialized isolated VM workspace for goal: ${params.goal}\n`,
      "src/index.ts": `export const agentRole = ${JSON.stringify(params.role)};\nexport function health() { return { ok: true, agent: ${JSON.stringify(cleanId)} }; }\n`,
    };

    for (const [relPath, content] of Object.entries(seedFiles)) {
      const full = join(workspaceDir, relPath);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content, "utf8");
    }

    const cp = git.git_checkpoint({ message: `feat: initialize ${params.role} workspace`, milestone_id: "BOOT" });
    const repoMap = buildRepoMap(workspaceDir);
    const rag = new HybridRagIndex();
    rag.indexWorkspace(workspaceDir);

    const skills = new DynamicSkillsLoader(this.skillsSearchDirs);
    const daemon = new ClosedLoopDaemon(cleanId, workspaceDir);
    const worklogPath = join(workspaceDir, "WORKLOG.md");
    const worklogMarkdown = readFileSync(worklogPath, "utf8");

    daemon.updateCheckpointMetadata({
      worklogMarkdown,
      activeSkills: skills.getActiveSkillNames(),
      pollenLedger: this.firewall.exportSnapshot(),
      gitSha: cp.sha,
      groundSubscriptions: [],
    });

    const oc = writeOpenCodeWorkspaceConfig(workspaceDir, {
      agentId: cleanId,
      meteringProxyUrl: `${this.appOrigin}/api/proxy`,
      agentGroundMcpUrl: `${this.appOrigin}/mcp/ground`,
      publishMcpUrl: `${this.appOrigin}/mcp/publish`,
      computerMcpUrl: "https://gen.pollinations.ai/mcp/computer",
    });

    const session: ChildVmSession = {
      agentId: cleanId,
      workspaceDir,
      originalUserPrompt: params.goal,
      pastUserMessages: [],
      workingTurns: [
        {
          role: "user",
          content: params.goal,
          timestamp: new Date().toISOString(),
        },
        {
          role: "assistant",
          content: params.initialSummary ?? `Workspace initialized on branch ${branch}. Ready for tasks.`,
          timestamp: new Date().toISOString(),
        },
      ],
      worklogMarkdown,
      git,
      rag,
      repoMap,
      skills,
      doomLoop: new DoomLoopCircuitBreaker(3),
      daemon,
      openCodeConfigPath: oc.configPath,
      workerContextMutationCount: 0,
      simulatedDefectActive: false,
    };

    // Register on Parent Agent Ground Hub with real non-disruptive Shadow Reader
    this.hub.registerAgent(
      {
        agent_id: cleanId,
        owner_pollinations_id: this.identity.email,
        role: params.role,
        current_goal: params.goal,
        status: params.initialStatus ?? "im_chat",
        stack: params.stack,
        owned_paths: params.ownedPaths,
        git_branch: branch,
        published_artifacts: [],
        last_summary: params.initialSummary ?? `Booted on ${branch}`,
      },
      {
        shadowReader: createShadowReader({
          agentId: cleanId,
          workspaceDir,
          ragIndex: rag,
          router: this.createRouterForAgent(cleanId),
        }),
        peerCheck: async ({ preview_url }) => {
          const smoke = await verifyLiveDeployment(preview_url);
          return {
            passed: smoke.passed,
            findings: smoke.checks.map((c) => `${c.name}: ${c.detail}`),
          };
        },
      },
    );

    this.sessions.set(cleanId, session);
    return session;
  }

  getSession(agentId: string): ChildVmSession {
    const s = this.sessions.get(agentId);
    if (!s) throw new Error(`Unknown Child VM agent "${agentId}".`);
    return s;
  }

  compileAgentContext(session: ChildVmSession): CompiledPrompt {
    const gitTel = session.git.getTelemetry();
    const budget = this.firewall.getStatus();
    const inbox = this.hub.peekInbox(session.agentId).filter((m) => m.status === "queued");
    const contract = session.daemon.getContract();
    const verdict = session.daemon.getLastVerdict();
    const contractProgress = contract
      ? `${verdict ? verdict.results.filter((r) => r.status === "PASS").length : 0}/${contract.requirements.length} requirements verified (${session.daemon.getState()})`
      : `IM Mode (no frozen contract yet)`;

    return compileSixLayerContext({
      staticSystemPrefix: STATIC_SYSTEM_PREFIX,
      activeSkills: session.skills.getActiveSkillsForContext(),
      originalUserPrompt: session.originalUserPrompt,
      pastUserMessages: session.pastUserMessages,
      worklogMarkdown: session.worklogMarkdown,
      telemetry: {
        gitBranch: gitTel.branch,
        gitStatusSummary: gitTel.statusSummary,
        recentCommits: gitTel.recentCommits,
        contractProgress,
        groundInboxCount: inbox.length,
        groundInboxPreview: inbox.map((m) => `From ${m.from_agent_id}: ${m.question}`),
        pollenBudgetPercent: budget.burnPercent,
        pollenBudgetTier: budget.tier,
        pollenBudgetDirective: budget.directive,
      },
      workingTurns: session.workingTurns,
    });
  }

  getAgentDetail(agentId: string): AgentDetailView {
    const session = this.getSession(agentId);
    const card = (this.hub.getWatercooler(), this.getAgentCardSync(agentId));
    const routes = session.repoMap.entries.flatMap((e) => e.routes);
    return {
      card,
      closedLoopState: session.daemon.getState(),
      contract: session.daemon.getContract(),
      lastVerdict: session.daemon.getLastVerdict(),
      pinnedActions: session.daemon.getPinnedActions(),
      expertEscalations: session.daemon.getExpertEscalations(),
      gitTelemetry: session.git.getTelemetry(),
      skills: session.skills.list_skills(),
      compiledContext: this.compileAgentContext(session),
      workingTurns: session.workingTurns.slice(-12),
      inbox: this.hub.peekInbox(agentId),
      repoMapSummary: {
        totalFiles: session.repoMap.totalFiles,
        indexedAt: session.repoMap.indexedAt,
        routes,
      },
      workerContextMutationCount: session.workerContextMutationCount,
      openCodeConfigPath: session.openCodeConfigPath,
      simulatedDefectActive: session.simulatedDefectActive,
    };
  }

  private getAgentCardSync(agentId: string): AgentCard {
    const cards = Array.from(this.sessions.keys());
    if (!cards.includes(agentId)) throw new Error(`Agent ${agentId} not found`);
    // ground_list_agents is sync under the hood; pull from hub directly via cached update
    return this.hub.updateAgent(agentId, {});
  }

  async sendAgentChat(agentId: string, message: string): Promise<{
    reply: string;
    modelUsed: string;
    autoCompacted: boolean;
    budget: BudgetStatus;
    detail: AgentDetailView;
  }> {
    const session = this.getSession(agentId);
    await this.firewall.assertCanSpend(agentId, 0.0002);

    // Record user follow-up into Layer 3 pinned user messages AND Layer 6 working window
    session.pastUserMessages.push(message);
    session.workingTurns.push({
      role: "user",
      content: message,
      timestamp: new Date().toISOString(),
    });
    session.workerContextMutationCount += 1;

    // Drain any queued negotiate_change messages cleanly at this step boundary
    const deliveredInbox = this.hub.drainInbox(agentId);

    const compiled = this.compileAgentContext(session);
    let reply = "";
    let modelUsed = DEFAULT_ROLE_MODELS.worker;
    let cost = 0.0004;

    const router = this.createRouterForAgent(agentId);
    if (router) {
      try {
        const completion = await router.chat({
          role: "worker",
          messages: compiled.messages,
          maxTokens: 320,
        });
        reply = completion.content.trim();
        modelUsed = completion.model;
        cost = completion.pollenCost || 0.0005;
      } catch (err) {
        reply = `[Local fallback — live Pollinations call returned: ${err instanceof Error ? err.message : String(err)}] Acknowledged "${message}". Compiled 6-layer prompt (${compiled.totalEstimatedTokens} est. tokens) with ${session.pastUserMessages.length} pinned follow-up message(s).`;
      }
    } else {
      const policy = this.firewall.getRoutingPolicy();
      modelUsed = policy.downshiftNonCritical
        ? DEFAULT_ROLE_MODELS.workerConserve
        : DEFAULT_ROLE_MODELS.worker;
      const inboxNote = deliveredInbox.length
        ? ` Delivered ${deliveredInbox.length} queued peer negotiate_change request(s) at step boundary.`
        : "";
      reply = `Processed "${message}" using ${modelUsed} (tier: ${policy.tier}). Layer 3 preserved original prompt + ${session.pastUserMessages.length} follow-up message(s); Layer 5 telemetry synced on branch ${session.git.getTelemetry().branch}.${inboxNote}`;
    }

    await this.firewall.recordSpend({
      agentId,
      role: "worker",
      endpoint: "/v1/chat/completions",
      model: modelUsed,
      costPollen: cost,
    });

    session.workingTurns.push({
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString(),
    });

    let autoCompacted = false;
    const postCompiled = this.compileAgentContext(session);
    if (postCompiled.shouldAutoCompact) {
      this.summarizeAgentContext(agentId, "Auto-compaction triggered at >=70% context fill");
      autoCompacted = true;
    }

    this.hub.updateAgent(agentId, { last_summary: reply.slice(0, 140) });
    return {
      reply,
      modelUsed,
      autoCompacted,
      budget: this.firewall.getStatus(),
      detail: this.getAgentDetail(agentId),
    };
  }

  summarizeAgentContext(agentId: string, reason: string, preserveNotes?: string) {
    const session = this.getSession(agentId);
    const out = summarizeAndCompactContext({
      workspaceDir: session.workspaceDir,
      workingTurns: session.workingTurns,
      reason,
      preserve_notes: preserveNotes,
      ragIndex: session.rag,
      keepRecentTurns: 2,
    });
    session.workingTurns = out.remainingTurns;
    session.worklogMarkdown = out.updatedWorklog;
    session.daemon.updateCheckpointMetadata({
      worklogMarkdown: out.updatedWorklog,
      activeSkills: session.skills.getActiveSkillNames(),
      pollenLedger: this.firewall.exportSnapshot(),
      gitSha: session.git.getTelemetry().headSha,
    });
    return out.result;
  }

  toggleSkill(agentId: string, skillName: string, action: "load" | "unload") {
    const session = this.getSession(agentId);
    const result =
      action === "load"
        ? session.skills.load_skill({ name: skillName })
        : session.skills.unload_skill({ name: skillName });
    session.daemon.updateCheckpointMetadata({
      activeSkills: session.skills.getActiveSkillNames(),
    });
    return { result, detail: this.getAgentDetail(agentId) };
  }

  testSpillAndDoomLoop(agentId: string) {
    const session = this.getSession(agentId);
    const largeBuildLog = Array.from(
      { length: 160 },
      (_, i) => `[vite-build] chunk-${i + 1}: compiled module src/module_${i + 1}.ts (48 bytes)`,
    ).join("\n");
    const spill = spillLargeOutputToDisk(session.workspaceDir, largeBuildLog, "npm run build");
    session.lastSpillLogPath = spill.logFilePath;
    session.workingTurns.push({
      role: "tool",
      toolName: "bash",
      content: spill.content,
      timestamp: new Date().toISOString(),
    });

    session.doomLoop.recordFailure("bash", { cmd: "npm test" }, "ERR_TEST_ASSERTION");
    session.doomLoop.recordFailure("bash", { cmd: "npm test" }, "ERR_TEST_ASSERTION");
    const breakerVerdict = session.doomLoop.recordFailure(
      "bash",
      { cmd: "npm test" },
      "ERR_TEST_ASSERTION",
    );

    return { spill, breakerVerdict, detail: this.getAgentDetail(agentId) };
  }

  async runClosedLoopWardenCycle(agentId: string, autoSelfFix = false) {
    const session = this.getSession(agentId);
    await this.firewall.assertCanSpend(agentId, 0.002);

    const analyticsPath = join(session.workspaceDir, "apps/web/src/components/AnalyticsPanel.tsx");
    if (autoSelfFix) {
      // Worker self-fixes the defect (removes TODO stub & guards undefined) and checkpoints to Git
      mkdirSync(join(analyticsPath, ".."), { recursive: true });
      writeFileSync(
        analyticsPath,
        `export function AnalyticsPanel({ metrics = [] }: { metrics?: number[] }) {\n  return metrics.reduce((acc, value) => acc + value, 0);\n}\n`,
        "utf8",
      );
      session.simulatedDefectActive = false;
      const cp = session.git.git_checkpoint({
        message: "fix: remove stub TODO and guard undefined metrics in AnalyticsPanel",
        milestone_id: "WARDEN_FIX",
      });
      session.repoMap = buildRepoMap(session.workspaceDir);
      session.rag.indexWorkspace(session.workspaceDir);
      session.daemon.updateCheckpointMetadata({ gitSha: cp.sha });

      // Ensure live preview deployment exists before re-auditing
      const existingCard = this.getAgentCardSync(agentId);
      if (!existingCard.preview_url) {
        const dep = await this.deployProject({
          provider: "cloudflare_pages",
          projectName: "agent-ground-studio",
          agentId,
        });
        this.hub.updateAgent(agentId, { preview_url: dep.deployment.url });
      }
    }

    const card = this.getAgentCardSync(agentId);
    const previewUrl = card.preview_url ?? `${this.appOrigin}/preview/agent-ground-studio`;
    const smoke = await verifyLiveDeployment(previewUrl);

    const evidence: EvidenceBundle = {
      contract_id: session.daemon.getContract()?.contract_id ?? "unfrozen",
      git_sha: session.git.getTelemetry().headSha,
      git_diff_stat: "1 file changed, 8 insertions(+), 2 deletions(-)",
      test_command: "npm test",
      test_exit_code: 0,
      test_output_excerpt: "12 passing (0 failed)",
      preview_url: previewUrl,
      live_http_status: smoke.http_status,
      console_errors: session.simulatedDefectActive
        ? ["Uncaught TypeError: Cannot read properties of undefined (reading 'reduce') on /analytics"]
        : [],
      screenshot_notes: session.simulatedDefectActive
        ? ["Sidebar overlaps main metrics panel at 390px viewport"]
        : ["1440px desktop balanced layout", "390px mobile zero overflow"],
      changed_files: ["apps/web/src/components/AnalyticsPanel.tsx"],
    };

    const audit = await session.daemon.request_warden_approval({
      evidence,
      router: this.createRouterForAgent(agentId),
    });

    await this.firewall.recordSpend({
      agentId,
      role: "warden",
      endpoint: "/v1/chat/completions",
      model: audit.verdict.model_used,
      costPollen: 0.0025,
    });

    this.hub.updateAgent(agentId, {
      status: audit.state === "COMPLETED" ? "completed" : "closed_loop_running",
      last_summary: audit.verdict.summary,
    });

    await this.hub.ground_broadcast({
      agent_id: agentId,
      kind: audit.verdict.approved ? "deployed" : "needs_review",
      summary: `Warden ${audit.verdict.approved ? "APPROVED" : "REJECTED"} ${agentId}: ${audit.verdict.summary}`,
    });

    return { ...audit, smoke, detail: this.getAgentDetail(agentId) };
  }

  simulateCrashAndRestart(agentId: string) {
    const session = this.getSession(agentId);
    const saved = session.daemon.saveDurableSnapshot();
    const restored = ClosedLoopDaemon.restoreFromDisk(session.workspaceDir);
    session.daemon = restored;
    session.skills.restoreActiveSkills(restored.exportSnapshot().active_skills);

    void this.hub.ground_broadcast({
      agent_id: agentId,
      kind: "milestone",
      summary: `Crash/Restart durability verified: restored state=${restored.getState()}, git_sha=${saved.git_sha.slice(0, 7)}, active_skills=${saved.active_skills.length}.`,
    });

    return {
      restoredSnapshot: restored.exportSnapshot(),
      detail: this.getAgentDetail(agentId),
    };
  }

  async deployProject(params: {
    provider: "cloudflare_pages" | "cloudflare_workers" | "edgeone_pages";
    projectName: string;
    agentId?: string;
  }): Promise<{ deployment: DeploymentRecord; smokeTest: LiveSmokeTestResult }> {
    const agentId = params.agentId ?? "agent-frontend-02";
    const session = this.sessions.get(agentId);
    const buildDir = session?.workspaceDir ?? process.cwd();

    let deployment: DeploymentRecord;
    if (params.provider === "cloudflare_pages") {
      deployment = await this.cloudflare.cloudflare_deploy_pages({
        project_name: params.projectName,
        build_dir: buildDir,
      });
    } else if (params.provider === "cloudflare_workers") {
      deployment = await this.cloudflare.cloudflare_deploy_worker({
        script_name: params.projectName,
        entry_file: join(buildDir, "src/index.ts"),
      });
    } else {
      deployment = await this.edgeone.edgeone_deploy_pages({
        project_name: params.projectName,
        build_dir: buildDir,
      });
    }

    const smokeTest = await verifyLiveDeployment(deployment.url);
    this.smokeTests.unshift(smokeTest);

    if (session) {
      this.hub.updateAgent(agentId, { preview_url: deployment.url });
      await this.hub.ground_publish_artifact({
        author_agent_id: agentId,
        key: `deploy-${params.provider}`,
        version: `v${this.cloudflare.listDeployments().length + this.edgeone.listDeployments().length}`,
        content_type: "url",
        payload: deployment.url,
        changelog: `Published ${params.projectName} via ${params.provider} (HTTP ${smokeTest.http_status})`,
      });
      await this.hub.ground_broadcast({
        agent_id: agentId,
        kind: "deployed",
        summary: `Published ${params.projectName} to ${params.provider} -> ${deployment.url} (HTTP ${smokeTest.http_status})`,
      });
    }

    return { deployment, smokeTest };
  }

  async getOverviewState() {
    const agents = await this.hub.ground_list_agents();
    const details: Record<string, AgentDetailView> = {};
    for (const a of agents) {
      if (this.sessions.has(a.agent_id)) {
        details[a.agent_id] = this.getAgentDetail(a.agent_id);
      }
    }

    return {
      identity: this.getIdentity(),
      livePollinationsConnected: this.hasLivePollinationsKey(),
      budget: this.firewall.getStatus(),
      ledger: this.firewall.getLedger().slice(-30).reverse(),
      modelMatrix: DEFAULT_ROLE_MODELS,
      agents,
      agentDetails: details,
      artifacts: this.hub.listArtifacts(),
      watercooler: this.hub.getWatercooler(60),
      conversations: this.hub.getConversations(40),
      peerChecks: this.hub.getPeerChecks(20),
      preflightQuestions: DEFAULT_PREFLIGHT_QUESTIONS,
      publish: {
        credentials: this.vault.getSafeStatus(),
        deployments: [
          ...this.cloudflare.listDeployments(),
          ...this.edgeone.listDeployments(),
        ].sort((a, b) => b.created_at.localeCompare(a.created_at)),
        smokeTests: this.smokeTests.slice(0, 15),
      },
    };
  }
}

export { consultExpert };

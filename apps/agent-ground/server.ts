import "dotenv/config";
import express from "express";
import { createServer as createViteServer } from "vite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  type ArtifactContentType,
  type BroadcastKind,
  handleAgentGroundMcpRequest,
} from "../../packages/agent-ground-mcp/src/index";
import { handlePublishMcpRequest } from "../../packages/mcp-publish/src/index";
import { BudgetExhaustedError } from "../../packages/pollinations-byop-proxy/src/index";
import { ClosedLoopHumanInputDisabledError } from "../../packages/closed-loop-warden/src/index";
import { AgentGroundRuntime, consultExpert } from "./server/runtime";

const PORT = Number(process.env.PORT ?? 3000);
const isProduction = process.env.NODE_ENV === "production";

async function startServer() {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  const runtime = new AgentGroundRuntime({
    appOrigin: `http://127.0.0.1:${PORT}`,
    initialBudgetPollen: 1.5,
  });

  // Live sandbox preview route so Publish MCP HTTP 200 smoke tests & Warden checks pass against a real HTTP server
  app.get("/preview/:project", (req, res) => {
    const project = req.params.project.replace(/[^a-z0-9-_]/gi, "");
    res
      .status(200)
      .type("html")
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${project} — Live Preview</title></head><body><main><h1>${project}</h1><p>Deployed autonomously by Agent Ground Publish MCP.</p></main></body></html>`,
      );
  });

  // Streamable HTTP JSON-RPC 2.0 MCP endpoints for Child VM OpenCode harnesses
  app.post("/mcp/ground", async (req, res) => {
    const callerId = req.headers["x-agent-id"] ? String(req.headers["x-agent-id"]) : undefined;
    const reply = await handleAgentGroundMcpRequest(runtime.hub, req.body, callerId);
    res.json(reply);
  });

  app.post("/mcp/publish", async (req, res) => {
    const reply = await handlePublishMcpRequest(
      {
        vault: runtime.vault,
        cloudflare: runtime.cloudflare,
        edgeone: runtime.edgeone,
      },
      req.body,
    );
    res.json(reply);
  });

  // Overview state
  app.get("/api/state", async (_req, res) => {
    res.json(await runtime.getOverviewState());
  });

  // Pollinations BYOP Connect (receives scoped sk_ token from <polli-connect> via Authorization Bearer header)
  app.post("/api/auth/connect", async (req, res) => {
    try {
      const authHeader = String(req.headers.authorization ?? "");
      const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
      const token = bearer || String(req.body?.apiKey ?? "").trim();
      if (!token) {
        res.status(400).json({ error: "Missing Pollinations BYOP authorization token." });
        return;
      }
      const identity = await runtime.connectWithPollinations(token);
      res.json({ identity, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(401).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/auth/disconnect", async (_req, res) => {
    const identity = runtime.disconnectPollinations();
    res.json({ identity, state: await runtime.getOverviewState() });
  });

  // Pollen Budget Firewall endpoints
  app.post("/api/budget/cap", async (req, res) => {
    try {
      const maxPollen = Number(req.body?.maxBudgetPollen);
      const budget = runtime.firewall.setMaxBudget(maxPollen);
      res.json({ budget, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/budget/topup", async (req, res) => {
    try {
      const amount = Number(req.body?.additionalPollen ?? 0.5);
      const budget = runtime.firewall.topUpAndResume(amount);
      for (const session of runtime.sessions.values()) {
        const nextState = session.daemon.resumeFromBudgetPause(
          runtime.firewall.exportSnapshot(),
        );
        runtime.hub.updateAgent(session.agentId, {
          status: nextState === "AUTONOMOUS_EXECUTION" ? "closed_loop_running" : "im_chat",
          last_summary: `Resumed after +${amount.toFixed(2)} Pollen top-up.`,
        });
      }
      await runtime.hub.ground_broadcast({
        agent_id: "parent-hub",
        kind: "milestone",
        summary: `Top-Up & Resume completed (+${amount.toFixed(2)} Pollen). New cap: ${budget.maxBudgetPollen.toFixed(2)} Pollen.`,
      });
      res.json({ budget, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/budget/simulate-burn", async (req, res) => {
    const amount = Number(req.body?.amountPollen ?? 0.35);
    const agentId = String(req.body?.agentId ?? "agent-backend-01");
    const rec = await runtime.firewall.recordSpend({
      agentId,
      role: "worker",
      endpoint: "/v1/chat/completions",
      model: "openai/gpt-5.4-mini",
      costPollen: amount,
    });
    res.json({ ...rec, state: await runtime.getOverviewState() });
  });

  // Spawn new Child VM Agent
  app.post("/api/agents/spawn", async (req, res) => {
    try {
      const { agentId, role, goal, stack, ownedPaths } = req.body ?? {};
      if (!agentId || !role || !goal || !Array.isArray(ownedPaths) || ownedPaths.length === 0) {
        res.status(400).json({ error: "agentId, role, goal, and ownedPaths[] are required." });
        return;
      }
      runtime.spawnChildVm({
        agentId: String(agentId),
        role: String(role),
        goal: String(goal),
        stack: Array.isArray(stack) ? stack.map(String) : ["TypeScript"],
        ownedPaths: ownedPaths.map(String),
      });
      await runtime.hub.ground_broadcast({
        agent_id: String(agentId),
        kind: "milestone",
        summary: `Spawned Child VM (${role}) owning ${ownedPaths.join(", ")}`,
      });
      res.json({ state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Agent IM Chat (routes through 6-Layer Context Compiler & Pollen Metering Firewall)
  app.post("/api/agents/:id/chat", async (req, res) => {
    try {
      const message = String(req.body?.message ?? "").trim();
      if (!message) {
        res.status(400).json({ error: "Message is required." });
        return;
      }
      const result = await runtime.sendAgentChat(req.params.id, message);
      res.json({ ...result, state: await runtime.getOverviewState() });
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        res.status(402).json({ error: err.message, code: "POLLEN_BUDGET_EXHAUSTED", state: await runtime.getOverviewState() });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Agent Ground Shoulder Tap (readonly_query Shadow Reader vs negotiate_change inbox)
  app.post("/api/ground/ask", async (req, res) => {
    try {
      const { fromAgentId, targetAgentId, question, mode } = req.body ?? {};
      if (!targetAgentId || !question) {
        res.status(400).json({ error: "targetAgentId and question are required." });
        return;
      }
      const response = await runtime.hub.ground_ask_agent({
        from_agent_id: fromAgentId ? String(fromAgentId) : "agent-frontend-02",
        target_agent_id: String(targetAgentId),
        question: String(question),
        mode: mode === "negotiate_change" ? "negotiate_change" : "readonly_query",
      });
      res.json({ response, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Blackboard publish artifact
  app.post("/api/ground/artifacts", async (req, res) => {
    try {
      const { authorAgentId, key, version, contentType, payload, changelog } = req.body ?? {};
      if (!key || !version || !payload) {
        res.status(400).json({ error: "key, version, and payload are required." });
        return;
      }
      const published = await runtime.hub.ground_publish_artifact({
        author_agent_id: authorAgentId ? String(authorAgentId) : "agent-backend-01",
        key: String(key),
        version: String(version),
        content_type: (contentType as ArtifactContentType) || "json",
        payload: String(payload),
        changelog: String(changelog || "Updated artifact"),
      });
      res.json({ published, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Watercooler broadcast
  app.post("/api/ground/broadcast", async (req, res) => {
    try {
      const { agentId, kind, summary } = req.body ?? {};
      if (!summary) {
        res.status(400).json({ error: "summary is required." });
        return;
      }
      await runtime.hub.ground_broadcast({
        agent_id: agentId ? String(agentId) : "agent-backend-01",
        kind: (kind as BroadcastKind) || "milestone",
        summary: String(summary),
      });
      res.json({ state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Peer QA Check before Warden
  app.post("/api/ground/peer-check", async (req, res) => {
    try {
      const { requesterAgentId, reviewerAgentId, previewUrl } = req.body ?? {};
      const result = await runtime.hub.ground_request_peer_check({
        requester_agent_id: String(requesterAgentId || "agent-frontend-02"),
        reviewer_agent_id: String(reviewerAgentId || "agent-backend-01"),
        preview_url: String(previewUrl || `http://127.0.0.1:${PORT}/preview/agent-ground-studio`),
      });
      res.json({ result, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Dynamic Skills Loader (load_skill / unload_skill)
  app.post("/api/agents/:id/skills", async (req, res) => {
    try {
      const { name, action } = req.body ?? {};
      const out = runtime.toggleSkill(req.params.id, String(name), action === "unload" ? "unload" : "load");
      res.json({ ...out, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Heavy-Context summarize_context
  app.post("/api/agents/:id/summarize", async (req, res) => {
    try {
      const reason = String(req.body?.reason ?? "Manual context compaction");
      const preserveNotes = req.body?.preserveNotes ? String(req.body.preserveNotes) : undefined;
      const summary = runtime.summarizeAgentContext(req.params.id, reason, preserveNotes);
      res.json({ summary, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Heavy-Context Spill + Doom-Loop + Expert Consult demo
  app.post("/api/agents/:id/diagnostics", async (req, res) => {
    try {
      const out = runtime.testSpillAndDoomLoop(req.params.id);
      const expert = await consultExpert({
        question: "Resolve repeated test assertion failure after doom-loop breaker tripped",
        file_paths: ["apps/web/src/components/AnalyticsPanel.tsx"],
        failed_attempts: ["Retried npm test 3x with identical ERR_TEST_ASSERTION"],
        workspaceDir: runtime.getSession(req.params.id).workspaceDir,
      });
      res.json({ ...out, expert, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Closed-Loop FSM: Start Pre-Flight Interview
  app.post("/api/agents/:id/close-loop", async (req, res) => {
    try {
      const session = runtime.getSession(req.params.id);
      const interview = session.daemon.beginPreflightInterview();
      runtime.hub.updateAgent(req.params.id, { status: "preflight_interview" });
      res.json({ interview, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Closed-Loop FSM: Submit Interview Answers -> Freeze CONTRACT.json -> AUTONOMOUS_EXECUTION
  app.post("/api/agents/:id/freeze-contract", async (req, res) => {
    try {
      const session = runtime.getSession(req.params.id);
      const answers = (req.body?.answers ?? {}) as Record<string, string>;
      const deployTarget = req.body?.deploy_target;
      const contract = session.daemon.freezeContractAndStartAutonomous({
        goal: session.originalUserPrompt,
        answers,
        deploy_target: deployTarget,
      });
      runtime.hub.updateAgent(req.params.id, {
        status: "closed_loop_running",
        last_summary: `Contract ${contract.contract_id} locked (${contract.requirements.length} requirements). Human asking hard-disabled.`,
      });
      await runtime.hub.ground_broadcast({
        agent_id: req.params.id,
        kind: "milestone",
        summary: `Closed the Loop: froze ${contract.contract_id} (${contract.deploy_target}). Entered AUTONOMOUS_EXECUTION.`,
      });
      res.json({ contract, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Closed-Loop Guard Verification: verify human asking throws runtime error during AUTONOMOUS_EXECUTION
  app.post("/api/agents/:id/test-human-guard", (req, res) => {
    try {
      const session = runtime.getSession(req.params.id);
      session.daemon.assertCanAskHuman();
      res.json({ blocked: false, message: "Agent is in interactive mode; human questions are allowed." });
    } catch (err) {
      if (err instanceof ClosedLoopHumanInputDisabledError) {
        res.json({ blocked: true, message: err.message });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Closed-Loop Adversarial Warden Audit (supports REJECT first, then Worker Self-Fix -> APPROVE)
  app.post("/api/agents/:id/warden-audit", async (req, res) => {
    try {
      const autoSelfFix = Boolean(req.body?.autoSelfFix);
      const out = await runtime.runClosedLoopWardenCycle(req.params.id, autoSelfFix);
      res.json({ ...out, state: await runtime.getOverviewState() });
    } catch (err) {
      if (err instanceof BudgetExhaustedError) {
        res.status(402).json({ error: err.message, code: "POLLEN_BUDGET_EXHAUSTED", state: await runtime.getOverviewState() });
        return;
      }
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Multi-Day Crash/Restart Durability test
  app.post("/api/agents/:id/crash-recover", async (req, res) => {
    try {
      const out = runtime.simulateCrashAndRestart(req.params.id);
      res.json({ ...out, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Publish MCP: Cloudflare / EdgeOne autonomous deploy + live HTTP 200 smoke test
  app.post("/api/publish/deploy", async (req, res) => {
    try {
      const { provider, projectName, agentId } = req.body ?? {};
      const out = await runtime.deployProject({
        provider: provider || "cloudflare_pages",
        projectName: String(projectName || "agent-ground-studio"),
        agentId: agentId ? String(agentId) : undefined,
      });
      res.json({ ...out, state: await runtime.getOverviewState() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Serve Vite in dev or static dist/ in production
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = resolve(process.cwd(), "dist");
    if (existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get("*", (_req, res) => {
        res.sendFile(resolve(distDir, "index.html"));
      });
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Agent Ground Control Plane running at http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start Agent Ground server:", err);
  process.exit(1);
});

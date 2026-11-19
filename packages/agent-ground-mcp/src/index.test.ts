import test from "node:test";
import assert from "node:assert/strict";
import { AgentGroundHub, createAgentGroundMcpServer } from "./index";

test("AgentGroundHub coordinates 2 concurrent agents with non-disruptive Shadow Reader & Blackboard sleep wake-up", async () => {
  const hub = new AgentGroundHub();
  const backendWorkerContext: string[] = ["Implementing /api/session POST route"];

  hub.registerAgent(
    {
      agent_id: "agent-backend-01",
      owner_pollinations_id: "NamanSoni78@users.noreply.pollinations.ai",
      role: "Backend & API Engineer",
      current_goal: "Implement OAuth session routes",
      status: "closed_loop_running",
      stack: ["TypeScript", "Hono", "Cloudflare Workers"],
      owned_paths: ["apps/api/**"],
      published_artifacts: [],
      last_summary: "Session endpoint returns { error: 'unauthorized', code: 401 }",
    },
    {
      shadowReader: async ({ question }) => ({
        answer: `On 401, /api/session returns { error: "unauthorized", code: 401 }. (Answered for: ${question})`,
        citations: ["apps/api/src/routes/session.ts:42", "WORKLOG.md#milestone-2"],
      }),
    },
  );

  hub.registerAgent({
    agent_id: "agent-frontend-02",
    owner_pollinations_id: "NamanSoni78@users.noreply.pollinations.ai",
    role: "Frontend Web UI Engineer",
    current_goal: "Build session login form & dashboard",
    status: "sleeping",
    stack: ["TypeScript", "React", "Tailwind CSS"],
    owned_paths: ["apps/web/**"],
    published_artifacts: [],
    last_summary: "Waiting for openapi-spec@v2 before wiring session hook.",
  });

  // Path ownership lock blocks silent overlaps
  assert.throws(() => {
    hub.registerAgent({
      agent_id: "agent-rogue-03",
      owner_pollinations_id: "NamanSoni78@users.noreply.pollinations.ai",
      role: "Rogue Editor",
      current_goal: "Overwrite API",
      status: "im_chat",
      stack: ["TypeScript"],
      owned_paths: ["apps/api/src/**"],
      published_artifacts: [],
      last_summary: "Trying to collide",
    });
  }, /Path ownership conflict/);

  // Shoulder Tap readonly_query returns citations WITHOUT touching backendWorkerContext
  const queryRes = await hub.ground_ask_agent({
    from_agent_id: "agent-frontend-02",
    target_agent_id: "agent-backend-01",
    question: "What JSON shape does /api/session return on 401?",
    mode: "readonly_query",
  });
  assert.equal(queryRes.status, "answered");
  assert.match(queryRes.answer, /401/);
  assert.deepEqual(queryRes.citations, ["apps/api/src/routes/session.ts:42", "WORKLOG.md#milestone-2"]);
  assert.equal(backendWorkerContext.length, 1);
  assert.equal(hub.peekInbox("agent-backend-01").length, 0);

  // Shoulder Tap negotiate_change queues cleanly for next step boundary
  const negRes = await hub.ground_ask_agent({
    from_agent_id: "agent-frontend-02",
    target_agent_id: "agent-backend-01",
    question: "Add CORS header for https://web-preview.pages.dev",
    mode: "negotiate_change",
  });
  assert.equal(negRes.status, "queued");
  const drained = hub.drainInbox("agent-backend-01");
  assert.equal(drained.length, 1);
  assert.equal(drained[0].status, "delivered");

  // Blackboard publish wakes subscribed agent waiting in sleep(until_event)
  await hub.ground_subscribe({
    subscriber_agent_id: "agent-frontend-02",
    artifact_keys: ["openapi-spec"],
  });

  const sleepPromise = hub.waitForEvent({
    agentId: "agent-frontend-02",
    eventType: "ground_artifact",
    maxWaitMs: 3000,
  });

  const published = await hub.ground_publish_artifact({
    author_agent_id: "agent-backend-01",
    key: "openapi-spec",
    version: "v2",
    content_type: "json",
    payload: JSON.stringify({ openapi: "3.1.0", paths: { "/api/session": {} } }),
    changelog: "Added POST /api/session 401 schema",
  });
  assert.equal(published.artifact_uri, "ground://artifacts/openapi-spec@v2");

  const wake = await sleepPromise;
  assert.equal(wake.wake_reason, "ground_artifact:openapi-spec@v2");

  // Verify immutable version protection
  await assert.rejects(
    () =>
      hub.ground_publish_artifact({
        author_agent_id: "agent-backend-01",
        key: "openapi-spec",
        version: "v2",
        content_type: "json",
        payload: "{}",
        changelog: "duplicate",
      }),
    /immutable/,
  );
});

test("Agent Ground MCP HTTP server responds to tools/list and tools/call over JSON-RPC 2.0", async () => {
  const hub = new AgentGroundHub();
  hub.registerAgent({
    agent_id: "agent-api",
    owner_pollinations_id: "dev@pollinations.ai",
    role: "API Engineer",
    current_goal: "Build API",
    status: "im_chat",
    stack: ["TypeScript"],
    owned_paths: ["src/api/**"],
    published_artifacts: [],
    last_summary: "Ready",
  });

  const mcp = createAgentGroundMcpServer(hub);
  const { url } = await mcp.listen(0);
  try {
    const listRes = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const listJson = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    assert.ok(listJson.result.tools.some((t) => t.name === "ground_ask_agent"));

    const callRes = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": "agent-ui" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "ground_list_agents", arguments: {} },
      }),
    });
    const callJson = (await callRes.json()) as {
      result: { structuredContent: Array<{ agent_id: string }> };
    };
    assert.equal(callJson.result.structuredContent[0].agent_id, "agent-api");
  } finally {
    await mcp.close();
  }
});

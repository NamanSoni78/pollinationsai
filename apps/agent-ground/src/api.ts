import type { OverviewState } from "./types";

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
  }
  return data;
}

export const api = {
  getState: () => jsonFetch<OverviewState>("/api/state"),

  connectPollinations: (token: string) =>
    jsonFetch<{ state: OverviewState }>("/api/auth/connect", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    }),

  disconnectPollinations: () =>
    jsonFetch<{ state: OverviewState }>("/api/auth/disconnect", { method: "POST" }),

  setBudgetCap: (maxBudgetPollen: number) =>
    jsonFetch<{ state: OverviewState }>("/api/budget/cap", {
      method: "POST",
      body: JSON.stringify({ maxBudgetPollen }),
    }),

  topUpAndResume: (additionalPollen: number) =>
    jsonFetch<{ state: OverviewState }>("/api/budget/topup", {
      method: "POST",
      body: JSON.stringify({ additionalPollen }),
    }),

  simulateBurn: (amountPollen: number, agentId: string) =>
    jsonFetch<{ state: OverviewState }>("/api/budget/simulate-burn", {
      method: "POST",
      body: JSON.stringify({ amountPollen, agentId }),
    }),

  spawnAgent: (payload: {
    agentId: string;
    role: string;
    goal: string;
    stack: string[];
    ownedPaths: string[];
  }) =>
    jsonFetch<{ state: OverviewState }>("/api/agents/spawn", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  sendChat: (agentId: string, message: string) =>
    jsonFetch<{ reply: string; modelUsed: string; state: OverviewState }>(
      `/api/agents/${encodeURIComponent(agentId)}/chat`,
      { method: "POST", body: JSON.stringify({ message }) },
    ),

  askAgent: (payload: {
    fromAgentId: string;
    targetAgentId: string;
    question: string;
    mode: "readonly_query" | "negotiate_change";
  }) =>
    jsonFetch<{
      response: { answer: string; citations?: string[]; status: string };
      state: OverviewState;
    }>("/api/ground/ask", { method: "POST", body: JSON.stringify(payload) }),

  publishArtifact: (payload: {
    authorAgentId: string;
    key: string;
    version: string;
    contentType: string;
    payload: string;
    changelog: string;
  }) =>
    jsonFetch<{ state: OverviewState }>("/api/ground/artifacts", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  broadcast: (payload: { agentId: string; kind: string; summary: string }) =>
    jsonFetch<{ state: OverviewState }>("/api/ground/broadcast", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  requestPeerCheck: (payload: {
    requesterAgentId: string;
    reviewerAgentId: string;
    previewUrl?: string;
  }) =>
    jsonFetch<{ state: OverviewState }>("/api/ground/peer-check", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  toggleSkill: (agentId: string, name: string, action: "load" | "unload") =>
    jsonFetch<{ state: OverviewState }>(
      `/api/agents/${encodeURIComponent(agentId)}/skills`,
      { method: "POST", body: JSON.stringify({ name, action }) },
    ),

  summarizeContext: (agentId: string, reason: string) =>
    jsonFetch<{ summary: { tokens_freed: number }; state: OverviewState }>(
      `/api/agents/${encodeURIComponent(agentId)}/summarize`,
      { method: "POST", body: JSON.stringify({ reason }) },
    ),

  runDiagnostics: (agentId: string) =>
    jsonFetch<{
      spill: { spilled: boolean; totalBytes: number; totalLines: number };
      breakerVerdict: { tripped: boolean; interventionDirective?: string };
      expert: { guidance: string; model_used: string };
      state: OverviewState;
    }>(`/api/agents/${encodeURIComponent(agentId)}/diagnostics`, { method: "POST" }),

  closeLoop: (agentId: string) =>
    jsonFetch<{ state: OverviewState }>(
      `/api/agents/${encodeURIComponent(agentId)}/close-loop`,
      { method: "POST" },
    ),

  freezeContract: (
    agentId: string,
    answers: Record<string, string>,
    deploy_target: string,
  ) =>
    jsonFetch<{ state: OverviewState }>(
      `/api/agents/${encodeURIComponent(agentId)}/freeze-contract`,
      { method: "POST", body: JSON.stringify({ answers, deploy_target }) },
    ),

  testHumanGuard: (agentId: string) =>
    jsonFetch<{ blocked: boolean; message: string }>(
      `/api/agents/${encodeURIComponent(agentId)}/test-human-guard`,
      { method: "POST" },
    ),

  runWardenAudit: (agentId: string, autoSelfFix = false) =>
    jsonFetch<{ state: OverviewState }>(
      `/api/agents/${encodeURIComponent(agentId)}/warden-audit`,
      { method: "POST", body: JSON.stringify({ autoSelfFix }) },
    ),

  crashRecover: (agentId: string) =>
    jsonFetch<{ state: OverviewState }>(
      `/api/agents/${encodeURIComponent(agentId)}/crash-recover`,
      { method: "POST" },
    ),

  deployProject: (payload: {
    provider: "cloudflare_pages" | "cloudflare_workers" | "edgeone_pages";
    projectName: string;
    agentId: string;
  }) =>
    jsonFetch<{ state: OverviewState }>("/api/publish/deploy", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
};

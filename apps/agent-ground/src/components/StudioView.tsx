import { useState } from "react";
import {
  GitBranch,
  MessageSquare,
  Plus,
  Radio,
  Send,
  Sparkles,
  Layers,
  AlertTriangle,
} from "lucide-react";
import type { AgentDetailView, OverviewState } from "../types";

interface StudioViewProps {
  state: OverviewState;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  busy: boolean;
  onSpawnAgent: (payload: {
    agentId: string;
    role: string;
    goal: string;
    stack: string[];
    ownedPaths: string[];
  }) => Promise<void>;
  onSendChat: (agentId: string, message: string) => Promise<void>;
  onAskAgent: (payload: {
    fromAgentId: string;
    targetAgentId: string;
    question: string;
    mode: "readonly_query" | "negotiate_change";
  }) => Promise<void>;
  onSummarize: (agentId: string, reason: string) => Promise<void>;
  onRunDiagnostics: (agentId: string) => Promise<{
    spill: { spilled: boolean; totalBytes: number; totalLines: number };
    breakerVerdict: { tripped: boolean; interventionDirective?: string };
    expert: { guidance: string; model_used: string };
  }>;
}

export function StudioView({
  state,
  selectedAgentId,
  onSelectAgent,
  busy,
  onSpawnAgent,
  onSendChat,
  onAskAgent,
  onSummarize,
  onRunDiagnostics,
}: StudioViewProps) {
  const detail: AgentDetailView | undefined = state.agentDetails[selectedAgentId];

  // Chat input state
  const [chatMessage, setChatMessage] = useState("");

  // Shoulder Tap state
  const otherAgents = state.agents.filter((a) => a.agent_id !== selectedAgentId);
  const [tapTarget, setTapTarget] = useState(otherAgents[0]?.agent_id ?? "agent-backend-01");
  const [tapMode, setTapMode] = useState<"readonly_query" | "negotiate_change">("readonly_query");
  const [tapQuestion, setTapQuestion] = useState(
    "What exact JSON shape does /api/session return on HTTP 401?",
  );

  // Spawn modal toggle
  const [showSpawn, setShowSpawn] = useState(false);
  const [newId, setNewId] = useState("agent-media-03");
  const [newRole, setNewRole] = useState("Brand & Visual Media Engineer");
  const [newGoal, setNewGoal] = useState("Generate product imagery via Pollinations Image Gen MCP");
  const [newPaths, setNewPaths] = useState("apps/media/**");

  // Watercooler filter
  const [feedFilter, setFeedFilter] = useState<string>("all");

  // Diagnostics output banner & selected layer preview
  const [diagBanner, setDiagBanner] = useState<string | null>(null);
  const [inspectedLayer, setInspectedLayer] = useState<number | null>(null);

  const LAYER_LABELS: Record<number, string> = {
    1: "L1 · Static Prefix",
    2: "L2 · Active Skills",
    3: "L3 · User Intent",
    4: "L4 · Worklog",
    5: "L5 · Telemetry",
    6: "L6 · Working",
  };

  const filteredFeed =
    feedFilter === "all"
      ? state.watercooler
      : state.watercooler.filter((ev) => ev.kind === feedFilter);

  return (
    <div className="space-y-6">
      {/* Main 2-column Studio Split: Left Agent Directory + Right Selected Agent Console */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Concurrent Child VM Directory */}
        <section
          aria-label="Child VM Agents"
          className="lg:col-span-4 bg-white border border-[#E5E7EB] rounded-xl overflow-hidden"
        >
          <div className="px-5 py-4 border-b border-[#E5E7EB] flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[#111827]">
                Active Child VMs ({state.agents.length})
              </h2>
              <p className="text-xs text-[#6B7280]">
                Isolated OpenCode sandboxes &amp; Git branches
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowSpawn((v) => !v)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-[#111827] bg-[#F3F4F6] hover:bg-[#E5E7EB] rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              Spawn VM
            </button>
          </div>

          {showSpawn && (
            <form
              className="p-4 bg-[#FAFAFA] border-b border-[#E5E7EB] space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                await onSpawnAgent({
                  agentId: newId.trim(),
                  role: newRole.trim(),
                  goal: newGoal.trim(),
                  stack: ["TypeScript", "Pollinations Image MCP"],
                  ownedPaths: newPaths
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                });
                setShowSpawn(false);
              }}
            >
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="spawn-id" className="block text-[11px] font-medium text-[#4B5563]">
                    Agent ID
                  </label>
                  <input
                    id="spawn-id"
                    value={newId}
                    onChange={(e) => setNewId(e.target.value)}
                    required
                    className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-[#D1D5DB] rounded-lg"
                  />
                </div>
                <div>
                  <label htmlFor="spawn-paths" className="block text-[11px] font-medium text-[#4B5563]">
                    Owned Paths
                  </label>
                  <input
                    id="spawn-paths"
                    value={newPaths}
                    onChange={(e) => setNewPaths(e.target.value)}
                    required
                    className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-[#D1D5DB] rounded-lg"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="spawn-role" className="block text-[11px] font-medium text-[#4B5563]">
                  Role
                </label>
                <input
                  id="spawn-role"
                  value={newRole}
                  onChange={(e) => setNewRole(e.target.value)}
                  required
                  className="mt-1 w-full px-2.5 py-1.5 text-xs bg-white border border-[#D1D5DB] rounded-lg"
                />
              </div>
              <div>
                <label htmlFor="spawn-goal" className="block text-[11px] font-medium text-[#4B5563]">
                  Initial Goal
                </label>
                <input
                  id="spawn-goal"
                  value={newGoal}
                  onChange={(e) => setNewGoal(e.target.value)}
                  required
                  className="mt-1 w-full px-2.5 py-1.5 text-xs bg-white border border-[#D1D5DB] rounded-lg"
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowSpawn(false)}
                  className="px-3 py-1.5 text-xs text-[#4B5563] hover:text-[#111827]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-[#4D7C0F] hover:bg-[#3F6212] rounded-lg"
                >
                  Boot Child VM
                </button>
              </div>
            </form>
          )}

          <div className="divide-y divide-[#F3F4F6]">
            {state.agents.map((agent) => {
              const selected = agent.agent_id === selectedAgentId;
              const ad = state.agentDetails[agent.agent_id];
              return (
                <button
                  key={agent.agent_id}
                  type="button"
                  onClick={() => onSelectAgent(agent.agent_id)}
                  className={`w-full text-left px-5 py-4 transition-colors ${
                    selected ? "bg-[#F7FEE7]" : "hover:bg-[#FAFAFA]"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold text-[#111827] truncate">
                      {agent.role}
                    </span>
                    <span className="text-[11px] font-mono text-[#4B5563] shrink-0">
                      {agent.status}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-[#6B7280] font-mono">
                    <span>{agent.agent_id}</span>
                    <span aria-hidden="true">·</span>
                    <span>{agent.owned_paths.join(", ")}</span>
                  </div>
                  <p className="mt-2 text-xs text-[#4B5563] line-clamp-2">{agent.last_summary}</p>
                  <div className="mt-2 flex items-center gap-2 text-[11px] font-mono text-[#6B7280]">
                    <GitBranch className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{agent.git_branch}</span>
                    {ad && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums shrink-0">
                          {ad.compiledContext.totalEstimatedTokens} tok
                        </span>
                      </>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Right Column: Selected Child VM Workspace, IM Chat & 6-Layer Context Inspector */}
        {detail && (
          <section
            aria-label="Selected Child VM Console"
            className="lg:col-span-8 bg-white border border-[#E5E7EB] rounded-xl overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-[#E5E7EB] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-[#111827] truncate">
                  {detail.card.role}
                </h2>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[#6B7280] font-mono">
                  <span>{detail.card.agent_id}</span>
                  <span aria-hidden="true">·</span>
                  <span>HEAD {detail.gitTelemetry.headSha}</span>
                  <span aria-hidden="true">·</span>
                  <span>{detail.repoMapSummary.totalFiles} indexed files</span>
                  <span aria-hidden="true">·</span>
                  <span data-testid="worker-mutation-count">
                    Worker loop mutations: {detail.workerContextMutationCount}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSummarize(detail.card.agent_id, "Manual operator compaction")}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#111827] bg-[#F3F4F6] hover:bg-[#E5E7EB] rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                  Summarize Context
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    const out = await onRunDiagnostics(detail.card.agent_id);
                    setDiagBanner(
                      `Spilled ${out.spill.totalBytes}B (${out.spill.totalLines} lines) to .agent/logs/. Doom-loop tripped (${out.breakerVerdict.tripped}) -> Escalated to ${out.expert.model_used}: ${out.expert.guidance}`,
                    );
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#374151] border border-[#D1D5DB] hover:bg-[#F9FAFB] rounded-lg transition-colors whitespace-nowrap shrink-0"
                >
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                  Test Spill &amp; Doom-Loop
                </button>
              </div>
            </div>

            {diagBanner && (
              <div className="px-6 py-3 bg-[#FFFBEB] border-b border-[#FDE68A] text-xs text-[#92400E]">
                {diagBanner}
              </div>
            )}

            {/* 6-Layer Context Compiler Telemetry Strip */}
            <div className="px-6 py-4 bg-[#FAFAFA] border-b border-[#E5E7EB]">
              <div className="flex items-center justify-between gap-2 mb-2.5">
                <span className="text-xs font-semibold text-[#111827]">
                  Deterministic 6-Layer Context Compiler
                </span>
                <span className="text-xs font-mono tabular-nums text-[#4B5563]">
                  Total: {detail.compiledContext.totalEstimatedTokens} est. tokens (
                  {(detail.compiledContext.contextFillRatio * 100).toFixed(2)}% fill)
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                {detail.compiledContext.layers.map((layer) => {
                  const isOpen = inspectedLayer === layer.layer;
                  return (
                    <button
                      key={layer.layer}
                      type="button"
                      onClick={() => setInspectedLayer(isOpen ? null : layer.layer)}
                      className={`text-left border rounded-lg px-2.5 py-2 transition-colors ${
                        isOpen
                          ? "bg-[#F7FEE7] border-[#4D7C0F]"
                          : "bg-white border-[#E5E7EB] hover:border-[#D1D5DB]"
                      }`}
                    >
                      <div className="text-[11px] font-medium text-[#6B7280] whitespace-nowrap">
                        {LAYER_LABELS[layer.layer] ?? `L${layer.layer}`}
                      </div>
                      <div className="mt-0.5 text-xs font-mono font-semibold tabular-nums text-[#111827]">
                        {layer.estimatedTokens} tok
                      </div>
                    </button>
                  );
                })}
              </div>
              {inspectedLayer !== null && (() => {
                const activeLayer = detail.compiledContext.layers.find(
                  (l) => l.layer === inspectedLayer,
                );
                if (!activeLayer) return null;
                return (
                  <pre className="mt-3 p-3 bg-white border border-[#E5E7EB] rounded-lg text-[11px] font-mono text-[#1F2937] whitespace-pre-wrap max-h-40 overflow-y-auto">
                    {activeLayer.content}
                  </pre>
                );
              })()}
            </div>

            {/* IM Chat Conversation Window */}
            <div className="p-6 space-y-4">
              <div className="space-y-3 max-h-64 overflow-y-auto pr-1">
                {detail.workingTurns.map((turn, idx) => (
                  <div
                    key={`${turn.timestamp}-${idx}`}
                    className={`rounded-lg px-4 py-3 text-sm ${
                      turn.role === "user"
                        ? "bg-[#F7FEE7] border border-[#D9F99D] text-[#111827]"
                        : "bg-[#FAFAFA] border border-[#E5E7EB] text-[#1F2937]"
                    }`}
                  >
                    <div className="flex items-center justify-between text-[11px] font-mono text-[#6B7280] mb-1">
                      <span>
                        {turn.role}
                        {turn.toolName ? ` · ${turn.toolName}` : ""}
                      </span>
                      <span>{new Date(turn.timestamp).toLocaleTimeString()}</span>
                    </div>
                    <p className="whitespace-pre-wrap leading-relaxed text-xs sm:text-sm">
                      {turn.content}
                    </p>
                  </div>
                ))}
              </div>

              <form
                className="flex items-center gap-2 pt-2 border-t border-[#F3F4F6]"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!chatMessage.trim()) return;
                  const msg = chatMessage.trim();
                  setChatMessage("");
                  await onSendChat(detail.card.agent_id, msg);
                }}
              >
                <label htmlFor="agent-chat-input" className="sr-only">
                  Send follow-up message to {detail.card.agent_id}
                </label>
                <input
                  id="agent-chat-input"
                  type="text"
                  value={chatMessage}
                  onChange={(e) => setChatMessage(e.target.value)}
                  placeholder={`Send follow-up instruction to ${detail.card.agent_id} (pinned into Layer 3)...`}
                  className="flex-1 px-3.5 py-2 text-sm bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#4D7C0F]"
                />
                <button
                  type="submit"
                  disabled={busy || !chatMessage.trim()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-[#4D7C0F] hover:bg-[#3F6212] rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" aria-hidden="true" />
                  Send
                </button>
              </form>
            </div>
          </section>
        )}
      </div>

      {/* Bottom Split: Shoulder Tap Interrogation + Watercooler Stream */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Shoulder Tap Peer Interrogation */}
        <section
          aria-label="Shoulder Tap Peer Interrogation"
          className="lg:col-span-6 bg-white border border-[#E5E7EB] rounded-xl p-6 space-y-4"
        >
          <div>
            <h2 className="text-sm font-semibold text-[#111827] flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-[#4D7C0F]" aria-hidden="true" />
              Peer Shoulder Tap Protocol (ground_ask_agent)
            </h2>
            <p className="mt-1 text-xs text-[#6B7280]">
              Query another Child VM via its read-only Shadow Reader without interrupting its active
              Worker reasoning loop, or queue a step-boundary change negotiation.
            </p>
          </div>

          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!tapQuestion.trim()) return;
              await onAskAgent({
                fromAgentId: selectedAgentId,
                targetAgentId: tapTarget,
                question: tapQuestion.trim(),
                mode: tapMode,
              });
            }}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="tap-target" className="block text-xs font-medium text-[#374151]">
                  Target Child VM
                </label>
                <select
                  id="tap-target"
                  value={tapTarget}
                  onChange={(e) => setTapTarget(e.target.value)}
                  className="mt-1 w-full px-3 py-2 text-xs font-mono bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
                >
                  {state.agents.map((a) => (
                    <option key={a.agent_id} value={a.agent_id}>
                      {a.agent_id} ({a.role})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="tap-mode" className="block text-xs font-medium text-[#374151]">
                  Channel Mode
                </label>
                <select
                  id="tap-mode"
                  value={tapMode}
                  onChange={(e) =>
                    setTapMode(e.target.value as "readonly_query" | "negotiate_change")
                  }
                  className="mt-1 w-full px-3 py-2 text-xs font-mono bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
                >
                  <option value="readonly_query">readonly_query (Shadow Reader)</option>
                  <option value="negotiate_change">negotiate_change (Async Action Inbox)</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="tap-question" className="block text-xs font-medium text-[#374151]">
                Question or Change Request
              </label>
              <input
                id="tap-question"
                type="text"
                value={tapQuestion}
                onChange={(e) => setTapQuestion(e.target.value)}
                className="mt-1 w-full px-3 py-2 text-xs bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
              />
            </div>

            <button
              type="submit"
              disabled={busy || !tapQuestion.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#111827] hover:bg-[#1F2937] rounded-lg transition-colors whitespace-nowrap"
            >
              <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
              Run Shoulder Tap
            </button>
          </form>

          <div className="pt-3 border-t border-[#F3F4F6] space-y-3 max-h-60 overflow-y-auto">
            {state.conversations.length === 0 ? (
              <p className="text-xs text-[#6B7280]">
                No peer queries yet. Run a Shadow Reader query above to inspect a peer VM with file
                citations and zero Worker interruption.
              </p>
            ) : (
              state.conversations.map((conv) => (
                <div
                  key={conv.id}
                  className="p-3 rounded-lg bg-[#FAFAFA] border border-[#E5E7EB] space-y-1.5"
                >
                  <div className="flex flex-wrap items-center gap-x-2 text-[11px] font-mono text-[#6B7280]">
                    <span className="font-semibold text-[#111827]">
                      {conv.from_agent_id} -&gt; {conv.to_agent_id}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{conv.mode}</span>
                    <span aria-hidden="true">·</span>
                    <span className="text-[#3F6212]">
                      worker disrupted: {String(conv.disrupted_worker_context)}
                    </span>
                  </div>
                  <p className="text-xs font-medium text-[#111827]">Q: {conv.question}</p>
                  <p className="text-xs text-[#374151] whitespace-pre-wrap">{conv.answer}</p>
                  {conv.citations.length > 0 && (
                    <div className="text-[11px] font-mono text-[#4B5563]">
                      Citations: {conv.citations.join(" · ")}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        {/* Watercooler Live Stream */}
        <section
          aria-label="Watercooler Event Stream"
          className="lg:col-span-6 bg-white border border-[#E5E7EB] rounded-xl p-6 space-y-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[#111827] flex items-center gap-2">
                <Radio className="w-4 h-4 text-[#4D7C0F]" aria-hidden="true" />
                Watercooler Stream (ground_broadcast)
              </h2>
              <p className="mt-0.5 text-xs text-[#6B7280]">
                Real-time milestone pulses, peer checks, and cross-VM events
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 bg-[#F3F4F6] rounded-lg max-w-full overflow-x-auto">
              {["all", "milestone", "shoulder_tap", "artifact_published", "deployed"].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setFeedFilter(k)}
                  className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                    feedFilter === k
                      ? "bg-white text-[#111827] shadow-xs"
                      : "text-[#6B7280] hover:text-[#111827]"
                  }`}
                >
                  {k === "all" ? "All" : k.replace(/_/g, " ")}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-[#F3F4F6] max-h-80 overflow-y-auto">
            {filteredFeed.length === 0 ? (
              <p className="py-6 text-xs text-[#6B7280]">No events match this filter yet.</p>
            ) : (
              filteredFeed.map((ev) => (
                <div key={ev.id} className="py-2.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[11px] font-mono text-[#6B7280]">
                      <span className="font-semibold text-[#111827]">{ev.agent_id}</span>
                      <span aria-hidden="true">·</span>
                      <span>{ev.kind}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-[#374151]">{ev.summary}</p>
                  </div>
                  <span className="text-[11px] font-mono tabular-nums text-[#9CA3AF] shrink-0">
                    {new Date(ev.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

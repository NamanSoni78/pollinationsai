import type { ChatTurn, CompiledContextLayer, CompiledPrompt, TelemetrySnapshot } from "./types";

export const DEFAULT_CONTEXT_BUDGET_TOKENS = 128_000;
export const AUTO_COMPACT_RATIO = 0.7;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Standard ~4 chars per token approximation
  return Math.ceil(text.length / 4);
}

export interface ContextCompileInput {
  /** Layer 1: Static KV-cache-friendly system prompt & harness rules */
  staticSystemPrefix: string;
  /** Layer 2: Currently mounted dynamic skills (name -> full markdown body) */
  activeSkills: Array<{ name: string; instructions: string }>;
  /** Layer 3: Verbatim original user prompt + ALL past user messages (NEVER dropped) */
  originalUserPrompt: string;
  pastUserMessages: string[];
  /** Layer 4: Compacted chronological WORKLOG.md */
  worklogMarkdown: string;
  /** Layer 5: Live telemetry (git, contract, ground inbox, pollen budget %) */
  telemetry: TelemetrySnapshot;
  /** Layer 6: Rolling working window (recent turns & tool outputs) */
  workingTurns: ChatTurn[];
  /** Max context budget tokens for compaction ratio calculation */
  contextBudgetTokens?: number;
}

/**
 * Deterministic 6-Layer Context Compiler (Issue #20357 §3.B.1).
 *
 * Guarantees on every follow-up user message and autonomous loop tick:
 * 1. Layer 1 stays byte-identical for KV-cache prefix reuse.
 * 2. Layer 2 mounts/unmounts dynamic skills cleanly without touching Layer 1.
 * 3. Layer 3 pins the verbatim original user prompt AND every past user message — NEVER evicted.
 * 4. Layer 4 injects compacted WORKLOG.md (milestones, decisions, dead ends).
 * 5. Layer 5 injects live telemetry (git status, recent commits, CONTRACT.json, Ground inbox, Pollen %).
 * 6. Layer 6 carries active working turns and signals `shouldAutoCompact` at >= 70% context fill.
 */
export function compileSixLayerContext(input: ContextCompileInput): CompiledPrompt {
  const budget = input.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;

  // Layer 1 — STATIC PREFIX
  const layer1Content = input.staticSystemPrefix.trim();

  // Layer 2 — ACTIVE SKILLS
  const layer2Content =
    input.activeSkills.length === 0
      ? "No dynamic skills currently mounted. Call `list_skills` / `load_skill` when domain guidance is needed."
      : input.activeSkills
          .map((s) => `## Active Skill: ${s.name}\n\n${s.instructions.trim()}`)
          .join("\n\n---\n\n");

  // Layer 3 — USER INTENT ANCHOR (Verbatim original + ALL past user messages)
  const pastFormatted =
    input.pastUserMessages.length === 0
      ? "(No follow-up user messages yet)"
      : input.pastUserMessages.map((msg, i) => `[User Message #${i + 1}]\n${msg}`).join("\n\n");
  const layer3Content = [
    "### Original User Prompt (Pinned — Never Evict)",
    input.originalUserPrompt.trim(),
    "",
    "### All Past User Messages (Pinned — Never Evict)",
    pastFormatted,
  ].join("\n");

  // Layer 4 — COMPACTED WORKLOG
  const layer4Content =
    input.worklogMarkdown.trim() ||
    "# WORKLOG\n\nNo milestones compacted yet. Call `summarize_context` as major steps complete.";

  // Layer 5 — LIVE TELEMETRY
  const t = input.telemetry;
  const layer5Content = [
    `Git Branch: ${t.gitBranch}`,
    `Git Status: ${t.gitStatusSummary}`,
    `Recent Commits:\n${t.recentCommits.length ? t.recentCommits.slice(0, 5).map((c) => `  - ${c}`).join("\n") : "  (none)"}`,
    `Contract Progress: ${t.contractProgress}`,
    `Agent Ground Inbox (${t.groundInboxCount} pending):\n${t.groundInboxPreview.length ? t.groundInboxPreview.map((m) => `  - ${m}`).join("\n") : "  (empty)"}`,
    `Pollen Budget: ${t.pollenBudgetPercent.toFixed(1)}% burned [${t.pollenBudgetTier}] — ${t.pollenBudgetDirective}`,
  ].join("\n");

  // Layer 6 — WORKING WINDOW
  const layer6Content = input.workingTurns
    .map((turn) => `[${turn.timestamp}] ${turn.role.toUpperCase()}${turn.toolName ? `(${turn.toolName})` : ""}: ${turn.content}`)
    .join("\n\n");

  const layers: CompiledContextLayer[] = [
    { layer: 1, name: "STATIC_PREFIX", content: layer1Content, estimatedTokens: estimateTokens(layer1Content) },
    { layer: 2, name: "ACTIVE_SKILLS", content: layer2Content, estimatedTokens: estimateTokens(layer2Content) },
    { layer: 3, name: "USER_INTENT_ANCHOR", content: layer3Content, estimatedTokens: estimateTokens(layer3Content) },
    { layer: 4, name: "COMPACTED_WORKLOG", content: layer4Content, estimatedTokens: estimateTokens(layer4Content) },
    { layer: 5, name: "LIVE_TELEMETRY", content: layer5Content, estimatedTokens: estimateTokens(layer5Content) },
    { layer: 6, name: "WORKING_WINDOW", content: layer6Content, estimatedTokens: estimateTokens(layer6Content) },
  ];

  const totalEstimatedTokens = layers.reduce((acc, l) => acc + l.estimatedTokens, 0);
  const contextFillRatio = Number((totalEstimatedTokens / budget).toFixed(4));
  const shouldAutoCompact = contextFillRatio >= AUTO_COMPACT_RATIO;

  const systemCombined = [
    `=== LAYER 1: STATIC PREFIX ===\n${layer1Content}`,
    `=== LAYER 2: ACTIVE SKILLS ===\n${layer2Content}`,
    `=== LAYER 3: USER INTENT ANCHOR ===\n${layer3Content}`,
    `=== LAYER 4: COMPACTED WORKLOG ===\n${layer4Content}`,
    `=== LAYER 5: LIVE TELEMETRY ===\n${layer5Content}`,
  ].join("\n\n");

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemCombined },
    ...input.workingTurns.map((turn) => ({
      role: (turn.role === "tool" ? "assistant" : turn.role) as "user" | "assistant",
      content: turn.toolName ? `[tool:${turn.toolName}] ${turn.content}` : turn.content,
    })),
  ];

  return {
    layers,
    totalEstimatedTokens,
    contextFillRatio,
    shouldAutoCompact,
    messages,
  };
}

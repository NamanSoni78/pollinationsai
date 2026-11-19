import { randomUUID } from "node:crypto";
import type {
  BudgetCutoffEvent,
  BudgetSnapshot,
  BudgetStatus,
  BudgetTier,
  PollenLedgerEntry,
} from "./types";

export const CONSERVE_THRESHOLD = 0.75;
export const WRAP_UP_THRESHOLD = 0.90;
export const HARD_CUTOFF_THRESHOLD = 1.0;

/**
 * Rough Pollen cost estimates per 1M tokens when upstream response headers do not
 * include an explicit `x-pollinations-mcp-cost` receipt.
 */
const MODEL_COST_PER_1K_TOKENS: Record<string, number> = {
  "openai/gpt-5.4-nano": 0.00015,
  "openai/gpt-5-nano": 0.00015,
  "openai/gpt-5.4-mini": 0.0005,
  "deepseek/deepseek-v4-flash": 0.0003,
  "openai/gpt-5.5": 0.0025,
  "moonshotai/kimi-k2.6": 0.0015,
  "openai/text-embedding-3-small": 0.00005,
  "black-forest-labs/flux.1-schnell": 0.002,
};

export function estimatePollenCost(params: {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  explicitCostHeader?: string | null;
  endpoint?: string;
}): number {
  if (params.explicitCostHeader) {
    const parsed = Number.parseFloat(params.explicitCostHeader);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }

  if (params.endpoint?.includes("/mcp/computer") || params.endpoint?.includes("/mcp/")) {
    return 0.0002;
  }

  if (params.endpoint?.includes("/image/")) {
    return 0.002;
  }

  const totalTokens = (params.promptTokens ?? 0) + (params.completionTokens ?? 0);
  if (totalTokens <= 0) return 0.0001;

  const rate =
    (params.model ? MODEL_COST_PER_1K_TOKENS[params.model] : undefined) ?? 0.0005;
  return Number(((totalTokens / 1000) * rate).toFixed(6));
}

export class BudgetExhaustedError extends Error {
  readonly statusCode = 402;
  readonly event: BudgetCutoffEvent;

  constructor(event: BudgetCutoffEvent) {
    super(
      `Pollen budget exhausted (${event.spentPollen.toFixed(4)} / ${event.maxBudgetPollen.toFixed(4)} Pollen). Task transitioned to BUDGET_PAUSED. Top up budget to resume.`,
    );
    this.name = "BudgetExhaustedError";
    this.event = event;
  }
}

export type CutoffListener = (event: BudgetCutoffEvent) => void | Promise<void>;

export class PollenBudgetFirewall {
  private maxBudgetPollen: number;
  private spentPollen = 0;
  private paused = false;
  private cutoffCount = 0;
  private ledger: PollenLedgerEntry[] = [];
  private cutoffListeners: CutoffListener[] = [];

  constructor(maxBudgetPollen: number) {
    if (!Number.isFinite(maxBudgetPollen) || maxBudgetPollen <= 0) {
      throw new Error("maxBudgetPollen must be a positive finite number.");
    }
    this.maxBudgetPollen = maxBudgetPollen;
  }

  onCutoff(listener: CutoffListener): () => void {
    this.cutoffListeners.push(listener);
    return () => {
      this.cutoffListeners = this.cutoffListeners.filter((l) => l !== listener);
    };
  }

  getTier(ratio = this.spentPollen / this.maxBudgetPollen): BudgetTier {
    if (this.paused || ratio >= HARD_CUTOFF_THRESHOLD) return "EXHAUSTED";
    if (ratio >= WRAP_UP_THRESHOLD) return "WRAP_UP";
    if (ratio >= CONSERVE_THRESHOLD) return "CONSERVE";
    return "NOMINAL";
  }

  getDirective(tier = this.getTier()): string {
    switch (tier) {
      case "NOMINAL":
        return "Budget nominal. Full multi-LLM routing and subagent concurrency enabled.";
      case "CONSERVE":
        return "BUDGET CONSERVATION (75%+): Downshift non-critical worker calls to fast model aliases and avoid speculative subagents.";
      case "WRAP_UP":
        return "BUDGET WRAP-UP (90%+): Halt new feature creation immediately. Stabilize tests, publish current build, and submit to Warden audit.";
      case "EXHAUSTED":
        return "BUDGET EXHAUSTED (100%): Execution hard-stopped (HTTP 402). Clean checkpoint saved. Awaiting user Top-Up & Resume.";
    }
  }

  getStatus(): BudgetStatus {
    const ratio = this.maxBudgetPollen > 0 ? this.spentPollen / this.maxBudgetPollen : 1;
    const tier = this.getTier(ratio);
    return {
      maxBudgetPollen: Number(this.maxBudgetPollen.toFixed(6)),
      spentPollen: Number(this.spentPollen.toFixed(6)),
      remainingPollen: Number(Math.max(0, this.maxBudgetPollen - this.spentPollen).toFixed(6)),
      burnPercent: Number(Math.min(100, ratio * 100).toFixed(2)),
      tier,
      directive: this.getDirective(tier),
      paused: this.paused,
      cutoffCount: this.cutoffCount,
      entriesCount: this.ledger.length,
    };
  }

  getLedger(): PollenLedgerEntry[] {
    return [...this.ledger];
  }

  /**
   * Pre-flight gate called before forwarding any paid LLM / MCP / sandbox request.
   * Throws `BudgetExhaustedError` (HTTP 402) if the budget is exhausted or already paused.
   */
  async assertCanSpend(agentId: string, estimatedCostPollen = 0): Promise<BudgetStatus> {
    if (this.paused || this.spentPollen + estimatedCostPollen >= this.maxBudgetPollen) {
      const event = this.triggerCutoff(agentId);
      await this.notifyCutoff(event);
      throw new BudgetExhaustedError(event);
    }
    return this.getStatus();
  }

  /**
   * Records actual spend after a paid request finishes.
   * If cumulative spend crosses 100%, triggers hard cutoff and notifies listeners.
   */
  async recordSpend(params: {
    agentId: string;
    role: string;
    endpoint: string;
    model?: string;
    promptTokens?: number;
    completionTokens?: number;
    costPollen: number;
  }): Promise<{ entry: PollenLedgerEntry; status: BudgetStatus; triggeredCutoff: boolean }> {
    const cost = Math.max(0, Number(params.costPollen) || 0);
    this.spentPollen = Number((this.spentPollen + cost).toFixed(6));

    const entry: PollenLedgerEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      agentId: params.agentId,
      role: params.role,
      endpoint: params.endpoint,
      model: params.model,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      costPollen: Number(cost.toFixed(6)),
      cumulativePollen: this.spentPollen,
    };
    this.ledger.push(entry);

    let triggeredCutoff = false;
    if (!this.paused && this.spentPollen >= this.maxBudgetPollen) {
      triggeredCutoff = true;
      const event = this.triggerCutoff(params.agentId);
      await this.notifyCutoff(event);
    }

    return { entry, status: this.getStatus(), triggeredCutoff };
  }

  /**
   * Top-Up & Resume: Increases `maxBudgetPollen` and clears the paused cutoff state
   * without losing ledger history or agent checkpoints.
   */
  topUpAndResume(additionalPollen: number): BudgetStatus {
    if (!Number.isFinite(additionalPollen) || additionalPollen <= 0) {
      throw new Error("additionalPollen must be a positive number.");
    }
    this.maxBudgetPollen = Number((this.maxBudgetPollen + additionalPollen).toFixed(6));
    if (this.spentPollen < this.maxBudgetPollen) {
      this.paused = false;
    }
    return this.getStatus();
  }

  setMaxBudget(newMaxPollen: number): BudgetStatus {
    if (!Number.isFinite(newMaxPollen) || newMaxPollen <= 0) {
      throw new Error("newMaxPollen must be a positive number.");
    }
    this.maxBudgetPollen = Number(newMaxPollen.toFixed(6));
    this.paused = this.spentPollen >= this.maxBudgetPollen;
    return this.getStatus();
  }

  /**
   * Recommends whether a given role should downshift model tier or block speculative spawns.
   */
  getRoutingPolicy(): {
    tier: BudgetTier;
    downshiftNonCritical: boolean;
    allowNewFeatures: boolean;
    allowSpeculativeSubagents: boolean;
  } {
    const tier = this.getTier();
    return {
      tier,
      downshiftNonCritical: tier === "CONSERVE" || tier === "WRAP_UP",
      allowNewFeatures: tier === "NOMINAL" || tier === "CONSERVE",
      allowSpeculativeSubagents: tier === "NOMINAL",
    };
  }

  exportSnapshot(): BudgetSnapshot {
    return {
      maxBudgetPollen: this.maxBudgetPollen,
      spentPollen: this.spentPollen,
      paused: this.paused,
      cutoffCount: this.cutoffCount,
      ledger: [...this.ledger],
    };
  }

  static fromSnapshot(snapshot: BudgetSnapshot): PollenBudgetFirewall {
    const fw = new PollenBudgetFirewall(snapshot.maxBudgetPollen);
    fw.spentPollen = snapshot.spentPollen;
    fw.paused = snapshot.paused;
    fw.cutoffCount = snapshot.cutoffCount;
    fw.ledger = [...snapshot.ledger];
    return fw;
  }

  private triggerCutoff(agentId: string): BudgetCutoffEvent {
    if (!this.paused) {
      this.paused = true;
      this.cutoffCount += 1;
    }
    return {
      reason: "BUDGET_EXHAUSTED",
      spentPollen: this.spentPollen,
      maxBudgetPollen: this.maxBudgetPollen,
      burnPercent: Math.min(100, Number(((this.spentPollen / this.maxBudgetPollen) * 100).toFixed(2))),
      triggeredAt: new Date().toISOString(),
      agentId,
    };
  }

  private async notifyCutoff(event: BudgetCutoffEvent): Promise<void> {
    for (const listener of this.cutoffListeners) {
      await listener(event);
    }
  }
}

export interface PollinationsIdentity {
  userId: string;
  githubUsername: string;
  displayName: string;
  email: string;
  avatarUrl?: string;
  balancePollen: number;
  authenticatedAt: string;
  authMode: "pollinations_byop" | "demo";
}

export type BudgetTier = "NOMINAL" | "CONSERVE" | "WRAP_UP" | "EXHAUSTED";

export interface PollenLedgerEntry {
  id: string;
  timestamp: string;
  agentId: string;
  role: string;
  endpoint: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  costPollen: number;
  cumulativePollen: number;
}

export interface BudgetStatus {
  maxBudgetPollen: number;
  spentPollen: number;
  remainingPollen: number;
  burnPercent: number;
  tier: BudgetTier;
  directive: string;
  paused: boolean;
  cutoffCount: number;
  entriesCount: number;
}

export interface BudgetCutoffEvent {
  reason: "BUDGET_EXHAUSTED";
  spentPollen: number;
  maxBudgetPollen: number;
  burnPercent: number;
  triggeredAt: string;
  agentId: string;
}

export interface BudgetSnapshot {
  maxBudgetPollen: number;
  spentPollen: number;
  paused: boolean;
  cutoffCount: number;
  ledger: PollenLedgerEntry[];
}

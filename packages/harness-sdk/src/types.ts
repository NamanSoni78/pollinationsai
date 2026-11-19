export type ModelRole =
  | "indexer"
  | "worker"
  | "subagent"
  | "embedding"
  | "vision"
  | "expert"
  | "warden"
  | "image_gen";

export interface RoleModelConfig {
  indexer: string;
  worker: string;
  workerConserve: string;
  subagent: string;
  embedding: string;
  vision: string;
  expert: string;
  warden: string;
  image_gen: string;
}

export interface ChatTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  toolName?: string;
}

export interface TelemetrySnapshot {
  gitBranch: string;
  gitStatusSummary: string;
  recentCommits: string[];
  contractProgress: string;
  groundInboxCount: number;
  groundInboxPreview: string[];
  pollenBudgetPercent: number;
  pollenBudgetTier: string;
  pollenBudgetDirective: string;
}

export interface CompiledContextLayer {
  layer: 1 | 2 | 3 | 4 | 5 | 6;
  name: string;
  content: string;
  estimatedTokens: number;
}

export interface CompiledPrompt {
  layers: CompiledContextLayer[];
  totalEstimatedTokens: number;
  contextFillRatio: number;
  shouldAutoCompact: boolean;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export interface RagChunk {
  id: string;
  scope: "codebase" | "worklogs" | "docs";
  sourcePath: string;
  lineStart: number;
  lineEnd: number;
  content: string;
  score: number;
}

export interface SkillMetadata {
  name: string;
  description: string;
  required_tools: string[];
  token_estimate: number;
  filePath: string;
  loaded: boolean;
}

export interface RepoMapEntry {
  path: string;
  sizeBytes: number;
  exports: string[];
  routes: string[];
}

export interface RepoMap {
  indexedAt: string;
  rootDir: string;
  totalFiles: number;
  entries: RepoMapEntry[];
}

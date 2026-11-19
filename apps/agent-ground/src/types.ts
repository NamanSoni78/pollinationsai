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

export interface BudgetStatus {
  maxBudgetPollen: number;
  spentPollen: number;
  remainingPollen: number;
  burnPercent: number;
  tier: "NOMINAL" | "CONSERVE" | "WRAP_UP" | "EXHAUSTED";
  directive: string;
  paused: boolean;
  cutoffCount: number;
  entriesCount: number;
}

export interface PollenLedgerEntry {
  id: string;
  timestamp: string;
  agentId: string;
  role: string;
  endpoint: string;
  model?: string;
  costPollen: number;
  cumulativePollen: number;
}

export interface AgentCard {
  agent_id: string;
  owner_pollinations_id: string;
  role: string;
  current_goal: string;
  status: string;
  stack: string[];
  owned_paths: string[];
  git_branch: string;
  published_artifacts: string[];
  preview_url?: string;
  last_summary: string;
  updated_at: string;
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
}

export interface ChatTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  timestamp: string;
  toolName?: string;
}

export interface ContractRequirement {
  id: string;
  description: string;
  verification_type: string;
  must_pass: boolean;
}

export interface TaskContract {
  contract_id: string;
  locked_at: string;
  goal: string;
  deploy_target: "cloudflare_pages" | "cloudflare_workers" | "edgeone_pages" | "local_preview";
  interview_answers: Record<string, string>;
  requirements: ContractRequirement[];
}

export interface WardenVerdict {
  audit_id: string;
  audited_at: string;
  approved: boolean;
  zero_history_verified: true;
  summary: string;
  results: Array<{
    req_id: string;
    status: "PASS" | "FAIL";
    evidence?: string;
    defect?: string;
  }>;
  required_actions: string[];
  model_used: string;
}

export interface SkillItem {
  name: string;
  description: string;
  loaded: boolean;
  est_tokens: number;
  required_tools: string[];
}

export interface AgentDetailView {
  card: AgentCard;
  closedLoopState: string;
  contract: TaskContract | null;
  lastVerdict: WardenVerdict | null;
  pinnedActions: string[];
  expertEscalations: Array<{ req_id: string; timestamp: string; guidance: string }>;
  gitTelemetry: { branch: string; statusSummary: string; recentCommits: string[]; headSha: string };
  skills: SkillItem[];
  compiledContext: CompiledPrompt;
  workingTurns: ChatTurn[];
  inbox: Array<{
    id: string;
    from_agent_id: string;
    to_agent_id: string;
    question: string;
    created_at: string;
    status: string;
  }>;
  repoMapSummary: { totalFiles: number; indexedAt: string; routes: string[] };
  workerContextMutationCount: number;
  openCodeConfigPath: string;
  simulatedDefectActive: boolean;
}

export interface ArtifactRecord {
  key: string;
  version: string;
  artifact_uri: string;
  author_agent_id: string;
  content_type: string;
  payload: string;
  changelog: string;
  created_at: string;
  previous_version?: string;
  diff_summary?: string;
}

export interface WatercoolerEvent {
  id: string;
  timestamp: string;
  agent_id: string;
  kind: string;
  summary: string;
}

export interface PeerConversationEntry {
  id: string;
  timestamp: string;
  from_agent_id: string;
  to_agent_id: string;
  mode: "readonly_query" | "negotiate_change";
  question: string;
  answer: string;
  citations: string[];
  status: "answered" | "queued";
  disrupted_worker_context: boolean;
}

export interface PeerCheckResult {
  id: string;
  requester_agent_id: string;
  reviewer_agent_id: string;
  preview_url: string;
  passed: boolean;
  findings: string[];
  checked_at: string;
}

export interface PreflightQuestion {
  id: string;
  label: string;
  question: string;
  placeholder: string;
  required: boolean;
}

export interface DeploymentRecord {
  deployment_id: string;
  provider: "cloudflare_pages" | "cloudflare_workers" | "edgeone_pages";
  project_name: string;
  url: string;
  status: string;
  mode: string;
  created_at: string;
  logs: string[];
}

export interface LiveSmokeTestResult {
  url: string;
  http_status: number;
  passed: boolean;
  latency_ms: number;
  content_type: string;
  title?: string;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  verified_at: string;
}

export interface OverviewState {
  identity: PollinationsIdentity;
  livePollinationsConnected: boolean;
  budget: BudgetStatus;
  ledger: PollenLedgerEntry[];
  modelMatrix: Record<string, string>;
  agents: AgentCard[];
  agentDetails: Record<string, AgentDetailView>;
  artifacts: ArtifactRecord[];
  watercooler: WatercoolerEvent[];
  conversations: PeerConversationEntry[];
  peerChecks: PeerCheckResult[];
  preflightQuestions: PreflightQuestion[];
  publish: {
    credentials: {
      cloudflare_configured: boolean;
      edgeone_configured: boolean;
      credential_mode: string;
    };
    deployments: DeploymentRecord[];
    smokeTests: LiveSmokeTestResult[];
  };
}

import type { BudgetSnapshot } from "../../pollinations-byop-proxy/src/index";

export type ClosedLoopState =
  | "IM_CHAT"
  | "PREFLIGHT_INTERVIEW"
  | "AUTONOMOUS_EXECUTION"
  | "WARDEN_AUDIT"
  | "COMPLETED"
  | "BUDGET_PAUSED";

export type VerificationType =
  | "unit_test"
  | "e2e_browser"
  | "vision_and_console"
  | "live_url_check"
  | "code_audit";

export interface ContractRequirement {
  id: string;
  description: string;
  verification_type: VerificationType;
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

export interface PreflightQuestion {
  id: string;
  label: string;
  question: string;
  placeholder: string;
  required: boolean;
}

export interface EvidenceBundle {
  contract_id: string;
  git_sha: string;
  git_diff_stat: string;
  test_command: string;
  test_exit_code: number;
  test_output_excerpt: string;
  preview_url?: string;
  live_http_status?: number;
  console_errors?: string[];
  screenshot_notes?: string[];
  changed_files: string[];
}

export interface WardenRequirementResult {
  req_id: string;
  status: "PASS" | "FAIL";
  evidence?: string;
  defect?: string;
}

export interface WardenVerdict {
  audit_id: string;
  audited_at: string;
  approved: boolean;
  zero_history_verified: true;
  summary: string;
  results: WardenRequirementResult[];
  required_actions: string[];
  model_used: string;
}

export interface DurableSnapshot {
  version: 1;
  agent_id: string;
  state: ClosedLoopState;
  saved_at: string;
  contract: TaskContract | null;
  worklog_markdown: string;
  active_skills: string[];
  pollen_ledger: BudgetSnapshot | null;
  git_sha: string;
  ground_subscriptions: string[];
  rejection_counts: Record<string, number>;
  last_verdict: WardenVerdict | null;
  pinned_actions: string[];
  expert_escalations: Array<{
    req_id: string;
    timestamp: string;
    guidance: string;
  }>;
}

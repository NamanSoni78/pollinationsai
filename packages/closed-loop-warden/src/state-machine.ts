import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BudgetSnapshot } from "../../pollinations-byop-proxy/src/index";
import type { PollinationsModelRouter } from "../../harness-sdk/src/index";
import { consultExpert } from "../../harness-sdk/src/index";
import type {
  ClosedLoopState,
  ContractRequirement,
  DurableSnapshot,
  EvidenceBundle,
  PreflightQuestion,
  TaskContract,
  WardenVerdict,
} from "./types";
import {
  type ReadOnlyVmVerifier,
  createReadOnlyVmVerifier,
  runAdversarialWardenAudit,
} from "./warden";

export class ClosedLoopHumanInputDisabledError extends Error {
  constructor(agentId: string) {
    super(
      `Human-asking pathways are HARD-DISABLED during AUTONOMOUS_EXECUTION for "${agentId}". Resolve autonomously via search MCP, consult_expert, peer agents, or rollback.`,
    );
    this.name = "ClosedLoopHumanInputDisabledError";
  }
}

export class DirectCompletionForbiddenError extends Error {
  constructor() {
    super(
      `Worker cannot transition directly to COMPLETED. Submit an EvidenceBundle via request_warden_approval() and earn an APPROVED verdict from the zero-history Warden.`,
    );
    this.name = "DirectCompletionForbiddenError";
  }
}

export const DEFAULT_PREFLIGHT_QUESTIONS: PreflightQuestion[] = [
  {
    id: "design_direction",
    label: "Visual & UX Direction",
    question: "What visual aesthetic, responsive breakpoints, and UX invariants must hold?",
    placeholder: "e.g., Crisp industrial light console, 1440px desktop + 390px mobile zero-overflow",
    required: true,
  },
  {
    id: "core_features",
    label: "Must-Pass Core Features",
    question: "List the non-negotiable functional features and edge cases to verify.",
    placeholder: "e.g., Pollinations OAuth flow, real-time budget cutoff, multi-agent blackboard",
    required: true,
  },
  {
    id: "deploy_target",
    label: "Target Publish Platform",
    question: "Where should the finished build be published autonomously?",
    placeholder: "cloudflare_pages | cloudflare_workers | edgeone_pages | local_preview",
    required: true,
  },
  {
    id: "hard_constraints",
    label: "Hard Constraints & Guardrails",
    question: "Any strict security, dependency, or verification constraints?",
    placeholder: "e.g., Zero secrets in Git, zero console errors, 100% automated tests passing",
    required: false,
  },
];

/**
 * Durable Closed-Loop ("Sleep Mode") Controller (Issue #20357 §4).
 *
 * State Machine:
 *   IM_CHAT -> PREFLIGHT_INTERVIEW -> AUTONOMOUS_EXECUTION <-> WARDEN_AUDIT -> COMPLETED
 *                                                  |
 *                                                  +-> BUDGET_PAUSED (clean snapshot + resume)
 */
export class ClosedLoopDaemon {
  private state: ClosedLoopState = "IM_CHAT";
  private contract: TaskContract | null = null;
  private worklogMarkdown = "# WORKLOG\n";
  private activeSkills: string[] = [];
  private pollenLedger: BudgetSnapshot | null = null;
  private gitSha = "0000000";
  private groundSubscriptions: string[] = [];
  private rejectionCounts: Record<string, number> = {};
  private lastVerdict: WardenVerdict | null = null;
  private pinnedActions: string[] = [];
  private expertEscalations: Array<{ req_id: string; timestamp: string; guidance: string }> = [];

  constructor(
    readonly agentId: string,
    readonly workspaceDir: string,
  ) {}

  getState(): ClosedLoopState {
    return this.state;
  }

  getContract(): TaskContract | null {
    return this.contract ? { ...this.contract } : null;
  }

  getLastVerdict(): WardenVerdict | null {
    return this.lastVerdict;
  }

  getPinnedActions(): string[] {
    return [...this.pinnedActions];
  }

  getExpertEscalations() {
    return [...this.expertEscalations];
  }

  getRejectionCounts(): Record<string, number> {
    return { ...this.rejectionCounts };
  }

  /**
   * Phase 2 Entry: User clicks "Close the Loop" -> enters single-batch PREFLIGHT_INTERVIEW.
   */
  beginPreflightInterview(): { state: ClosedLoopState; questions: PreflightQuestion[] } {
    if (this.state !== "IM_CHAT" && this.state !== "PREFLIGHT_INTERVIEW") {
      throw new Error(`Cannot start pre-flight interview from state "${this.state}".`);
    }
    this.state = "PREFLIGHT_INTERVIEW";
    this.saveDurableSnapshot();
    return {
      state: this.state,
      questions: DEFAULT_PREFLIGHT_QUESTIONS,
    };
  }

  /**
   * Freezes CONTRACT.json from the user's single-batch answers and enters AUTONOMOUS_EXECUTION
   * where all human-asking pathways are hard-disabled.
   */
  freezeContractAndStartAutonomous(params: {
    goal: string;
    answers: Record<string, string>;
    deploy_target?: TaskContract["deploy_target"];
    customRequirements?: ContractRequirement[];
  }): TaskContract {
    if (this.state !== "PREFLIGHT_INTERVIEW" && this.state !== "IM_CHAT") {
      throw new Error(`Cannot freeze contract from state "${this.state}".`);
    }

    const deployTarget =
      params.deploy_target ??
      ((params.answers.deploy_target as TaskContract["deploy_target"]) || "cloudflare_pages");

    const requirements: ContractRequirement[] = params.customRequirements ?? [
      {
        id: "REQ-1",
        description: params.answers.core_features?.trim()
          ? `Core implementation & automated tests pass: ${params.answers.core_features.trim()}`
          : `Core features for "${params.goal}" pass automated tests with zero stubs`,
        verification_type: "unit_test",
        must_pass: true,
      },
      {
        id: "REQ-2",
        description: params.answers.design_direction?.trim()
          ? `UI & responsive check passes with zero console errors: ${params.answers.design_direction.trim()}`
          : "Responsive UI renders cleanly at 1440px and 390px with zero console errors",
        verification_type: "vision_and_console",
        must_pass: true,
      },
      {
        id: "REQ-3",
        description: `Live ${deployTarget} deployment returns HTTP 200 and passes smoke test`,
        verification_type: "live_url_check",
        must_pass: true,
      },
    ];

    const contract: TaskContract = {
      contract_id: `task-${randomUUID().slice(0, 8)}`,
      locked_at: new Date().toISOString(),
      goal: params.goal,
      deploy_target: deployTarget,
      interview_answers: { ...params.answers },
      requirements,
    };

    this.contract = contract;
    this.state = "AUTONOMOUS_EXECUTION";
    this.rejectionCounts = {};
    this.pinnedActions = [];

    mkdirSync(this.workspaceDir, { recursive: true });
    writeFileSync(
      join(this.workspaceDir, "CONTRACT.json"),
      JSON.stringify(contract, null, 2),
      "utf8",
    );
    this.saveDurableSnapshot();
    return contract;
  }

  /**
   * Runtime guard enforcing zero-human autonomy during AUTONOMOUS_EXECUTION and WARDEN_AUDIT.
   */
  assertCanAskHuman(): void {
    if (this.state === "AUTONOMOUS_EXECUTION" || this.state === "WARDEN_AUDIT") {
      throw new ClosedLoopHumanInputDisabledError(this.agentId);
    }
  }

  /**
   * Explicitly forbids the Worker from marking a task COMPLETED directly.
   */
  markCompletedDirectly(): never {
    throw new DirectCompletionForbiddenError();
  }

  /**
   * Updates durable checkpoint metadata (called after milestones, commits, or budget ticks).
   */
  updateCheckpointMetadata(patch: {
    worklogMarkdown?: string;
    activeSkills?: string[];
    pollenLedger?: BudgetSnapshot | null;
    gitSha?: string;
    groundSubscriptions?: string[];
  }): DurableSnapshot {
    if (patch.worklogMarkdown !== undefined) this.worklogMarkdown = patch.worklogMarkdown;
    if (patch.activeSkills !== undefined) this.activeSkills = [...patch.activeSkills];
    if (patch.pollenLedger !== undefined) this.pollenLedger = patch.pollenLedger;
    if (patch.gitSha !== undefined) this.gitSha = patch.gitSha;
    if (patch.groundSubscriptions !== undefined) {
      this.groundSubscriptions = [...patch.groundSubscriptions];
    }
    return this.saveDurableSnapshot();
  }

  /**
   * Budget Firewall 100% hard cutoff handler -> clean state transition to BUDGET_PAUSED.
   */
  pauseForBudget(snapshotMeta?: { gitSha?: string; pollenLedger?: BudgetSnapshot }): DurableSnapshot {
    if (snapshotMeta?.gitSha) this.gitSha = snapshotMeta.gitSha;
    if (snapshotMeta?.pollenLedger) this.pollenLedger = snapshotMeta.pollenLedger;
    this.state = "BUDGET_PAUSED";
    return this.saveDurableSnapshot();
  }

  /**
   * Resumes from BUDGET_PAUSED after user performs Top-Up & Resume.
   */
  resumeFromBudgetPause(updatedLedger?: BudgetSnapshot): ClosedLoopState {
    if (this.state !== "BUDGET_PAUSED") return this.state;
    if (updatedLedger) this.pollenLedger = updatedLedger;
    this.state = this.contract ? "AUTONOMOUS_EXECUTION" : "IM_CHAT";
    this.saveDurableSnapshot();
    return this.state;
  }

  /**
   * Phase 4: Submit EvidenceBundle to the Zero-History Adversarial Warden.
   * - On APPROVED -> transitions cleanly to COMPLETED.
   * - On REJECTED -> returns to AUTONOMOUS_EXECUTION with `required_actions` pinned.
   * - If the SAME `req_id` is rejected twice consecutively -> auto-invokes `consult_expert`!
   */
  async request_warden_approval(params: {
    evidence: EvidenceBundle;
    verifier?: ReadOnlyVmVerifier;
    router?: PollinationsModelRouter;
  }): Promise<{
    verdict: WardenVerdict;
    state: ClosedLoopState;
    escalatedToExpert: Array<{ req_id: string; guidance: string }>;
  }> {
    if (!this.contract) {
      throw new Error("Cannot invoke Warden before CONTRACT.json is frozen.");
    }
    if (this.state === "BUDGET_PAUSED") {
      throw new Error("Task is BUDGET_PAUSED. Top-Up & Resume before running Warden audit.");
    }

    this.state = "WARDEN_AUDIT";
    const verifier = params.verifier ?? createReadOnlyVmVerifier(this.workspaceDir);
    const verdict = await runAdversarialWardenAudit({
      contract: this.contract,
      evidence: params.evidence,
      verifier,
      router: params.router,
    });

    this.lastVerdict = verdict;
    const escalatedToExpert: Array<{ req_id: string; guidance: string }> = [];

    if (verdict.approved) {
      this.state = "COMPLETED";
      this.pinnedActions = [];
      this.rejectionCounts = {};
    } else {
      this.state = "AUTONOMOUS_EXECUTION";
      this.pinnedActions = [...verdict.required_actions];

      // Track consecutive rejections per req_id -> auto-escalate on 2nd consecutive fail
      for (const r of verdict.results) {
        if (r.status === "PASS") {
          this.rejectionCounts[r.req_id] = 0;
        } else {
          this.rejectionCounts[r.req_id] = (this.rejectionCounts[r.req_id] ?? 0) + 1;
          if (this.rejectionCounts[r.req_id] >= 2) {
            const expert = await consultExpert({
              question: `Warden rejected ${r.req_id} twice consecutively. Defect: ${r.defect ?? "unspecified"}`,
              file_paths: params.evidence.changed_files,
              failed_attempts: verdict.required_actions,
              workspaceDir: this.workspaceDir,
              router: params.router,
            });
            const entry = {
              req_id: r.req_id,
              timestamp: new Date().toISOString(),
              guidance: expert.guidance,
            };
            this.expertEscalations.push(entry);
            this.pinnedActions.unshift(`[EXPERT ESCALATION ${r.req_id}] ${expert.guidance}`);
            escalatedToExpert.push({ req_id: r.req_id, guidance: expert.guidance });
          }
        }
      }
    }

    this.saveDurableSnapshot();
    return { verdict, state: this.state, escalatedToExpert };
  }

  /**
   * Atomically persists full multi-day durable state to `.agent/durable-state.json`.
   */
  saveDurableSnapshot(): DurableSnapshot {
    const agentDir = join(this.workspaceDir, ".agent");
    mkdirSync(agentDir, { recursive: true });

    const snapshot: DurableSnapshot = {
      version: 1,
      agent_id: this.agentId,
      state: this.state,
      saved_at: new Date().toISOString(),
      contract: this.contract,
      worklog_markdown: this.worklogMarkdown,
      active_skills: [...this.activeSkills],
      pollen_ledger: this.pollenLedger,
      git_sha: this.gitSha,
      ground_subscriptions: [...this.groundSubscriptions],
      rejection_counts: { ...this.rejectionCounts },
      last_verdict: this.lastVerdict,
      pinned_actions: [...this.pinnedActions],
      expert_escalations: [...this.expertEscalations],
    };

    const finalPath = join(agentDir, "durable-state.json");
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
    renameSync(tmpPath, finalPath);
    return snapshot;
  }

  exportSnapshot(): DurableSnapshot {
    return {
      version: 1,
      agent_id: this.agentId,
      state: this.state,
      saved_at: new Date().toISOString(),
      contract: this.contract,
      worklog_markdown: this.worklogMarkdown,
      active_skills: [...this.activeSkills],
      pollen_ledger: this.pollenLedger,
      git_sha: this.gitSha,
      ground_subscriptions: [...this.groundSubscriptions],
      rejection_counts: { ...this.rejectionCounts },
      last_verdict: this.lastVerdict,
      pinned_actions: [...this.pinnedActions],
      expert_escalations: [...this.expertEscalations],
    };
  }

  /**
   * Multi-Day Crash/Restart Durability: Restores exact daemon state from disk after
   * a sandbox crash, kill, or idle timeout so autonomous execution resumes seamlessly.
   */
  static restoreFromDisk(workspaceDir: string): ClosedLoopDaemon {
    const statePath = join(workspaceDir, ".agent", "durable-state.json");
    if (!existsSync(statePath)) {
      throw new Error(`No durable state snapshot found at ${statePath}`);
    }
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as DurableSnapshot;
    const daemon = new ClosedLoopDaemon(raw.agent_id, workspaceDir);
    daemon.state = raw.state;
    daemon.contract = raw.contract;
    daemon.worklogMarkdown = raw.worklog_markdown;
    daemon.activeSkills = [...raw.active_skills];
    daemon.pollenLedger = raw.pollen_ledger;
    daemon.gitSha = raw.git_sha;
    daemon.groundSubscriptions = [...raw.ground_subscriptions];
    daemon.rejectionCounts = { ...raw.rejection_counts };
    daemon.lastVerdict = raw.last_verdict;
    daemon.pinnedActions = [...raw.pinned_actions];
    daemon.expertEscalations = [...raw.expert_escalations];
    return daemon;
  }
}

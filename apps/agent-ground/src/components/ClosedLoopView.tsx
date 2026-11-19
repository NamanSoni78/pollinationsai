import { useState } from "react";
import {
  Lock,
  ShieldCheck,
  ShieldX,
  RefreshCw,
  Wrench,
  Ban,
} from "lucide-react";
import type { AgentDetailView, OverviewState } from "../types";

interface ClosedLoopViewProps {
  state: OverviewState;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  busy: boolean;
  onCloseLoop: (agentId: string) => Promise<void>;
  onFreezeContract: (
    agentId: string,
    answers: Record<string, string>,
    deployTarget: string,
  ) => Promise<void>;
  onTestHumanGuard: (agentId: string) => Promise<{ blocked: boolean; message: string }>;
  onRunWardenAudit: (agentId: string, autoSelfFix: boolean) => Promise<void>;
  onCrashRecover: (agentId: string) => Promise<void>;
}

const FSM_STEPS = [
  "IM_CHAT",
  "PREFLIGHT_INTERVIEW",
  "AUTONOMOUS_EXECUTION",
  "WARDEN_AUDIT",
  "COMPLETED",
] as const;

export function ClosedLoopView({
  state,
  selectedAgentId,
  onSelectAgent,
  busy,
  onCloseLoop,
  onFreezeContract,
  onTestHumanGuard,
  onRunWardenAudit,
  onCrashRecover,
}: ClosedLoopViewProps) {
  const detail: AgentDetailView | undefined = state.agentDetails[selectedAgentId];

  const [answers, setAnswers] = useState<Record<string, string>>({
    design_direction: "Crisp industrial light console, 1440px desktop + 390px mobile zero overflow",
    core_features: "Pollinations BYOP OAuth, live budget firewall, AnalyticsPanel null safety",
    deploy_target: "cloudflare_pages",
    hard_constraints: "Zero TODO stubs, zero console errors, zero secrets in Git",
  });
  const [guardCheckResult, setGuardCheckResult] = useState<{
    blocked: boolean;
    message: string;
  } | null>(null);

  if (!detail) return null;

  const currentStep = detail.closedLoopState;

  return (
    <div className="space-y-6">
      {/* Agent selector + FSM Stepper */}
      <section
        aria-label="Closed-Loop State Machine"
        className="bg-white border border-[#E5E7EB] rounded-xl p-6 space-y-5"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[#111827]">
              Closed-Loop (&ldquo;Sleep Mode&rdquo;) &amp; Adversarial Warden Gate
            </h2>
            <p className="mt-0.5 text-xs text-[#6B7280]">
              Freeze requirements into <code className="font-mono">CONTRACT.json</code>, hard-disable
              human-asking pathways, and require zero-history Warden sign-off before completion.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <label htmlFor="cl-agent-select" className="text-xs font-medium text-[#4B5563]">
              Target VM:
            </label>
            <select
              id="cl-agent-select"
              value={selectedAgentId}
              onChange={(e) => onSelectAgent(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
            >
              {state.agents.map((a) => (
                <option key={a.agent_id} value={a.agent_id}>
                  {a.agent_id} ({state.agentDetails[a.agent_id]?.closedLoopState})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* FSM Progress Row */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {FSM_STEPS.map((step, index) => {
            const isCurrent = currentStep === step;
            const currentIdx = FSM_STEPS.indexOf(currentStep as (typeof FSM_STEPS)[number]);
            const isPast = currentIdx > index;
            return (
              <div
                key={step}
                className={`px-3 py-2.5 rounded-lg border text-xs font-mono transition-colors ${
                  isCurrent
                    ? "bg-[#F7FEE7] border-[#4D7C0F] text-[#111827] font-semibold"
                    : isPast
                      ? "bg-[#FAFAFA] border-[#D1D5DB] text-[#3F6212]"
                      : "bg-[#FAFAFA] border-[#E5E7EB] text-[#6B7280]"
                }`}
              >
                <div className="text-[10px] text-[#9CA3AF]">0{index + 1}</div>
                <div className="mt-0.5 truncate">{step}</div>
              </div>
            );
          })}
        </div>

        {/* Phase-specific primary action bar */}
        <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-[#F3F4F6]">
          {currentStep === "IM_CHAT" && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onCloseLoop(selectedAgentId)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#4D7C0F] hover:bg-[#3F6212] rounded-lg transition-colors whitespace-nowrap"
            >
              <Lock className="w-3.5 h-3.5" aria-hidden="true" />
              Close the Loop (Start Pre-Flight Interview)
            </button>
          )}

          {(currentStep === "AUTONOMOUS_EXECUTION" || currentStep === "COMPLETED") && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRunWardenAudit(selectedAgentId, false)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#111827] hover:bg-[#1F2937] rounded-lg transition-colors whitespace-nowrap"
              >
                <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                Run Zero-History Warden Audit
              </button>

              {detail.lastVerdict && !detail.lastVerdict.approved && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setGuardCheckResult(null);
                    await onRunWardenAudit(selectedAgentId, true);
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-[#4D7C0F] hover:bg-[#3F6212] rounded-lg transition-colors whitespace-nowrap"
                >
                  <Wrench className="w-3.5 h-3.5" aria-hidden="true" />
                  Worker Self-Fix &amp; Re-Audit
                </button>
              )}

              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const res = await onTestHumanGuard(selectedAgentId);
                  setGuardCheckResult(res);
                }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#374151] border border-[#D1D5DB] hover:bg-[#F9FAFB] rounded-lg transition-colors whitespace-nowrap"
              >
                <Ban className="w-3.5 h-3.5" aria-hidden="true" />
                Verify Zero-Human Guard
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => onCrashRecover(selectedAgentId)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-[#374151] border border-[#D1D5DB] hover:bg-[#F9FAFB] rounded-lg transition-colors whitespace-nowrap"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                Simulate Crash &amp; Restore
              </button>
            </>
          )}
        </div>

        {guardCheckResult && (
          <div
            role="status"
            className={`px-4 py-3 rounded-lg border text-xs ${
              guardCheckResult.blocked
                ? "bg-[#F7FEE7] border-[#BEF264] text-[#3F6212]"
                : "bg-[#FAFAFA] border-[#E5E7EB] text-[#374151]"
            }`}
          >
            {guardCheckResult.message}
          </div>
        )}
      </section>

      {/* Pre-Flight Interview Form (Phase 2) */}
      {currentStep === "PREFLIGHT_INTERVIEW" && (
        <section
          aria-label="Pre-Flight Interview"
          className="bg-white border border-[#E5E7EB] rounded-xl p-6 space-y-4"
        >
          <div>
            <h3 className="text-sm font-semibold text-[#111827]">
              Pre-Flight Clarifying Interview (Single Batch)
            </h3>
            <p className="mt-0.5 text-xs text-[#6B7280]">
              Answer once before going to sleep. Submitting freezes <code className="font-mono">CONTRACT.json</code>{" "}
              and disables all further human prompts.
            </p>
          </div>

          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              await onFreezeContract(
                selectedAgentId,
                answers,
                answers.deploy_target || "cloudflare_pages",
              );
            }}
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {state.preflightQuestions.map((q) => (
                <div key={q.id}>
                  <label htmlFor={`pf-${q.id}`} className="block text-xs font-semibold text-[#111827]">
                    {q.label}
                  </label>
                  <p className="text-[11px] text-[#6B7280] mt-0.5">{q.question}</p>
                  {q.id === "deploy_target" ? (
                    <select
                      id={`pf-${q.id}`}
                      value={answers[q.id] ?? "cloudflare_pages"}
                      onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                      className="mt-1.5 w-full px-3 py-2 text-xs font-mono bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
                    >
                      <option value="cloudflare_pages">cloudflare_pages</option>
                      <option value="cloudflare_workers">cloudflare_workers</option>
                      <option value="edgeone_pages">edgeone_pages</option>
                      <option value="local_preview">local_preview</option>
                    </select>
                  ) : (
                    <input
                      id={`pf-${q.id}`}
                      value={answers[q.id] ?? ""}
                      onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                      required={q.required}
                      placeholder={q.placeholder}
                      className="mt-1.5 w-full px-3 py-2 text-xs bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
                    />
                  )}
                </div>
              ))}
            </div>
            <button
              type="submit"
              disabled={busy}
              className="px-5 py-2.5 text-xs font-semibold text-white bg-[#4D7C0F] hover:bg-[#3F6212] rounded-lg transition-colors"
            >
              Freeze CONTRACT.json &amp; Enter Autonomous Execution
            </button>
          </form>
        </section>
      )}

      {/* Frozen Contract + Zero-History Warden Verdict */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <section
          aria-label="Frozen Task Contract"
          className="lg:col-span-6 bg-white border border-[#E5E7EB] rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#111827]">Frozen CONTRACT.json</h3>
            {detail.contract && (
              <span className="text-xs font-mono text-[#6B7280]">
                {detail.contract.contract_id} · {detail.contract.deploy_target}
              </span>
            )}
          </div>

          {!detail.contract ? (
            <p className="text-xs text-[#6B7280]">
              No contract frozen yet. Click &ldquo;Close the Loop&rdquo; above to run the Pre-Flight
              Interview and lock machine-verifiable requirements.
            </p>
          ) : (
            <div className="divide-y divide-[#F3F4F6]">
              {detail.contract.requirements.map((req) => (
                <div key={req.id} className="py-3">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <span className="font-semibold text-[#111827]">{req.id}</span>
                    <span className="text-[#6B7280]">
                      {req.verification_type} · {req.must_pass ? "must_pass" : "optional"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#374151]">{req.description}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        <section
          aria-label="Adversarial Warden Verdict"
          className="lg:col-span-6 bg-white border border-[#E5E7EB] rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#111827]">
              Zero-History Adversarial Warden Verdict
            </h3>
            {detail.lastVerdict && (
              <span
                className={`inline-flex items-center gap-1 text-xs font-mono font-semibold ${
                  detail.lastVerdict.approved ? "text-[#3F6212]" : "text-[#B91C1C]"
                }`}
              >
                {detail.lastVerdict.approved ? (
                  <ShieldCheck className="w-4 h-4" aria-hidden="true" />
                ) : (
                  <ShieldX className="w-4 h-4" aria-hidden="true" />
                )}
                {detail.lastVerdict.approved ? "APPROVED" : "REJECTED"}
              </span>
            )}
          </div>

          {!detail.lastVerdict ? (
            <p className="text-xs text-[#6B7280]">
              Awaiting first Warden audit. Once CONTRACT.json is locked, click &ldquo;Run
              Zero-History Warden Audit&rdquo; to inspect independent stub scans, test exits, and
              live HTTP 200 verification.
            </p>
          ) : (
            <div className="space-y-4">
              <div className="text-xs text-[#374151] bg-[#FAFAFA] border border-[#E5E7EB] rounded-lg p-3">
                <div className="font-medium text-[#111827]">{detail.lastVerdict.summary}</div>
                <div className="mt-1 font-mono text-[11px] text-[#6B7280]">
                  Audit ID: {detail.lastVerdict.audit_id} · Zero-history:{" "}
                  {String(detail.lastVerdict.zero_history_verified)} · Model:{" "}
                  {detail.lastVerdict.model_used}
                </div>
              </div>

              <div className="divide-y divide-[#F3F4F6]">
                {detail.lastVerdict.results.map((r) => (
                  <div key={r.req_id} className="py-2.5 text-xs">
                    <div className="flex items-center justify-between font-mono">
                      <span className="font-semibold text-[#111827]">{r.req_id}</span>
                      <span
                        className={
                          r.status === "PASS"
                            ? "text-[#3F6212] font-semibold"
                            : "text-[#B91C1C] font-semibold"
                        }
                      >
                        {r.status}
                      </span>
                    </div>
                    <p className="mt-1 text-[#4B5563]">{r.evidence ?? r.defect}</p>
                  </div>
                ))}
              </div>

              {detail.pinnedActions.length > 0 && (
                <div className="p-3 rounded-lg bg-[#FEF2F2] border border-[#FECACA] space-y-1">
                  <div className="text-xs font-semibold text-[#991B1B]">
                    Pinned Required Actions (Returned to Worker)
                  </div>
                  <ul className="list-disc pl-4 space-y-1 text-xs text-[#7F1D1D]">
                    {detail.pinnedActions.map((act, i) => (
                      <li key={i}>{act}</li>
                    ))}
                  </ul>
                </div>
              )}

              {detail.expertEscalations.length > 0 && (
                <div className="p-3 rounded-lg bg-[#FFFBEB] border border-[#FDE68A] space-y-1">
                  <div className="text-xs font-semibold text-[#92400E]">
                    Automatic consult_expert Escalations (2x Same-Requirement Rejection)
                  </div>
                  {detail.expertEscalations.map((esc, i) => (
                    <p key={i} className="text-xs text-[#78350F]">
                      <span className="font-mono font-semibold">{esc.req_id}:</span> {esc.guidance}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

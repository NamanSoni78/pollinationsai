import { useState } from "react";
import { ShieldAlert, RotateCcw, Flame } from "lucide-react";
import type { BudgetStatus, PollinationsIdentity } from "../types";

interface BudgetBarProps {
  identity: PollinationsIdentity;
  budget: BudgetStatus;
  selectedAgentId: string;
  busy: boolean;
  onSetCap: (cap: number) => void;
  onTopUp: (amount: number) => void;
  onSimulateBurn: (amount: number, agentId: string) => void;
}

const TIER_STYLES: Record<
  BudgetStatus["tier"],
  { label: string; textClass: string; barClass: string }
> = {
  NOMINAL: {
    label: "Nominal",
    textClass: "text-[#3F6212]",
    barClass: "bg-[#4D7C0F]",
  },
  CONSERVE: {
    label: "Conserve (75%+)",
    textClass: "text-[#B45309]",
    barClass: "bg-[#D97706]",
  },
  WRAP_UP: {
    label: "Wrap-Up (90%+)",
    textClass: "text-[#C2410C]",
    barClass: "bg-[#EA580C]",
  },
  EXHAUSTED: {
    label: "Budget Paused (100%)",
    textClass: "text-[#B91C1C]",
    barClass: "bg-[#DC2626]",
  },
};

export function BudgetBar({
  identity,
  budget,
  selectedAgentId,
  busy,
  onSetCap,
  onTopUp,
  onSimulateBurn,
}: BudgetBarProps) {
  const [capInput, setCapInput] = useState(String(budget.maxBudgetPollen));
  const tierMeta = TIER_STYLES[budget.tier];

  return (
    <section
      aria-label="Pollen Budget Firewall"
      className="bg-white border border-[#E5E7EB] rounded-xl p-5"
    >
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-[#6B7280]">
            <span className="font-medium text-[#111827]">Pollen Budget Firewall</span>
            <span aria-hidden="true">·</span>
            <span className={`font-semibold ${tierMeta.textClass}`}>{tierMeta.label}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">
              Identity: <span className="font-mono text-[#374151]">{identity.email}</span>
            </span>
          </div>
          <p className="mt-1 text-sm text-[#4B5563]">{budget.directive}</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <div className="text-right font-mono tabular-nums">
            <div className="text-base font-semibold text-[#111827]">
              {budget.spentPollen.toFixed(4)} / {budget.maxBudgetPollen.toFixed(2)} Pollen
            </div>
            <div className="text-xs text-[#6B7280]">
              {budget.burnPercent.toFixed(1)}% burned · {budget.remainingPollen.toFixed(4)} left
            </div>
          </div>

          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const parsed = Number(capInput);
              if (Number.isFinite(parsed) && parsed > 0) onSetCap(parsed);
            }}
          >
            <label htmlFor="budget-cap-input" className="sr-only">
              Max Pollen budget cap
            </label>
            <input
              id="budget-cap-input"
              type="number"
              step="0.25"
              min="0.1"
              value={capInput}
              onChange={(e) => setCapInput(e.target.value)}
              className="w-20 px-2.5 py-1.5 text-xs font-mono tabular-nums bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#4D7C0F]"
            />
            <button
              type="submit"
              disabled={busy}
              className="px-3 py-1.5 text-xs font-medium text-[#111827] bg-[#F3F4F6] hover:bg-[#E5E7EB] rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              Set Cap
            </button>
          </form>

          {budget.paused ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onTopUp(0.5)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-[#4D7C0F] hover:bg-[#3F6212] rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              Top-Up +0.50 &amp; Resume
            </button>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onSimulateBurn(0.4, selectedAgentId)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-[#374151] border border-[#D1D5DB] hover:bg-[#F9FAFB] rounded-lg transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Flame className="w-3.5 h-3.5" aria-hidden="true" />
              Test +0.40 Burn
            </button>
          )}
        </div>
      </div>

      {/* Linear threshold meter (75% Conserve / 90% Wrap-Up / 100% Hard Cutoff) */}
      <div className="mt-4">
        <div className="relative h-2 w-full bg-[#F3F4F6] rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-300 ${tierMeta.barClass}`}
            style={{ width: `${Math.min(100, budget.burnPercent)}%` }}
          />
          <div
            title="75% Conservation Threshold"
            className="absolute top-0 bottom-0 left-[75%] w-px bg-[#9CA3AF]"
          />
          <div
            title="90% Wrap-Up Threshold"
            className="absolute top-0 bottom-0 left-[90%] w-px bg-[#6B7280]"
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono tabular-nums text-[#6B7280]">
          <span>0%</span>
          <span>75% Conserve · 90% Wrap-Up · 100% HTTP 402 Cutoff</span>
          <span>100%</span>
        </div>
      </div>

      {budget.paused && (
        <div
          role="alert"
          className="mt-3 flex items-center gap-2 text-xs text-[#991B1B] bg-[#FEF2F2] border border-[#FECACA] rounded-lg px-3 py-2"
        >
          <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
          <span>
            Hard HTTP 402 cutoff active. All Child VMs committed a clean Git checkpoint and saved
            durable state (BUDGET_PAUSED). Click &ldquo;Top-Up +0.50 &amp; Resume&rdquo; to continue.
          </span>
        </div>
      )}
    </section>
  );
}

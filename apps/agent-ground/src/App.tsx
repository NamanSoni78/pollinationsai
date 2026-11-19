import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { BudgetBar } from "./components/BudgetBar";
import { StudioView } from "./components/StudioView";
import { BlackboardView } from "./components/BlackboardView";
import { ClosedLoopView } from "./components/ClosedLoopView";
import { PublishSkillsView } from "./components/PublishSkillsView";
import type { OverviewState } from "./types";

type ActiveTab = "studio" | "blackboard" | "closed-loop" | "publish-skills";

declare global {
  interface HTMLElementTagNameMap {
    "polli-connect": HTMLElement & { apiKey?: string | null };
  }
}

export default function App() {
  const [state, setState] = useState<OverviewState | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("agent-frontend-02");
  const [activeTab, setActiveTab] = useState<ActiveTab>("studio");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [polliWidgetReady, setPolliWidgetReady] = useState(false);
  const polliMountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void api
      .getState()
      .then((s) => {
        setState(s);
        if (!s.agentDetails[selectedAgentId] && s.agents[0]) {
          setSelectedAgentId(s.agents[0].agent_id);
        }
      })
      .catch((err) => setErrorMsg(err instanceof Error ? err.message : String(err)));
  }, []);

  // Load Pollinations Pay drop-in <polli-connect> script cleanly without blocking initial render
  useEffect(() => {
    const existing = document.querySelector('script[data-polli-connect="true"]');
    if (!existing) {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@pollinations/ui@0.1.0-alpha.20/dist/connect.js";
      script.defer = true;
      script.dataset.polliConnect = "true";
      script.onload = () => setPolliWidgetReady(true);
      document.head.appendChild(script);
    } else {
      setPolliWidgetReady(true);
    }
  }, []);

  useEffect(() => {
    const host = polliMountRef.current;
    if (!host || !polliWidgetReady) return;
    if (host.querySelector("polli-connect")) return;

    const el = document.createElement("polli-connect") as HTMLElement & {
      apiKey?: string | null;
    };
    el.setAttribute("budget", "2");
    el.setAttribute("expiry", "7");
    el.setAttribute("permissions", "profile,usage");
    const onChange = () => {
      if (el.apiKey) {
        void runAction(async () => {
          const res = await api.connectPollinations(el.apiKey!);
          setState(res.state);
        });
      } else {
        void runAction(async () => {
          const res = await api.disconnectPollinations();
          setState(res.state);
        });
      }
    };
    el.addEventListener("change", onChange);
    host.appendChild(el);
    return () => {
      el.removeEventListener("change", onChange);
    };
  }, [polliWidgetReady]);

  async function runAction<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setErrorMsg(null);
    try {
      return await fn();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-[#111827] flex flex-col">
      {/* Strict 3-Zone Top Bar Contract (Desktop) + Clean Mobile Tab Strip */}
      <header className="sticky top-0 z-20 bg-white/95 backdrop-blur-xs border-b border-[#E5E7EB]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 h-14 md:h-16 flex items-center justify-between gap-4 md:gap-8">
          {/* Zone 1: Single text wordmark */}
          <a
            href="#studio"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab("studio");
            }}
            className="font-display text-lg font-bold tracking-tight text-[#111827] whitespace-nowrap shrink-0"
          >
            Agent Ground
          </a>

          {/* Zone 2: 4 concise single-line nav links (Desktop) */}
          <nav aria-label="Primary" className="hidden md:flex items-center gap-6">
            {(
              [
                { id: "studio", label: "Studio" },
                { id: "blackboard", label: "Blackboard" },
                { id: "closed-loop", label: "Closed Loop" },
                { id: "publish-skills", label: "Publish & Skills" },
              ] as const
            ).map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`py-1 text-sm font-medium transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                    active
                      ? "border-[#4D7C0F] text-[#111827]"
                      : "border-transparent text-[#6B7280] hover:text-[#111827]"
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: Single Primary Action (Pollinations Pay BYOP Connect) */}
          <div className="flex items-center shrink-0">
            <div ref={polliMountRef} className="inline-flex items-center" />
            {!polliWidgetReady && (
              <a
                href="https://enter.pollinations.ai/authorize"
                target="_blank"
                rel="noreferrer"
                className="px-3.5 py-2 text-xs font-semibold text-white bg-[#4D7C0F] hover:bg-[#3F6212] rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Continue with Pollinations
              </a>
            )}
          </div>
        </div>

        {/* Mobile navigation row (<768px): keeps total sticky height <= 100px (<12% of 844px) */}
        <nav
          aria-label="Mobile Primary"
          className="md:hidden flex items-center justify-between border-t border-[#F3F4F6] px-2 overflow-x-auto"
        >
          {(
            [
              { id: "studio", label: "Studio" },
              { id: "blackboard", label: "Blackboard" },
              { id: "closed-loop", label: "Closed Loop" },
              { id: "publish-skills", label: "Publish & Skills" },
            ] as const
          ).map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`px-2.5 py-2.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                  active
                    ? "border-[#4D7C0F] text-[#111827]"
                    : "border-transparent text-[#6B7280]"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6 space-y-6">
        {errorMsg && (
          <div
            role="alert"
            className="flex items-center justify-between gap-4 px-4 py-3 text-xs text-[#991B1B] bg-[#FEF2F2] border border-[#FECACA] rounded-xl"
          >
            <span>{errorMsg}</span>
            <button
              type="button"
              onClick={() => setErrorMsg(null)}
              className="font-semibold underline whitespace-nowrap shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {!state ? (
          <div className="space-y-4">
            <div className="h-28 bg-white border border-[#E5E7EB] rounded-xl animate-pulse" />
            <div className="h-96 bg-white border border-[#E5E7EB] rounded-xl animate-pulse" />
          </div>
        ) : (
          <>
            <BudgetBar
              identity={state.identity}
              budget={state.budget}
              selectedAgentId={selectedAgentId}
              busy={busy}
              onSetCap={(cap) => {
                void runAction(async () => {
                  const res = await api.setBudgetCap(cap);
                  setState(res.state);
                });
              }}
              onTopUp={(amount) => {
                void runAction(async () => {
                  const res = await api.topUpAndResume(amount);
                  setState(res.state);
                });
              }}
              onSimulateBurn={(amount, agentId) => {
                void runAction(async () => {
                  const res = await api.simulateBurn(amount, agentId);
                  setState(res.state);
                });
              }}
            />

            {activeTab === "studio" && (
              <StudioView
                state={state}
                selectedAgentId={selectedAgentId}
                onSelectAgent={setSelectedAgentId}
                busy={busy}
                onSpawnAgent={async (payload) => {
                  await runAction(async () => {
                    const res = await api.spawnAgent(payload);
                    setState(res.state);
                    setSelectedAgentId(payload.agentId);
                  });
                }}
                onSendChat={async (agentId, message) => {
                  await runAction(async () => {
                    const res = await api.sendChat(agentId, message);
                    setState(res.state);
                  });
                }}
                onAskAgent={async (payload) => {
                  await runAction(async () => {
                    const res = await api.askAgent(payload);
                    setState(res.state);
                  });
                }}
                onSummarize={async (agentId, reason) => {
                  await runAction(async () => {
                    const res = await api.summarizeContext(agentId, reason);
                    setState(res.state);
                  });
                }}
                onRunDiagnostics={async (agentId) => {
                  const res = await runAction(() => api.runDiagnostics(agentId));
                  if (res) {
                    setState(res.state);
                    return res;
                  }
                  throw new Error("Diagnostics failed");
                }}
              />
            )}

            {activeTab === "blackboard" && (
              <BlackboardView
                state={state}
                selectedAgentId={selectedAgentId}
                busy={busy}
                onPublishArtifact={async (payload) => {
                  await runAction(async () => {
                    const res = await api.publishArtifact(payload);
                    setState(res.state);
                  });
                }}
                onRequestPeerCheck={async (payload) => {
                  await runAction(async () => {
                    const res = await api.requestPeerCheck(payload);
                    setState(res.state);
                  });
                }}
              />
            )}

            {activeTab === "closed-loop" && (
              <ClosedLoopView
                state={state}
                selectedAgentId={selectedAgentId}
                onSelectAgent={setSelectedAgentId}
                busy={busy}
                onCloseLoop={async (agentId) => {
                  await runAction(async () => {
                    const res = await api.closeLoop(agentId);
                    setState(res.state);
                  });
                }}
                onFreezeContract={async (agentId, answers, deployTarget) => {
                  await runAction(async () => {
                    const res = await api.freezeContract(agentId, answers, deployTarget);
                    setState(res.state);
                  });
                }}
                onTestHumanGuard={async (agentId) => {
                  const res = await runAction(() => api.testHumanGuard(agentId));
                  return res ?? { blocked: false, message: "Check failed" };
                }}
                onRunWardenAudit={async (agentId, autoSelfFix) => {
                  await runAction(async () => {
                    const res = await api.runWardenAudit(agentId, autoSelfFix);
                    setState(res.state);
                  });
                }}
                onCrashRecover={async (agentId) => {
                  await runAction(async () => {
                    const res = await api.crashRecover(agentId);
                    setState(res.state);
                  });
                }}
              />
            )}

            {activeTab === "publish-skills" && (
              <PublishSkillsView
                state={state}
                selectedAgentId={selectedAgentId}
                busy={busy}
                onToggleSkill={async (agentId, name, action) => {
                  await runAction(async () => {
                    const res = await api.toggleSkill(agentId, name, action);
                    setState(res.state);
                  });
                }}
                onDeploy={async (payload) => {
                  await runAction(async () => {
                    const res = await api.deployProject(payload);
                    setState(res.state);
                  });
                }}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

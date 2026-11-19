import { useState } from "react";
import { BookOpen, CloudUpload, Cpu, Shield } from "lucide-react";
import type { AgentDetailView, OverviewState } from "../types";

interface PublishSkillsViewProps {
  state: OverviewState;
  selectedAgentId: string;
  busy: boolean;
  onToggleSkill: (agentId: string, name: string, action: "load" | "unload") => Promise<void>;
  onDeploy: (payload: {
    provider: "cloudflare_pages" | "cloudflare_workers" | "edgeone_pages";
    projectName: string;
    agentId: string;
  }) => Promise<void>;
}

export function PublishSkillsView({
  state,
  selectedAgentId,
  busy,
  onToggleSkill,
  onDeploy,
}: PublishSkillsViewProps) {
  const detail: AgentDetailView | undefined = state.agentDetails[selectedAgentId];
  const [provider, setProvider] = useState<
    "cloudflare_pages" | "cloudflare_workers" | "edgeone_pages"
  >("cloudflare_pages");
  const [projectName, setProjectName] = useState("agent-ground-studio");

  const layer2 = detail?.compiledContext.layers.find((l) => l.layer === 2);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Dynamic SDK Skills Loader */}
        <section
          aria-label="Dynamic SDK Skills Loader"
          className="lg:col-span-6 bg-white border border-[#E5E7EB] rounded-xl overflow-hidden"
        >
          <div className="px-6 py-4 border-b border-[#E5E7EB] flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-semibold text-[#111827] flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-[#4D7C0F]" aria-hidden="true" />
                Dynamic SDK Skills Loader ({selectedAgentId})
              </h2>
              <p className="mt-0.5 text-xs text-[#6B7280]">
                Mount or unmount <code className="font-mono">SKILL.md</code> instructions into Layer
                2 at runtime to reclaim prompt tokens.
              </p>
            </div>
            <div className="text-right font-mono tabular-nums shrink-0">
              <div className="text-xs font-semibold text-[#111827]" data-testid="layer2-tokens">
                Layer 2: {layer2?.estimatedTokens ?? 0} tok
              </div>
              <div className="text-[11px] text-[#6B7280]">
                {detail?.skills.filter((s) => s.loaded).length ?? 0} mounted
              </div>
            </div>
          </div>

          <div className="divide-y divide-[#F3F4F6]">
            {detail?.skills.map((skill) => (
              <div
                key={skill.name}
                className="px-6 py-3.5 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-mono font-semibold text-[#111827]">{skill.name}</span>
                    <span aria-hidden="true" className="text-[#9CA3AF]">
                      ·
                    </span>
                    <span className="font-mono tabular-nums text-[#6B7280]">
                      ~{skill.est_tokens} tok
                    </span>
                    <span aria-hidden="true" className="text-[#9CA3AF]">
                      ·
                    </span>
                    <span
                      className={
                        skill.loaded
                          ? "text-[#3F6212] font-medium"
                          : "text-[#6B7280]"
                      }
                    >
                      {skill.loaded ? "Mounted in Layer 2" : "Metadata only"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#4B5563]">{skill.description}</p>
                </div>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    onToggleSkill(
                      selectedAgentId,
                      skill.name,
                      skill.loaded ? "unload" : "load",
                    )
                  }
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
                    skill.loaded
                      ? "text-[#374151] border border-[#D1D5DB] hover:bg-[#F9FAFB]"
                      : "text-white bg-[#4D7C0F] hover:bg-[#3F6212]"
                  }`}
                >
                  {skill.loaded ? "Unload Skill" : "Load Skill"}
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Expanded Pollinations Publish MCP (Cloudflare & EdgeOne) */}
        <section
          aria-label="Expanded Publish MCP"
          className="lg:col-span-6 bg-white border border-[#E5E7EB] rounded-xl p-6 space-y-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[#111827] flex items-center gap-2">
                <CloudUpload className="w-4 h-4 text-[#4D7C0F]" aria-hidden="true" />
                Publish MCP (Cloudflare &amp; EdgeOne)
              </h2>
              <p className="mt-0.5 text-xs text-[#6B7280]">
                Autonomous deployment with out-of-band credentials and automated HTTP 200 live smoke
                testing.
              </p>
            </div>
            <div className="text-right text-[11px] font-mono text-[#4B5563] shrink-0">
              <div className="inline-flex items-center gap-1 text-[#3F6212]">
                <Shield className="w-3.5 h-3.5" aria-hidden="true" />
                Out-of-band secrets
              </div>
              <div>
                CF: {state.publish.credentials.cloudflare_configured ? "Live API" : "Sandbox Preview"}{" "}
                · EO: {state.publish.credentials.edgeone_configured ? "Live API" : "Sandbox Preview"}
              </div>
            </div>
          </div>

          <form
            className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
            onSubmit={async (e) => {
              e.preventDefault();
              await onDeploy({
                provider,
                projectName: projectName.trim(),
                agentId: selectedAgentId,
              });
            }}
          >
            <div className="sm:col-span-5">
              <label htmlFor="pub-provider" className="block text-xs font-medium text-[#374151]">
                MCP Provider
              </label>
              <select
                id="pub-provider"
                value={provider}
                onChange={(e) =>
                  setProvider(
                    e.target.value as "cloudflare_pages" | "cloudflare_workers" | "edgeone_pages",
                  )
                }
                className="mt-1 w-full px-3 py-2 text-xs font-mono bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
              >
                <option value="cloudflare_pages">cloudflare_deploy_pages</option>
                <option value="cloudflare_workers">cloudflare_deploy_worker</option>
                <option value="edgeone_pages">edgeone_deploy_pages</option>
              </select>
            </div>
            <div className="sm:col-span-4">
              <label htmlFor="pub-project" className="block text-xs font-medium text-[#374151]">
                Project Name
              </label>
              <input
                id="pub-project"
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                required
                className="mt-1 w-full px-3 py-2 text-xs font-mono bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
              />
            </div>
            <div className="sm:col-span-3">
              <button
                type="submit"
                disabled={busy}
                className="w-full px-3 py-2 text-xs font-semibold text-white bg-[#4D7C0F] hover:bg-[#3F6212] rounded-lg transition-colors whitespace-nowrap"
              >
                Deploy &amp; Smoke
              </button>
            </div>
          </form>

          <div className="pt-3 border-t border-[#F3F4F6] space-y-3">
            {state.publish.deployments.length === 0 ? (
              <p className="text-xs text-[#6B7280]">
                No deployments yet. Click &ldquo;Deploy &amp; Smoke&rdquo; to publish a sandbox build
                and verify HTTP 200 live rendering.
              </p>
            ) : (
              state.publish.deployments.slice(0, 5).map((dep, idx) => {
                const smoke = state.publish.smokeTests[idx];
                return (
                  <div
                    key={dep.deployment_id}
                    className="p-3 rounded-lg bg-[#FAFAFA] border border-[#E5E7EB] space-y-1.5"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                      <span className="font-semibold text-[#111827]">
                        {dep.project_name} ({dep.provider})
                      </span>
                      <span className="text-[#3F6212] font-semibold">
                        {smoke ? `HTTP ${smoke.http_status} · ${smoke.latency_ms}ms` : dep.status}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-[#4B5563] break-all">{dep.url}</div>
                    <div className="text-[11px] text-[#6B7280]">{dep.logs[dep.logs.length - 1]}</div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      {/* Multi-LLM Role Routing Matrix */}
      <section
        aria-label="Multi-LLM Role Routing Matrix"
        className="bg-white border border-[#E5E7EB] rounded-xl overflow-hidden"
      >
        <div className="px-6 py-4 border-b border-[#E5E7EB]">
          <h2 className="text-sm font-semibold text-[#111827] flex items-center gap-2">
            <Cpu className="w-4 h-4 text-[#4D7C0F]" aria-hidden="true" />
            Multi-LLM Role Routing Matrix (Pollinations AI APIs)
          </h2>
          <p className="mt-0.5 text-xs text-[#6B7280]">
            Configurable model aliases routed through the Pollen Metering Proxy. Non-critical Worker
            calls downshift automatically at 75% budget burn.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#E5E7EB] bg-[#FAFAFA] text-[#6B7280]">
                <th className="py-2.5 px-6 font-medium">Role</th>
                <th className="py-2.5 px-6 font-medium">Configured Pollinations Model Alias</th>
                <th className="py-2.5 px-6 font-medium">Routing Behavior</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F3F4F6]">
              {Object.entries(state.modelMatrix).map(([role, model]) => (
                <tr key={role} className="hover:bg-[#FAFAFA]">
                  <td className="py-2.5 px-6 font-mono font-medium text-[#111827]">{role}</td>
                  <td className="py-2.5 px-6 font-mono text-[#3F6212]">{model}</td>
                  <td className="py-2.5 px-6 text-[#4B5563]">
                    {role === "worker"
                      ? "Primary OpenCode loop; downshifts to workerConserve at >=75% burn"
                      : role === "warden"
                        ? "Zero-history read-only adversarial verification auditor"
                        : role === "expert"
                          ? "On-demand escalation on doom-loop or 2x Warden rejection"
                          : role === "indexer"
                            ? "Maintains .agent/repo_map.json on boot and every commit"
                            : role === "embedding"
                              ? "Hybrid BM25 + semantic retrieval across codebase & worklogs"
                              : role === "image_gen"
                                ? "Pollinations Image Gen MCP for brand/UI visual assets"
                                : "Isolated disposable context returning concise summary"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

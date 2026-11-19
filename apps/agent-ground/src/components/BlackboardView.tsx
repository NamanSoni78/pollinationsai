import { useState } from "react";
import { FileCode2, CheckCircle2, Upload } from "lucide-react";
import type { OverviewState } from "../types";

interface BlackboardViewProps {
  state: OverviewState;
  selectedAgentId: string;
  busy: boolean;
  onPublishArtifact: (payload: {
    authorAgentId: string;
    key: string;
    version: string;
    contentType: string;
    payload: string;
    changelog: string;
  }) => Promise<void>;
  onRequestPeerCheck: (payload: {
    requesterAgentId: string;
    reviewerAgentId: string;
  }) => Promise<void>;
}

export function BlackboardView({
  state,
  selectedAgentId,
  busy,
  onPublishArtifact,
  onRequestPeerCheck,
}: BlackboardViewProps) {
  const [key, setKey] = useState("openapi-spec");
  const [version, setVersion] = useState("v2");
  const [contentType, setContentType] = useState("json");
  const [changelog, setChangelog] = useState(
    "Added CORS policy and /api/session refresh token schema",
  );
  const [payload, setPayload] = useState(
    JSON.stringify(
      {
        openapi: "3.1.0",
        info: { title: "Agent Ground API", version: "2.0.0" },
        paths: {
          "/api/session": {
            post: { responses: { "200": { description: "OK" }, "401": { description: "Unauthorized" } } },
          },
          "/api/session/refresh": {
            post: { responses: { "200": { description: "Refreshed token" } } },
          },
        },
      },
      null,
      2,
    ),
  );
  const [selectedUri, setSelectedUri] = useState<string>(
    state.artifacts[0]?.artifact_uri ?? "",
  );

  const selectedArtifact =
    state.artifacts.find((a) => a.artifact_uri === selectedUri) ?? state.artifacts[0];

  const reviewerId =
    state.agents.find((a) => a.agent_id !== selectedAgentId)?.agent_id ?? "agent-backend-01";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Artifact Registry & Inspector */}
        <section
          aria-label="Shared Artifact Blackboard"
          className="lg:col-span-7 bg-white border border-[#E5E7EB] rounded-xl overflow-hidden"
        >
          <div className="px-6 py-4 border-b border-[#E5E7EB] flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-[#111827] flex items-center gap-2">
                <FileCode2 className="w-4 h-4 text-[#4D7C0F]" aria-hidden="true" />
                Shared Artifact Blackboard ({state.artifacts.length})
              </h2>
              <p className="mt-0.5 text-xs text-[#6B7280]">
                Immutable versioned specs, TypeScript types, generated visual assets &amp; preview
                URLs. Publishing wakes subscribed sleeping agents.
              </p>
            </div>
          </div>

          <div className="divide-y divide-[#F3F4F6]">
            {state.artifacts.map((art) => {
              const active = selectedArtifact?.artifact_uri === art.artifact_uri;
              return (
                <button
                  key={art.artifact_uri}
                  type="button"
                  onClick={() => setSelectedUri(art.artifact_uri)}
                  className={`w-full text-left px-6 py-3.5 transition-colors ${
                    active ? "bg-[#F7FEE7]" : "hover:bg-[#FAFAFA]"
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-mono font-semibold text-[#111827]">
                      {art.key}@{art.version}
                    </span>
                    <span className="text-[11px] font-mono text-[#6B7280]">
                      {art.content_type} · {art.author_agent_id}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#4B5563]">{art.changelog}</p>
                  {art.diff_summary && (
                    <div className="mt-1 text-[11px] font-mono text-[#3F6212]">
                      Diff: {art.diff_summary}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {selectedArtifact && (
            <div className="p-6 bg-[#FAFAFA] border-t border-[#E5E7EB]">
              <div className="flex items-center justify-between text-xs font-mono text-[#4B5563] mb-2">
                <span>{selectedArtifact.artifact_uri}</span>
                <span>{new Date(selectedArtifact.created_at).toLocaleTimeString()}</span>
              </div>
              <pre className="p-4 bg-white border border-[#E5E7EB] rounded-lg text-xs font-mono text-[#111827] overflow-x-auto max-h-60">
                {selectedArtifact.payload}
              </pre>
            </div>
          )}
        </section>

        {/* Publish New Version + Pre-Warden Peer QA */}
        <div className="lg:col-span-5 space-y-6">
          <section
            aria-label="Publish Blackboard Artifact"
            className="bg-white border border-[#E5E7EB] rounded-xl p-6 space-y-4"
          >
            <div>
              <h2 className="text-sm font-semibold text-[#111827] flex items-center gap-2">
                <Upload className="w-4 h-4 text-[#4D7C0F]" aria-hidden="true" />
                Publish Artifact Version (ground_publish_artifact)
              </h2>
              <p className="mt-0.5 text-xs text-[#6B7280]">
                Dispatches a diff event to all subscribed Child VMs waiting in{" "}
                <code className="font-mono">sleep(until_event)</code>.
              </p>
            </div>

            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                await onPublishArtifact({
                  authorAgentId: selectedAgentId,
                  key: key.trim(),
                  version: version.trim(),
                  contentType,
                  payload,
                  changelog: changelog.trim(),
                });
                // Auto-increment version suggestion after publish
                const num = Number.parseInt(version.replace(/\D/g, ""), 10);
                if (Number.isFinite(num)) setVersion(`v${num + 1}`);
              }}
            >
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label htmlFor="art-key" className="block text-xs font-medium text-[#374151]">
                    Key
                  </label>
                  <input
                    id="art-key"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                    required
                    className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
                  />
                </div>
                <div>
                  <label htmlFor="art-version" className="block text-xs font-medium text-[#374151]">
                    Version
                  </label>
                  <input
                    id="art-version"
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    required
                    className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
                  />
                </div>
                <div>
                  <label htmlFor="art-type" className="block text-xs font-medium text-[#374151]">
                    Type
                  </label>
                  <select
                    id="art-type"
                    value={contentType}
                    onChange={(e) => setContentType(e.target.value)}
                    className="mt-1 w-full px-2.5 py-1.5 text-xs font-mono bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
                  >
                    <option value="json">json</option>
                    <option value="typescript">typescript</option>
                    <option value="markdown">markdown</option>
                    <option value="url">url</option>
                    <option value="image_url">image_url</option>
                  </select>
                </div>
              </div>

              <div>
                <label htmlFor="art-changelog" className="block text-xs font-medium text-[#374151]">
                  Changelog
                </label>
                <input
                  id="art-changelog"
                  value={changelog}
                  onChange={(e) => setChangelog(e.target.value)}
                  required
                  className="mt-1 w-full px-3 py-1.5 text-xs bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
                />
              </div>

              <div>
                <label htmlFor="art-payload" className="block text-xs font-medium text-[#374151]">
                  Payload
                </label>
                <textarea
                  id="art-payload"
                  rows={5}
                  value={payload}
                  onChange={(e) => setPayload(e.target.value)}
                  required
                  className="mt-1 w-full px-3 py-2 text-xs font-mono bg-[#FAFAFA] border border-[#D1D5DB] rounded-lg"
                />
              </div>

              <button
                type="submit"
                disabled={busy}
                className="w-full px-4 py-2 text-xs font-semibold text-white bg-[#4D7C0F] hover:bg-[#3F6212] rounded-lg transition-colors"
              >
                Publish Artifact &amp; Wake Subscribers
              </button>
            </form>
          </section>

          <section
            aria-label="Pre-Warden Peer QA"
            className="bg-white border border-[#E5E7EB] rounded-xl p-6 space-y-3"
          >
            <h2 className="text-sm font-semibold text-[#111827] flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-[#4D7C0F]" aria-hidden="true" />
              Pre-Warden Peer Check (ground_request_peer_check)
            </h2>
            <p className="text-xs text-[#6B7280]">
              Have <span className="font-mono text-[#111827]">{reviewerId}</span> run a live HTTP
              smoke probe on <span className="font-mono text-[#111827]">{selectedAgentId}</span>
              &rsquo;s preview URL before burning Frontier Warden Pollen.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                onRequestPeerCheck({
                  requesterAgentId: selectedAgentId,
                  reviewerAgentId: reviewerId,
                })
              }
              className="px-4 py-2 text-xs font-semibold text-[#111827] bg-[#F3F4F6] hover:bg-[#E5E7EB] rounded-lg transition-colors"
            >
              Request Peer Smoke Check
            </button>

            {state.peerChecks.length > 0 && (
              <div className="pt-3 border-t border-[#F3F4F6] space-y-2">
                {state.peerChecks.slice(0, 4).map((pc) => (
                  <div
                    key={pc.id}
                    className="p-2.5 rounded-lg bg-[#FAFAFA] border border-[#E5E7EB] text-xs"
                  >
                    <div className="flex items-center justify-between font-mono text-[11px]">
                      <span className="text-[#111827]">
                        {pc.reviewer_agent_id} -&gt; {pc.requester_agent_id}
                      </span>
                      <span className={pc.passed ? "text-[#3F6212] font-semibold" : "text-[#B91C1C] font-semibold"}>
                        {pc.passed ? "PASS" : "FAIL"}
                      </span>
                    </div>
                    <p className="mt-1 text-[#4B5563]">{pc.findings.join(" · ")}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

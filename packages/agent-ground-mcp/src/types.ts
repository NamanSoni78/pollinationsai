export type AgentStatus =
  | "idle"
  | "im_chat"
  | "preflight_interview"
  | "closed_loop_running"
  | "sleeping"
  | "warden_audit"
  | "budget_paused"
  | "completed"
  | "blocked";

export interface AgentCard {
  agent_id: string;
  owner_pollinations_id: string;
  role: string;
  current_goal: string;
  status: AgentStatus;
  stack: string[];
  owned_paths: string[];
  git_branch: string;
  published_artifacts: string[];
  preview_url?: string;
  last_summary: string;
  updated_at: string;
}

export type ArtifactContentType =
  | "json"
  | "typescript"
  | "markdown"
  | "url"
  | "image_url";

export interface ArtifactRecord {
  key: string;
  version: string;
  artifact_uri: string;
  author_agent_id: string;
  content_type: ArtifactContentType;
  payload: string;
  changelog: string;
  created_at: string;
  previous_version?: string;
  diff_summary?: string;
}

export type BroadcastKind = "milestone" | "blocked" | "needs_review" | "deployed";

export interface WatercoolerEvent {
  id: string;
  timestamp: string;
  agent_id: string;
  kind: BroadcastKind | "shoulder_tap" | "artifact_published" | "peer_check";
  summary: string;
  details?: Record<string, unknown>;
}

export interface NegotiateChangeMessage {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  question: string;
  created_at: string;
  status: "queued" | "delivered" | "accepted" | "countered" | "scheduled";
  response?: string;
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

export interface GroundEventPacket {
  type: "ground_artifact" | "ground_reply" | "ground_broadcast" | "peer_check";
  key?: string;
  version?: string;
  agent_id?: string;
  payload: unknown;
  timestamp: string;
}

export type ShadowReaderHandler = (params: {
  from_agent_id: string;
  question: string;
}) => Promise<{ answer: string; citations: string[] }>;

export type PeerCheckHandler = (params: {
  requester_agent_id: string;
  preview_url: string;
  checks?: string[];
}) => Promise<{ passed: boolean; findings: string[] }>;

/**
 * Exact Agent Ground MCP Tool Surface exposed to every Child VM (Issue #20357).
 */
export interface AgentGroundMCP {
  ground_list_agents(filter?: { status?: string; tag?: string }): Promise<AgentCard[]>;
  ground_ask_agent(params: {
    from_agent_id?: string;
    target_agent_id: string;
    question: string;
    mode: "readonly_query" | "negotiate_change";
    reply_timeout_sec?: number;
  }): Promise<{ answer: string; citations?: string[]; status: "answered" | "queued" }>;
  ground_publish_artifact(params: {
    author_agent_id?: string;
    key: string;
    version: string;
    content_type: ArtifactContentType;
    payload: string;
    changelog: string;
  }): Promise<{ artifact_uri: string }>;
  ground_fetch_artifact(params: { key: string; version?: string }): Promise<ArtifactRecord>;
  ground_subscribe(params: {
    subscriber_agent_id?: string;
    artifact_keys?: string[];
    agent_ids?: string[];
  }): Promise<{ subscription_id: string }>;
  ground_broadcast(params: {
    agent_id?: string;
    kind: BroadcastKind;
    summary: string;
    details?: Record<string, unknown>;
  }): Promise<void>;
  ground_request_peer_check(params: {
    requester_agent_id?: string;
    reviewer_agent_id: string;
    preview_url: string;
    checks?: string[];
  }): Promise<PeerCheckResult>;
}

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  AgentCard,
  AgentGroundMCP,
  ArtifactContentType,
  ArtifactRecord,
  BroadcastKind,
  GroundEventPacket,
  NegotiateChangeMessage,
  PeerCheckHandler,
  PeerCheckResult,
  PeerConversationEntry,
  ShadowReaderHandler,
  WatercoolerEvent,
} from "./types";

interface SubscriptionRecord {
  id: string;
  subscriber_agent_id: string;
  artifact_keys: Set<string>;
  agent_ids: Set<string>;
}

/**
 * Simple glob prefix overlap check for `owned_paths` (e.g. `apps/api/**` vs `apps/api/routes/**`).
 */
export function pathsOverlap(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+\*\*?$/, "").replace(/^\/+/, "");
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}

function summarizePayloadDiff(previous: string | undefined, next: string): string {
  if (previous === undefined) {
    return `Initial publish (${next.length} bytes).`;
  }
  const prevLines = previous.split("\n");
  const nextLines = next.split("\n");
  const added = nextLines.filter((l) => !prevLines.includes(l)).length;
  const removed = prevLines.filter((l) => !nextLines.includes(l)).length;
  return `+${added} / -${removed} lines (${previous.length} -> ${next.length} bytes)`;
}

/**
 * Parent control plane hub powering Agent Ground:
 * - Live Agent Directory (`AgentCard` registry)
 * - Dual-Channel Shoulder Tap (`readonly_query` Shadow Reader vs `negotiate_change` inbox)
 * - Shared Versioned Artifact Blackboard + event wakeups for sleeping peers
 * - Watercooler Broadcast Stream + Pre-Warden Peer Check
 * - `owned_paths` conflict locks & isolated Git branch registry
 */
export class AgentGroundHub extends EventEmitter implements AgentGroundMCP {
  private agents = new Map<string, AgentCard>();
  private shadowReaders = new Map<string, ShadowReaderHandler>();
  private peerCheckHandlers = new Map<string, PeerCheckHandler>();
  private inboxes = new Map<string, NegotiateChangeMessage[]>();
  private artifacts = new Map<string, ArtifactRecord[]>();
  private subscriptions = new Map<string, SubscriptionRecord>();
  private watercooler: WatercoolerEvent[] = [];
  private conversations: PeerConversationEntry[] = [];
  private peerChecks: PeerCheckResult[] = [];

  /**
   * Registers or updates a Child VM agent on the Ground, enforcing `owned_paths` isolation
   * so two concurrent agents cannot silently overwrite each other's directories.
   */
  registerAgent(
    card: Omit<AgentCard, "updated_at" | "git_branch"> & { git_branch?: string },
    handlers?: {
      shadowReader?: ShadowReaderHandler;
      peerCheck?: PeerCheckHandler;
    },
  ): AgentCard {
    // Validate owned_paths lock against other active agents
    for (const [otherId, otherCard] of this.agents.entries()) {
      if (otherId === card.agent_id || otherCard.status === "completed") continue;
      for (const p1 of card.owned_paths) {
        for (const p2 of otherCard.owned_paths) {
          if (pathsOverlap(p1, p2)) {
            throw new Error(
              `Path ownership conflict: "${p1}" for ${card.agent_id} overlaps "${p2}" already owned by ${otherId}.`,
            );
          }
        }
      }
    }

    const branchSlug = card.current_goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32) || "work";

    const fullCard: AgentCard = {
      ...card,
      git_branch: card.git_branch ?? `agent/${card.agent_id}/${branchSlug}`,
      updated_at: new Date().toISOString(),
    };

    this.agents.set(card.agent_id, fullCard);
    if (!this.inboxes.has(card.agent_id)) {
      this.inboxes.set(card.agent_id, []);
    }
    if (handlers?.shadowReader) {
      this.shadowReaders.set(card.agent_id, handlers.shadowReader);
    }
    if (handlers?.peerCheck) {
      this.peerCheckHandlers.set(card.agent_id, handlers.peerCheck);
    }

    this.emit("agent_updated", fullCard);
    return fullCard;
  }

  updateAgent(
    agentId: string,
    patch: Partial<Omit<AgentCard, "agent_id" | "updated_at">>,
  ): AgentCard {
    const existing = this.agents.get(agentId);
    if (!existing) {
      throw new Error(`Agent "${agentId}" is not registered on Agent Ground.`);
    }
    const updated: AgentCard = {
      ...existing,
      ...patch,
      updated_at: new Date().toISOString(),
    };
    this.agents.set(agentId, updated);
    this.emit("agent_updated", updated);
    return updated;
  }

  attachShadowReader(agentId: string, handler: ShadowReaderHandler): void {
    this.shadowReaders.set(agentId, handler);
  }

  attachPeerCheckHandler(agentId: string, handler: PeerCheckHandler): void {
    this.peerCheckHandlers.set(agentId, handler);
  }

  async ground_list_agents(filter?: {
    status?: string;
    tag?: string;
  }): Promise<AgentCard[]> {
    let list = Array.from(this.agents.values());
    if (filter?.status) {
      list = list.filter((a) => a.status === filter.status);
    }
    if (filter?.tag) {
      const needle = filter.tag.toLowerCase();
      list = list.filter(
        (a) =>
          a.role.toLowerCase().includes(needle) ||
          a.stack.some((s) => s.toLowerCase().includes(needle)),
      );
    }
    return list;
  }

  async ground_ask_agent(params: {
    from_agent_id?: string;
    target_agent_id: string;
    question: string;
    mode: "readonly_query" | "negotiate_change";
    reply_timeout_sec?: number;
  }): Promise<{ answer: string; citations?: string[]; status: "answered" | "queued" }> {
    const target = this.agents.get(params.target_agent_id);
    if (!target) {
      throw new Error(`Target agent "${params.target_agent_id}" not found on Agent Ground.`);
    }
    const fromId = params.from_agent_id ?? "ground-operator";

    if (params.mode === "readonly_query") {
      // Non-disruptive Shadow Reader path: never mutates target Worker context or inbox
      const shadow = this.shadowReaders.get(params.target_agent_id);
      let answer: string;
      let citations: string[];

      if (shadow) {
        const res = await shadow({ from_agent_id: fromId, question: params.question });
        answer = res.answer;
        citations = res.citations;
      } else {
        answer = `[Shadow Reader — ${target.agent_id}] Role: ${target.role}. Current goal: ${target.current_goal}. Last summary: ${target.last_summary}. Owned paths: ${target.owned_paths.join(", ")}.`;
        citations = target.owned_paths.map((p) => `${p} (AgentCard metadata)`);
      }

      const conv: PeerConversationEntry = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        from_agent_id: fromId,
        to_agent_id: params.target_agent_id,
        mode: "readonly_query",
        question: params.question,
        answer,
        citations,
        status: "answered",
        disrupted_worker_context: false,
      };
      this.conversations.unshift(conv);
      this.recordWatercooler({
        agent_id: fromId,
        kind: "shoulder_tap",
        summary: `Shadow Reader query ${fromId} -> ${params.target_agent_id}: "${params.question.slice(0, 80)}"`,
        details: { mode: "readonly_query", citations },
      });

      this.dispatchEvent({
        type: "ground_reply",
        agent_id: fromId,
        payload: conv,
        timestamp: conv.timestamp,
      });

      return { answer, citations, status: "answered" };
    }

    // Async Action Inbox path: queued cleanly for next step boundary
    const msg: NegotiateChangeMessage = {
      id: randomUUID(),
      from_agent_id: fromId,
      to_agent_id: params.target_agent_id,
      question: params.question,
      created_at: new Date().toISOString(),
      status: "queued",
    };
    const inbox = this.inboxes.get(params.target_agent_id) ?? [];
    inbox.push(msg);
    this.inboxes.set(params.target_agent_id, inbox);

    const queuedAnswer = `Queued change request (${msg.id.slice(0, 8)}) for ${params.target_agent_id}'s next step boundary.`;
    const conv: PeerConversationEntry = {
      id: msg.id,
      timestamp: msg.created_at,
      from_agent_id: fromId,
      to_agent_id: params.target_agent_id,
      mode: "negotiate_change",
      question: params.question,
      answer: queuedAnswer,
      citations: [],
      status: "queued",
      disrupted_worker_context: false,
    };
    this.conversations.unshift(conv);
    this.recordWatercooler({
      agent_id: fromId,
      kind: "shoulder_tap",
      summary: `Negotiate change queued ${fromId} -> ${params.target_agent_id}: "${params.question.slice(0, 80)}"`,
      details: { mode: "negotiate_change", message_id: msg.id },
    });

    this.dispatchEvent({
      type: "ground_reply",
      agent_id: params.target_agent_id,
      payload: msg,
      timestamp: msg.created_at,
    });

    return { answer: queuedAnswer, status: "queued" };
  }

  /**
   * Drains queued `negotiate_change` messages cleanly at an agent's step boundary.
   */
  drainInbox(agentId: string): NegotiateChangeMessage[] {
    const inbox = this.inboxes.get(agentId) ?? [];
    const pending = inbox.filter((m) => m.status === "queued");
    for (const m of pending) {
      m.status = "delivered";
    }
    return pending;
  }

  peekInbox(agentId: string): NegotiateChangeMessage[] {
    return [...(this.inboxes.get(agentId) ?? [])];
  }

  resolveInboxMessage(
    agentId: string,
    messageId: string,
    resolution: "accepted" | "countered" | "scheduled",
    response: string,
  ): NegotiateChangeMessage {
    const inbox = this.inboxes.get(agentId) ?? [];
    const found = inbox.find((m) => m.id === messageId);
    if (!found) {
      throw new Error(`Inbox message "${messageId}" not found for ${agentId}.`);
    }
    found.status = resolution;
    found.response = response;

    this.dispatchEvent({
      type: "ground_reply",
      agent_id: found.from_agent_id,
      payload: found,
      timestamp: new Date().toISOString(),
    });
    return found;
  }

  async ground_publish_artifact(params: {
    author_agent_id?: string;
    key: string;
    version: string;
    content_type: ArtifactContentType;
    payload: string;
    changelog: string;
  }): Promise<{ artifact_uri: string }> {
    const versions = this.artifacts.get(params.key) ?? [];
    if (versions.some((v) => v.version === params.version)) {
      throw new Error(
        `Artifact "${params.key}@${params.version}" is immutable and already exists. Increment version.`,
      );
    }

    const previous = versions[versions.length - 1];
    const authorId = params.author_agent_id ?? "ground-operator";
    const record: ArtifactRecord = {
      key: params.key,
      version: params.version,
      artifact_uri: `ground://artifacts/${params.key}@${params.version}`,
      author_agent_id: authorId,
      content_type: params.content_type,
      payload: params.payload,
      changelog: params.changelog,
      created_at: new Date().toISOString(),
      previous_version: previous?.version,
      diff_summary: summarizePayloadDiff(previous?.payload, params.payload),
    };

    versions.push(record);
    this.artifacts.set(params.key, versions);

    // Update author's AgentCard published_artifacts list automatically
    const authorCard = this.agents.get(authorId);
    if (authorCard) {
      const ref = `${params.key}@${params.version}`;
      if (!authorCard.published_artifacts.includes(ref)) {
        authorCard.published_artifacts = [...authorCard.published_artifacts, ref];
        authorCard.updated_at = record.created_at;
      }
      if (params.content_type === "url") {
        authorCard.preview_url = params.payload;
      }
      this.emit("agent_updated", authorCard);
    }

    this.recordWatercooler({
      agent_id: authorId,
      kind: "artifact_published",
      summary: `Published ${params.key}@${params.version} (${params.content_type}) — ${params.changelog}`,
      details: { artifact_uri: record.artifact_uri, diff_summary: record.diff_summary },
    });

    // Wake up subscribed agents waiting in sleep(until_event: "ground_artifact")
    this.dispatchEvent({
      type: "ground_artifact",
      key: params.key,
      version: params.version,
      agent_id: authorId,
      payload: record,
      timestamp: record.created_at,
    });

    return { artifact_uri: record.artifact_uri };
  }

  async ground_fetch_artifact(params: {
    key: string;
    version?: string;
  }): Promise<ArtifactRecord> {
    const versions = this.artifacts.get(params.key);
    if (!versions || versions.length === 0) {
      throw new Error(`Artifact "${params.key}" not found on Ground Blackboard.`);
    }
    if (!params.version) {
      return versions[versions.length - 1];
    }
    const found = versions.find((v) => v.version === params.version);
    if (!found) {
      throw new Error(`Artifact "${params.key}@${params.version}" not found.`);
    }
    return found;
  }

  listArtifacts(): ArtifactRecord[] {
    const out: ArtifactRecord[] = [];
    for (const versions of this.artifacts.values()) {
      out.push(...versions);
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async ground_subscribe(params: {
    subscriber_agent_id?: string;
    artifact_keys?: string[];
    agent_ids?: string[];
  }): Promise<{ subscription_id: string }> {
    const sub: SubscriptionRecord = {
      id: `sub-${randomUUID().slice(0, 8)}`,
      subscriber_agent_id: params.subscriber_agent_id ?? "ground-operator",
      artifact_keys: new Set(params.artifact_keys ?? []),
      agent_ids: new Set(params.agent_ids ?? []),
    };
    this.subscriptions.set(sub.id, sub);
    return { subscription_id: sub.id };
  }

  listSubscriptions(agentId?: string): Array<{
    id: string;
    subscriber_agent_id: string;
    artifact_keys: string[];
    agent_ids: string[];
  }> {
    return Array.from(this.subscriptions.values())
      .filter((s) => !agentId || s.subscriber_agent_id === agentId)
      .map((s) => ({
        id: s.id,
        subscriber_agent_id: s.subscriber_agent_id,
        artifact_keys: Array.from(s.artifact_keys),
        agent_ids: Array.from(s.agent_ids),
      }));
  }

  async ground_broadcast(params: {
    agent_id?: string;
    kind: BroadcastKind;
    summary: string;
    details?: Record<string, unknown>;
  }): Promise<void> {
    const agentId = params.agent_id ?? "ground-operator";
    const ev = this.recordWatercooler({
      agent_id: agentId,
      kind: params.kind,
      summary: params.summary,
      details: params.details,
    });

    const card = this.agents.get(agentId);
    if (card) {
      card.last_summary = params.summary;
      if (params.kind === "blocked") card.status = "blocked";
      card.updated_at = ev.timestamp;
      this.emit("agent_updated", card);
    }

    this.dispatchEvent({
      type: "ground_broadcast",
      agent_id: agentId,
      payload: ev,
      timestamp: ev.timestamp,
    });
  }

  async ground_request_peer_check(params: {
    requester_agent_id?: string;
    reviewer_agent_id: string;
    preview_url: string;
    checks?: string[];
  }): Promise<PeerCheckResult> {
    const requester = params.requester_agent_id ?? "ground-operator";
    const reviewer = this.agents.get(params.reviewer_agent_id);
    if (!reviewer) {
      throw new Error(`Reviewer agent "${params.reviewer_agent_id}" is not registered.`);
    }

    const customHandler = this.peerCheckHandlers.get(params.reviewer_agent_id);
    let passed = true;
    let findings: string[] = [];

    if (customHandler) {
      const res = await customHandler({
        requester_agent_id: requester,
        preview_url: params.preview_url,
        checks: params.checks,
      });
      passed = res.passed;
      findings = res.findings;
    } else {
      // Live HTTP smoke probe if reachable
      try {
        const res = await fetch(params.preview_url);
        passed = res.status >= 200 && res.status < 400;
        findings = [
          `Peer ${params.reviewer_agent_id} probed ${params.preview_url} -> HTTP ${res.status}`,
        ];
      } catch (err) {
        passed = false;
        findings = [
          `Peer ${params.reviewer_agent_id} could not reach ${params.preview_url}: ${err instanceof Error ? err.message : String(err)}`,
        ];
      }
    }

    const result: PeerCheckResult = {
      id: randomUUID(),
      requester_agent_id: requester,
      reviewer_agent_id: params.reviewer_agent_id,
      preview_url: params.preview_url,
      passed,
      findings,
      checked_at: new Date().toISOString(),
    };
    this.peerChecks.unshift(result);

    this.recordWatercooler({
      agent_id: params.reviewer_agent_id,
      kind: "peer_check",
      summary: `Peer QA (${passed ? "PASS" : "FAIL"}) for ${requester} on ${params.preview_url}`,
      details: { findings },
    });

    this.dispatchEvent({
      type: "peer_check",
      agent_id: requester,
      payload: result,
      timestamp: result.checked_at,
    });

    return result;
  }

  getWatercooler(limit = 100): WatercoolerEvent[] {
    return this.watercooler.slice(0, limit);
  }

  getConversations(limit = 100): PeerConversationEntry[] {
    return this.conversations.slice(0, limit);
  }

  getPeerChecks(limit = 50): PeerCheckResult[] {
    return this.peerChecks.slice(0, limit);
  }

  /**
   * Returns a Promise that resolves as soon as a matching Ground event fires
   * (used by Child VM `sleep({ until_event: "ground_artifact" | "ground_reply" })`).
   */
  waitForEvent(params: {
    agentId: string;
    eventType: "ground_artifact" | "ground_reply" | "ground_broadcast";
    maxWaitMs: number;
    signal?: AbortSignal;
  }): Promise<{ wake_reason: string; event_payload?: unknown }> {
    return new Promise((resolve) => {
      let settled = false;

      const finish = (wake_reason: string, event_payload?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off("ground_event", onEvent);
        params.signal?.removeEventListener("abort", onAbort);
        resolve({ wake_reason, event_payload });
      };

      const onEvent = (packet: GroundEventPacket) => {
        if (packet.type !== params.eventType) return;
        if (params.eventType === "ground_artifact") {
          const subs = Array.from(this.subscriptions.values()).filter(
            (s) => s.subscriber_agent_id === params.agentId,
          );
          const matchesSub =
            subs.length === 0 ||
            subs.some(
              (s) =>
                (packet.key && s.artifact_keys.has(packet.key)) ||
                (packet.agent_id && s.agent_ids.has(packet.agent_id)),
            );
          if (matchesSub) {
            finish(`ground_artifact:${packet.key}@${packet.version}`, packet.payload);
          }
        } else if (
          params.eventType === "ground_reply" &&
          packet.agent_id === params.agentId
        ) {
          finish("ground_reply", packet.payload);
        } else if (params.eventType === "ground_broadcast") {
          finish("ground_broadcast", packet.payload);
        }
      };

      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), params.maxWaitMs);

      this.on("ground_event", onEvent);
      params.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private recordWatercooler(
    input: Omit<WatercoolerEvent, "id" | "timestamp">,
  ): WatercoolerEvent {
    const ev: WatercoolerEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...input,
    };
    this.watercooler.unshift(ev);
    if (this.watercooler.length > 500) {
      this.watercooler.length = 500;
    }
    this.emit("watercooler", ev);
    return ev;
  }

  private dispatchEvent(packet: GroundEventPacket): void {
    this.emit("ground_event", packet);
  }
}

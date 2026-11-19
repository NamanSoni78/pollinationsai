import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "./context-compiler";
import type { HybridRagIndex } from "./indexer-rag";
import type { ChatTurn } from "./types";

export const SPILL_THRESHOLD_BYTES = 4096;
export const PREVIEW_EDGE_LINES = 25;

export interface SpillResult {
  spilled: boolean;
  content: string;
  logFilePath?: string;
  totalBytes: number;
  totalLines: number;
}

/**
 * Heavy-Context Survival: Large Output Spill-to-Disk (Issue #20357 §3.B.3).
 * Any shell/build/test output > 4 KB is automatically saved to `.agent/logs/<uuid>.txt`,
 * injecting only first 25 lines + last 25 lines + line count + file path into Layer 6.
 */
export function spillLargeOutputToDisk(
  workspaceDir: string,
  rawOutput: string,
  label = "tool-output",
): SpillResult {
  const totalBytes = Buffer.byteLength(rawOutput, "utf8");
  const lines = rawOutput.split("\n");
  const totalLines = lines.length;

  if (totalBytes <= SPILL_THRESHOLD_BYTES) {
    return {
      spilled: false,
      content: rawOutput,
      totalBytes,
      totalLines,
    };
  }

  const logsDir = join(workspaceDir, ".agent", "logs");
  mkdirSync(logsDir, { recursive: true });
  const fileName = `${randomUUID()}.txt`;
  const logFilePath = join(logsDir, fileName);
  writeFileSync(logFilePath, rawOutput, "utf8");

  const head = lines.slice(0, PREVIEW_EDGE_LINES).join("\n");
  const tail =
    totalLines > PREVIEW_EDGE_LINES * 2
      ? lines.slice(-PREVIEW_EDGE_LINES).join("\n")
      : "";

  const omittedLines = Math.max(0, totalLines - PREVIEW_EDGE_LINES * 2);
  const preview = [
    `[OUTPUT SPILLED TO DISK — ${label}]`,
    `Full log (${totalBytes} bytes, ${totalLines} lines) saved to: .agent/logs/${fileName}`,
    `--- HEAD (first ${Math.min(PREVIEW_EDGE_LINES, totalLines)} lines) ---`,
    head,
    omittedLines > 0
      ? `\n... [${omittedLines} lines omitted — inspect .agent/logs/${fileName} or use rag_search] ...\n`
      : "",
    tail ? `--- TAIL (last ${PREVIEW_EDGE_LINES} lines) ---\n${tail}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    spilled: true,
    content: preview,
    logFilePath,
    totalBytes,
    totalLines,
  };
}

export interface SummarizeContextResult {
  worklog_updated: boolean;
  tokens_freed: number;
  archived_turns: number;
  worklog_entry: string;
}

/**
 * Heavy-Context Survival: `summarize_context` (on-demand or auto at ~70% fill).
 * Archives raw Layer 6 turn traces into Hybrid RAG so nothing is permanently lost,
 * appends a structured milestone entry to `WORKLOG.md`, updates `.agent/state.json`,
 * and flushes stale turns while retaining the most recent 2 turns.
 */
export function summarizeAndCompactContext(params: {
  workspaceDir: string;
  workingTurns: ChatTurn[];
  reason: string;
  preserve_notes?: string;
  ragIndex?: HybridRagIndex;
  keepRecentTurns?: number;
}): { result: SummarizeContextResult; remainingTurns: ChatTurn[]; updatedWorklog: string } {
  const keepCount = params.keepRecentTurns ?? 2;
  const archiveCount = Math.max(0, params.workingTurns.length - keepCount);
  const toArchive = params.workingTurns.slice(0, archiveCount);
  const remainingTurns = params.workingTurns.slice(archiveCount);

  const beforeTokens = params.workingTurns.reduce((s, t) => s + estimateTokens(t.content), 0);
  const afterTokens = remainingTurns.reduce((s, t) => s + estimateTokens(t.content), 0);
  const tokensFreed = Math.max(0, beforeTokens - afterTokens);

  const timestamp = new Date().toISOString();
  const rawTrace = toArchive
    .map((t) => `[${t.timestamp}] ${t.role}${t.toolName ? `(${t.toolName})` : ""}: ${t.content}`)
    .join("\n");

  // Archive raw trace into Hybrid RAG so compacted details remain searchable
  const archiveId = `worklog-archive-${randomUUID().slice(0, 8)}`;
  if (params.ragIndex && rawTrace.trim()) {
    params.ragIndex.addDocument({
      sourcePath: `.agent/archives/${archiveId}.log`,
      scope: "worklogs",
      content: rawTrace,
    });
  }

  // Build concise structured WORKLOG entry
  const keyBullets = toArchive
    .filter((t) => t.content.trim().length > 0)
    .slice(-5)
    .map((t) => `- (${t.role}${t.toolName ? `/${t.toolName}` : ""}) ${t.content.replace(/\s+/g, " ").slice(0, 140)}`)
    .join("\n");

  const entry = [
    `\n## Compaction Milestone — ${timestamp}`,
    `- **Reason:** ${params.reason}`,
    params.preserve_notes ? `- **Preserved Notes:** ${params.preserve_notes}` : null,
    `- **Archived Turns:** ${archiveCount} (RAG ref: \`.agent/archives/${archiveId}.log\`, freed ~${tokensFreed} tokens)`,
    keyBullets ? `### Key Trace Highlights\n${keyBullets}` : null,
    "",
  ]
    .filter(Boolean)
    .join("\n");

  mkdirSync(join(params.workspaceDir, ".agent"), { recursive: true });
  const worklogPath = join(params.workspaceDir, "WORKLOG.md");
  if (!existsSync(worklogPath)) {
    writeFileSync(worklogPath, "# WORKLOG\n", "utf8");
  }
  appendFileSync(worklogPath, entry, "utf8");
  const updatedWorklog = readFileSync(worklogPath, "utf8");

  // Update .agent/state.json
  const statePath = join(params.workspaceDir, ".agent", "state.json");
  const statePayload = {
    lastCompactedAt: timestamp,
    reason: params.reason,
    archivedTurns: archiveCount,
    tokensFreed,
    archiveRef: archiveId,
  };
  writeFileSync(statePath, JSON.stringify(statePayload, null, 2), "utf8");

  return {
    result: {
      worklog_updated: true,
      tokens_freed: tokensFreed,
      archived_turns: archiveCount,
      worklog_entry: entry,
    },
    remainingTurns,
    updatedWorklog,
  };
}

export interface DoomLoopVerdict {
  tripped: boolean;
  consecutiveFailures: number;
  signature: string;
  interventionDirective?: string;
  recommendedActions?: Array<"consult_expert" | "git_rollback" | "ground_broadcast_blocked">;
}

/**
 * Heavy-Context Survival: Doom-Loop Circuit Breaker (Issue #20357 §3.B.4).
 * Tracks a rolling hash of `(tool_name, normalized_args, error_signature)`.
 * Intercepts 3 consecutive identical tool failures and forces escalation.
 */
export class DoomLoopCircuitBreaker {
  private readonly threshold: number;
  private lastSignature: string | null = null;
  private consecutiveCount = 0;
  private tripHistory: Array<{ timestamp: string; signature: string; toolName: string }> = [];

  constructor(threshold = 3) {
    this.threshold = threshold;
  }

  private computeSignature(
    toolName: string,
    args: unknown,
    errorSignature: string,
  ): string {
    const normalizedArgs = JSON.stringify(args ?? {}, Object.keys((args as object) ?? {}).sort());
    const normalizedErr = errorSignature.trim().replace(/\d+/g, "#").slice(0, 200);
    return createHash("sha256")
      .update(`${toolName}::${normalizedArgs}::${normalizedErr}`)
      .digest("hex")
      .slice(0, 16);
  }

  recordSuccess(): void {
    this.lastSignature = null;
    this.consecutiveCount = 0;
  }

  recordFailure(
    toolName: string,
    args: unknown,
    errorSignature: string,
  ): DoomLoopVerdict {
    const signature = this.computeSignature(toolName, args, errorSignature);
    if (signature === this.lastSignature) {
      this.consecutiveCount += 1;
    } else {
      this.lastSignature = signature;
      this.consecutiveCount = 1;
    }

    if (this.consecutiveCount >= this.threshold) {
      this.tripHistory.push({
        timestamp: new Date().toISOString(),
        signature,
        toolName,
      });
      return {
        tripped: true,
        consecutiveFailures: this.consecutiveCount,
        signature,
        recommendedActions: ["consult_expert", "git_rollback", "ground_broadcast_blocked"],
        interventionDirective: `DOOM-LOOP INTERCEPTED: Tool "${toolName}" failed ${this.consecutiveCount} consecutive times with identical signature (${signature}). Stop retrying. Immediately invoke consult_expert, git_rollback to last passing checkpoint, or ground_broadcast(kind="blocked").`,
      };
    }

    return {
      tripped: false,
      consecutiveFailures: this.consecutiveCount,
      signature,
    };
  }

  getTripHistory(): Array<{ timestamp: string; signature: string; toolName: string }> {
    return [...this.tripHistory];
  }
}

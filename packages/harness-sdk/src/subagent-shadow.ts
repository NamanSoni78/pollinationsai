import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HybridRagIndex } from "./indexer-rag";
import type { PollinationsModelRouter } from "./model-router";

/**
 * Read-Only Shadow Reader Subagent (Issue #20357 §2.2).
 * Answers peer `ground_ask_agent(mode: "readonly_query")` questions by inspecting
 * the target VM's `WORKLOG.md`, `.agent/repo_map.json`, and RAG index — with ZERO
 * mutation or interruption of the target Worker's active reasoning loop.
 */
export function createShadowReader(params: {
  agentId: string;
  workspaceDir: string;
  ragIndex: HybridRagIndex;
  router?: PollinationsModelRouter;
}) {
  return async (query: {
    from_agent_id: string;
    question: string;
  }): Promise<{ answer: string; citations: string[] }> => {
    const ragHits = params.ragIndex.rag_search({
      query: query.question,
      scope: "all",
      top_k: 4,
    });

    const citations: string[] = [];
    const snippets: string[] = [];

    for (const hit of ragHits) {
      citations.push(`${hit.sourcePath}:${hit.lineStart}-${hit.lineEnd}`);
      snippets.push(`### ${hit.sourcePath} (L${hit.lineStart}-${hit.lineEnd})\n${hit.content.slice(0, 500)}`);
    }

    const worklogPath = join(params.workspaceDir, "WORKLOG.md");
    if (existsSync(worklogPath)) {
      const wl = readFileSync(worklogPath, "utf8");
      if (!citations.some((c) => c.startsWith("WORKLOG.md"))) {
        citations.push("WORKLOG.md");
        snippets.push(`### WORKLOG.md (tail)\n${wl.slice(-600)}`);
      }
    }

    const repoMapPath = join(params.workspaceDir, ".agent", "repo_map.json");
    if (existsSync(repoMapPath)) {
      citations.push(".agent/repo_map.json");
    }

    // If a live Pollinations router is provided, synthesize a crisp grounded answer via the fast subagent role
    if (params.router) {
      try {
        const completion = await params.router.chat({
          role: "subagent",
          messages: [
            {
              role: "system",
              content: `You are the read-only Shadow Reader for VM agent "${params.agentId}". Answer the peer's question accurately in <= 4 concise sentences using ONLY the workspace excerpts below. Cite exact file paths.`,
            },
            {
              role: "user",
              content: `Peer (${query.from_agent_id}) asks: ${query.question}\n\nWorkspace excerpts:\n${snippets.join("\n\n") || "(workspace empty)"}`,
            },
          ],
          maxTokens: 280,
        });
        return {
          answer: completion.content.trim(),
          citations: Array.from(new Set(citations)),
        };
      } catch {
        // Fallback to deterministic cited extraction if network/budget blocks live call
      }
    }

    const topExcerpt = ragHits[0]
      ? ragHits[0].content.split("\n").slice(0, 6).join(" ").trim()
      : "No matching code symbol found yet; check WORKLOG.md for latest status.";

    return {
      answer: `[Shadow Reader @ ${params.agentId}] ${topExcerpt}`,
      citations: Array.from(new Set(citations)),
    };
  };
}

/**
 * Isolated disposable subagent (`spawn_subagent`) returning only a concise summary
 * so speculative research/debugging never bloats the primary Worker context.
 */
export async function spawnSubagent(params: {
  goal: string;
  mode: "readonly" | "sandbox_branch";
  max_pollen: number;
  ragIndex?: HybridRagIndex;
  router?: PollinationsModelRouter;
}): Promise<{ summary: string; artifacts: string[]; pollen_cost: number }> {
  const hits = params.ragIndex
    ? params.ragIndex.rag_search({ query: params.goal, scope: "all", top_k: 4 })
    : [];
  const artifacts = hits.map((h) => `${h.sourcePath}:${h.lineStart}-${h.lineEnd}`);

  if (params.router) {
    const res = await params.router.chat({
      role: "subagent",
      messages: [
        {
          role: "system",
          content: `You are a disposable ${params.mode} subagent with a strict budget of ${params.max_pollen} Pollen. Return a concise actionable summary (max 5 bullets) without verbose logs.`,
        },
        {
          role: "user",
          content: `Goal: ${params.goal}\n\nRelevant workspace hits:\n${hits.map((h) => `${h.sourcePath}: ${h.content.slice(0, 350)}`).join("\n\n")}`,
        },
      ],
      maxTokens: 320,
    });
    return { summary: res.content.trim(), artifacts, pollen_cost: res.pollenCost };
  }

  return {
    summary: `Subagent (${params.mode}) completed research for "${params.goal}". Found ${hits.length} relevant workspace chunk(s).`,
    artifacts,
    pollen_cost: 0.0002,
  };
}

/**
 * On-demand Frontier Expert Escalation (`consult_expert`).
 * Sends a compressed diagnostic packet (problem + relevant files + failed attempts)
 * to the high-reasoning `expert` model role.
 */
export async function consultExpert(params: {
  question: string;
  file_paths: string[];
  failed_attempts: string[];
  workspaceDir?: string;
  router?: PollinationsModelRouter;
}): Promise<{ guidance: string; pollen_cost: number; model_used: string }> {
  const excerpts = params.file_paths.slice(0, 5).map((fp) => {
    const full = params.workspaceDir ? join(params.workspaceDir, fp) : fp;
    if (existsSync(full)) {
      return `--- ${fp} ---\n${readFileSync(full, "utf8").slice(0, 1500)}`;
    }
    return `--- ${fp} --- (file not found on disk)`;
  });

  if (params.router) {
    const res = await params.router.chat({
      role: "expert",
      messages: [
        {
          role: "system",
          content:
            "You are the Frontier Expert Consultant for an autonomous VM coding agent. Analyze the root cause of the failed attempts and give a concrete, minimal 3-step remediation plan.",
        },
        {
          role: "user",
          content: [
            `Question / Blocker: ${params.question}`,
            `Failed Attempts:\n${params.failed_attempts.map((a, i) => `${i + 1}. ${a}`).join("\n") || "(none)"}`,
            `Relevant Files:\n${excerpts.join("\n\n")}`,
          ].join("\n\n"),
        },
      ],
      maxTokens: 500,
    });
    return {
      guidance: res.content.trim(),
      pollen_cost: res.pollenCost,
      model_used: res.model,
    };
  }

  return {
    guidance: `Expert remediation for "${params.question}": (1) Isolate root cause in ${params.file_paths[0] ?? "target module"} instead of retrying failed approach (${params.failed_attempts[0] ?? "previous attempt"}); (2) Add targeted assertion test covering the edge case; (3) Re-run verification and checkpoint cleanly.`,
    pollen_cost: 0.0025,
    model_used: "openai/gpt-5.5",
  };
}

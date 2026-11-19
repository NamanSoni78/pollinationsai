/**
 * "harness-tools" MCP server: the SDK tool surface (quest section "Core
 * Harness SDK Tool Surface") exposed to every child VM over MCP. Mirrors the
 * repo's packages/mcp service style: [name, description, zod schema, handler].
 * Tools operate on one workspace (env HARNESS_WORKSPACE, default cwd) and a
 * headless runtime state — the full AgentRuntime binder (createAgentRuntime)
 * layers these same primitives with the ground hub on top.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { compileContext, estTokens, maybeCompact } from "./context.js";
import { gitBranchExperiment, gitCheckpoint, gitRollback } from "./git.js";
import { buildRepoMap } from "./indexer.js";
import { buildIndex, ragSearch } from "./rag.js";
import { roleRouter } from "./router.js";
import { listSkills, loadSkill, scanSkills, unloadSkill } from "./skills.js";
import { sleepVia } from "./sleep.js";

const workspace = () =>
    process.env.HARNESS_WORKSPACE
        ? join(process.env.HARNESS_WORKSPACE)
        : process.cwd();

/** Headless state per tool call — the runtime binder owns the long-lived one. */
const headlessState = () => {
    const ws = workspace();
    return {
        agentId: "harness-tools",
        role: "worker",
        workspace: ws,
        messages: [],
        worklog: "",
        skills: [],
        skillsCatalog: scanSkills({ workspace: ws }),
        telemetry: {
            gitStatus: null,
            lastCommits: [],
            contractProgress: null,
            inbox: [],
            budgetPct: 0,
            directives: [],
        },
        workingWindow: { turns: [] },
        contextBudgetTokens: 100000,
    };
};

const ok = (payload) => ({
    content: [{ type: "text", text: JSON.stringify(payload) }],
});
const fail = (error) => ({
    isError: true,
    content: [
        {
            type: "text",
            text: JSON.stringify({ error: String(error?.message ?? error) }),
        },
    ],
});

const WORKSPACE = {
    workspace: z
        .string()
        .describe(
            "Workspace to operate on (default: HARNESS_WORKSPACE env or cwd)",
        ),
};

export const harnessTools = [
    [
        "summarize_context",
        "Compile the deterministic 6-layer context and return per-layer token estimates; compacts the working window at ~70% fill.",
        {
            reason: z
                .string()
                .optional()
                .describe("Why the summary is requested"),
            workspace: WORKSPACE.workspace,
        },
        async ({ workspace: ws } = {}) => {
            try {
                process.env.HARNESS_WORKSPACE = ws ?? workspace();
                const state = headlessState();
                const compiled = compileContext(state);
                const compacted = maybeCompact(state);
                return ok({
                    tokenEstimate: compiled.tokenEstimate,
                    layerTokens: Object.fromEntries(
                        Object.entries(compiled.layers).map(([key, value]) => [
                            key,
                            estTokens(value),
                        ]),
                    ),
                    compacted,
                });
            } catch (error) {
                return fail(error);
            }
        },
    ],
    [
        "consult_expert",
        "Escalate a hard blocker to the expert model (deterministic packet by default; live via the BYOP proxy when HARNESS_PROXY_BASE is set).",
        {
            question: z.string(),
            file_paths: z.array(z.string()).optional(),
            failed_attempts: z.array(z.string()).optional(),
        },
        async ({ question, file_paths = [], failed_attempts = [] } = {}) => {
            try {
                const base = process.env.HARNESS_PROXY_BASE;
                if (!base) {
                    const packet = [
                        "# Expert consultation request",
                        `## Question\n${question}`,
                        ...(file_paths.length
                            ? [
                                  "## File excerpts",
                                  ...file_paths.flatMap((p) => [
                                      `### ${p}`,
                                      readFileSync(join(workspace(), p), "utf8")
                                          .split("\n")
                                          .slice(0, 40)
                                          .join("\n"),
                                  ]),
                              ]
                            : []),
                        ...(failed_attempts.length
                            ? [
                                  "## Failed attempts",
                                  ...failed_attempts.map(
                                      (a, i) => `${i + 1}. ${a}`,
                                  ),
                              ]
                            : []),
                    ].join("\n");
                    return ok({
                        guidance: packet,
                        pollen_cost: 0,
                        mode: "deterministic",
                    });
                }
                const model = roleRouter().resolve("EXPERT").model;
                const response = await fetch(`${base}/v1/chat/completions`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        authorization: "Bearer byop-proxy",
                    },
                    body: JSON.stringify({
                        model,
                        messages: [
                            {
                                role: "user",
                                content: `# Expert consultation request\n${question}`,
                            },
                        ],
                    }),
                });
                const data = await response.json();
                return ok({
                    guidance: data?.choices?.[0]?.message?.content ?? "",
                    pollen_cost: data?.usage
                        ? (data.usage.prompt_tokens ?? 0) * 1e-7 +
                          (data.usage.completion_tokens ?? 0) * 5e-7
                        : 0,
                    mode: "live",
                    model,
                });
            } catch (error) {
                return fail(error);
            }
        },
    ],
    [
        "spawn_subagent",
        "Run a disposable subagent: readonly research over the workspace (BM25), or a sandbox git branch for risky work.",
        {
            goal: z.string(),
            mode: z.enum(["readonly", "sandbox_branch"]).optional(),
            workspace: WORKSPACE.workspace,
        },
        async ({ goal, mode = "readonly", workspace: ws } = {}) => {
            try {
                process.env.HARNESS_WORKSPACE = ws ?? workspace();
                if (mode === "sandbox_branch") {
                    const { branch } = gitBranchExperiment(workspace(), {
                        name: `subagent/${Date.now()}`,
                    });
                    return ok({
                        summary: `Sandbox branch ${branch} created for: ${goal}`,
                        artifacts: [],
                        branch,
                    });
                }
                const results = ragSearch(buildIndex(workspace()), goal, {
                    scope: "all",
                    top_k: 5,
                });
                return ok({
                    summary: [
                        `Readonly subagent research for: ${goal}`,
                        ...results.map(
                            (r) =>
                                `- ${r.file}:${r.startLine}-${r.endLine} ${r.preview.slice(0, 120)}`,
                        ),
                    ].join("\n"),
                    artifacts: [],
                    results,
                });
            } catch (error) {
                return fail(error);
            }
        },
    ],
    [
        "rag_search",
        "Hybrid BM25 search over the workspace (scopes: codebase, worklogs, docs, all).",
        {
            query: z.string(),
            scope: z.enum(["codebase", "worklogs", "docs", "all"]).optional(),
            top_k: z.number().int().positive().optional(),
            workspace: WORKSPACE.workspace,
        },
        async ({ query, scope = "all", top_k = 5, workspace: ws } = {}) => {
            try {
                process.env.HARNESS_WORKSPACE = ws ?? workspace();
                return ok({
                    results: ragSearch(buildIndex(workspace()), query, {
                        scope,
                        top_k,
                    }),
                });
            } catch (error) {
                return fail(error);
            }
        },
    ],
    [
        "list_skills",
        "List available dynamic skills (name + one-line description + est tokens).",
        { workspace: WORKSPACE.workspace },
        async ({ workspace: ws } = {}) => {
            try {
                process.env.HARNESS_WORKSPACE = ws ?? workspace();
                return ok({ skills: listSkills(headlessState()) });
            } catch (error) {
                return fail(error);
            }
        },
    ],
    [
        "load_skill",
        "Mount a skill's instructions into Layer 2 of the context (progressive disclosure).",
        { name: z.string(), workspace: WORKSPACE.workspace },
        async ({ name, workspace: ws } = {}) => {
            try {
                process.env.HARNESS_WORKSPACE = ws ?? workspace();
                const skill = loadSkill(headlessState(), name);
                return ok({
                    loaded: true,
                    instructions_injected: true,
                    name: skill.name,
                    tokens: skill.tokens,
                });
            } catch (error) {
                return fail(error);
            }
        },
    ],
    [
        "unload_skill",
        "Unmount a skill and reclaim its Layer 2 tokens.",
        { name: z.string(), workspace: WORKSPACE.workspace },
        async ({ name, workspace: ws } = {}) => {
            try {
                process.env.HARNESS_WORKSPACE = ws ?? workspace();
                const state = headlessState();
                const before = state.skills.reduce(
                    (sum, skill) => sum + (skill.tokens ?? 0),
                    0,
                );
                const unloaded = unloadSkill(state, name);
                const after = state.skills.reduce(
                    (sum, skill) => sum + (skill.tokens ?? 0),
                    0,
                );
                return ok(
                    unloaded
                        ? { unloaded: true, tokens_freed: before - after }
                        : { unloaded: false },
                );
            } catch (error) {
                return fail(error);
            }
        },
    ],
    [
        "sleep",
        "Wait for a timer or a Ground event (ground_artifact | ground_reply | process_exit) without burning tokens.",
        {
            seconds: z.number().positive().optional(),
            until_event: z
                .enum(["ground_artifact", "ground_reply", "process_exit"])
                .optional(),
            max_wait_sec: z.number().positive(),
        },
        async (params) =>
            ok(await sleepVia(params, { emitter: null, registry: new Map() })),
    ],
    [
        "git_checkpoint",
        "Atomic milestone commit with the pre-commit secret-leak guard.",
        { message: z.string(), workspace: WORKSPACE.workspace },
        async ({ message, workspace: ws } = {}) => {
            try {
                process.env.HARNESS_WORKSPACE = ws ?? workspace();
                return ok(gitCheckpoint(workspace(), { message }));
            } catch (error) {
                return fail(error);
            }
        },
    ],
    [
        "git_branch_experiment",
        "Create + checkout an experiment branch for risky work.",
        { name: z.string(), workspace: WORKSPACE.workspace },
        async ({ name, workspace: ws } = {}) => {
            try {
                process.env.HARNESS_WORKSPACE = ws ?? workspace();
                return ok(gitBranchExperiment(workspace(), { name }));
            } catch (error) {
                return fail(error);
            }
        },
    ],
    [
        "git_rollback",
        "Roll the workspace back to a sha/tag after a failed attempt.",
        { ref: z.string(), workspace: WORKSPACE.workspace },
        async ({ ref, workspace: ws } = {}) => {
            try {
                process.env.HARNESS_WORKSPACE = ws ?? workspace();
                return ok(gitRollback(workspace(), { ref }));
            } catch (error) {
                return fail(error);
            }
        },
    ],
    [
        "build_repo_map",
        "Refresh the Indexer's .agent/repo_map.json (files, exports, routes).",
        { workspace: WORKSPACE.workspace },
        async ({ workspace: ws } = {}) => {
            try {
                process.env.HARNESS_WORKSPACE = ws ?? workspace();
                return ok(buildRepoMap(workspace()));
            } catch (error) {
                return fail(error);
            }
        },
    ],
];

/** Build an McpServer with the harness tools registered (stdio use). */
export async function buildHarnessServer() {
    const { McpServer } = await import("@modelcontextprotocol/server");
    const server = new McpServer({ name: "harness-tools", version: "0.1.0" });
    for (const [name, description, schema, handler] of harnessTools) {
        server.registerTool(
            name,
            { description, inputSchema: z.object(schema) },
            handler,
        );
    }
    return server;
}

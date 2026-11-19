# pollinations-harness-sdk

Child VM harness SDK for Agent Ground: the heavy-context layer that extends
the OpenCode harness inside every agent workspace.

## What

- `context.js` — `compileContext` / `maybeCompact`: deterministic 6-layer
  context; Layer 3 (all past user messages, verbatim) is never dropped.
- `spill.js` — `captureOutput`: >4096-byte output spills to
  `.agent/logs/<uuid>.txt` with a first-25/last-25-line preview.
- `skills.js` — `scanSkills` / `listSkills` / `loadSkill` / `unloadSkill`
  (Layer 2; workspace skills win over repo `.agents/skills`).
- `rag.js` — `buildIndex` / `ragSearch`: BM25 (k1=1.5, b=0.75) over ~40-line
  chunks; scopes `codebase|docs|worklogs|all`.
- `doomloop.js` — `trackCall`: 3 identical failures → consult_expert directive.
- `sleep.js` — `sleepVia`: event-aware sleep (`ground_artifact`, `ground_reply`,
  `process_exit`).
- `git.js` — `initWorkspaceGit` / `gitCheckpoint` (pre-commit secret scan) /
  `gitBranchExperiment` / `gitRollback` / `secretScan`.
- `indexer.js` — `buildRepoMap`: exports + routes map at `.agent/repo_map.json`.
- `shadow.js` — `shadowRead`: BM25 answer with `file:line` citations; zero
  writes to the target workspace.
- `router.js` — `roleRouter` (env `*_MODEL` overridable) / `resolveGitIdentity`.
- `opencode.js` — `configureOpenCodeAgent`: OpenCode provider block pointing
  at the BYOP proxy plus our MCP servers.
- `agent.js` — `createAgentRuntime`: card, inbox-at-boundary, step, tools,
  milestone.

## Run

    npm test        # node --test test/*.test.js

Offline: temp workspaces (real `git` binary inside them) and a read-only load
of the repo skill `.agents/skills/ponytail/SKILL.md`. Zero runtime deps,
Node >= 20. Token estimates are `chars / 4`. Default MCP server paths in
`configureOpenCodeAgent` are repo-relative placeholders — pass `mcpServers`
and/or `repoRoot` to point at real ones.

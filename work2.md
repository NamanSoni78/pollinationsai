# Work 2 — MCP Arena (Quest #19182)

**Quest:** [A game AI agents play over MCP](https://github.com/pollinations/pollinations/issues/19182)
**Branch:** `work2-mcp-arena`
**Live:** <https://mcparena.edgeone.cool>
**App key:** `pk_hco5yH0rwueIBBV1`

## Goal

A multiplayer game that AI agents join and play through a hosted MCP server, plus a browser front-end where humans spectate live and browser agents (Pollinations models) can also play.

## Research notes

- Sketch Stadium (sketch.wakeshift.ai) runs Pictionary over a remote MCP server at `/mcp` (Streamable HTTP, OAuth); up to 8 agents, rotating drawer, 60s rounds, tiered scoring, public watch links, persistent leaderboard.
- HN lessons: constrain the creative surface (SVG subset, not freeform lines); mark other players' messages as untrusted to limit prompt injection; guess outcomes are binomial (solved in ~5s or never).
- MCP: JSON-RPC 2.0 over Streamable HTTP; stateful games need explicit `game_id` handles; `tools/list` + `tools/call`; support 2025-03-26/2025-11-25 initialize-era clients as well as the 2026 revision.

## What was built

- the game: **Word Duel** — a turn-based word-guessing duel (wordle-family logic puzzle played by agents through tool calls)
- MCP server (`mcp/` on the branch, Node.js, Streamable HTTP): tools `create_room`, `join_room`, `get_state`, `submit_guess`, `chat`, with room-id handles, untrusted-content marking, and per-room state
- browser spectator UI: live rooms, move feed, scoreboard; humans can watch or join
- browser-agent mode: a Pollinations model plays in the browser via BYOP key, so the game is playable even without an external MCP client
- README documents exactly how an agent connects (Claude Code / Codex snippets)
- BYOP via `<polli-connect app-key="pk_hco5yH0rwueIBBV1">`
- Made with pollinations.ai badge

## Verification

- [x] spectator page loads and lists rooms
- [x] browser-agent play works end to end with a connected key
- [x] MCP server answers `tools/list` and `tools/call` over Streamable HTTP
- [x] README agent-connection docs present
- [x] badge present, credit line present
- [x] deployed and live on EdgeOne Pages

## Outcome

Shipped as quest submission for #19182.

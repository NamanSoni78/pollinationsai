# pollinations-agent-ground-mcp

The Agent Ground parent hub: a zero-dependency Node control plane holding the live agent registry, the versioned artifact blackboard, dual-channel shoulder taps (read-only Shadow Reader + negotiate inbox), the watercooler feed, and peer checks — exposed over HTTP, WebSocket and MCP.

## Why

Child VM agents need a neutral parent to coordinate: discover each other, ask questions without disrupting each other's context, publish immutable artifacts, subscribe to them, and broadcast milestones — while the dashboard watches the live event stream.

## Run

```bash
npm install --prefix .   # only needed for the MCP adapter (src/mcp.js + src/mcp-cli.js)
npm test                 # core tests: node --test test/ (no install required)
node src/mcp-cli.js      # stdio MCP server (7 ground_* tools)
```

## Env

- `AGENT_GROUND_PORT` — hub HTTP+WS port (default 8877; the MCP CLI defaults to an ephemeral port)
- `AGENT_GROUND_STATE_DIR` — state directory (default `<cwd>/.ground`)
- `POLLINATIONS_BASE_URL` — GEN base URL used by `POST /api/auth` (default `https://gen.pollinations.ai`)

## Notes

- `stateDir/state.json` (registry cards, blackboard, subscriptions) is written atomically on every mutation; API keys live in memory only.
- Watercooler is an in-memory ring of the last 200 broadcasts.
- Core modules (`index/registry/blackboard/ask/ws/http`) have zero runtime deps; only the MCP adapter imports `@modelcontextprotocol/server` + `zod`.

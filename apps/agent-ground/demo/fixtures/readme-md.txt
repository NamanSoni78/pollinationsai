# Pollen Pulse

A live pollen-budget dashboard for Agent Ground users, built by two child VM
agents (backend API + frontend UI) collaborating through the Agent Ground hub.

- `web/` — the static dashboard (plain HTML/CSS/JS, no runtime deps)
- `smoke.mjs` — end-to-end smoke check (`node smoke.mjs`)
- Session API contract: `openapi-spec` artifact on the Ground blackboard

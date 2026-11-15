[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations.ai/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

# Pollen Towers

**Build your own tower of AI-run companies.** A static web app for Pollinations quest #17999 — a personal take on [Towers](https://towers.app) (originally thetowers.ai), where a building holds 112 companies and every floor is one business run by a single person plus their AI agents. Here the tower has 30 floors, floors 2-8 come pre-seeded with demo companies, and the rest are for rent: rent a floor, found a company, and let your agent staff do the daily work while you make the decisions.

## What it is

- **The tower** — a CSS 3D building (perspective + rotateX/rotateY, drag with mouse or touch to spin it). 30 floors stacked bottom-up; floor 1 is the lobby, lit floors are companies, dashed floors are for rent.
- **Founder flow** — rent an empty floor with a name, a one-line pitch and an industry. Three generation calls run in parallel on your key: a company profile, an 80-word launch post in the founder's voice, and a logo image that becomes the floor's icon.
- **Agent standups (the core loop)** — every rented office has three agent personas: Researcher 🔍 (today's market insight + one recommendation), Marketer 📣 (a social post drafted from that insight) and Ops ⚙️ (a changelog plus one decision card). The calls are chained: each agent sees the company profile and the previous agent's output. A standup costs roughly 3 chat calls of Pollen.
- **Decision cards** — the Ops agent brings one decision to you, the human owner. Approve ✅ or Redirect ↪ with an optional note; the choice is appended to the office's decision log.
- **Directory** — searchable, category-filterable list of all companies (seeded + user-founded); click through to the office panel with profile, launch post, logo, last 3 standups with artifacts, decision log and floor number.
- **State** — everything persists in `localStorage` (floors, companies, standups, decisions). A "Reset tower" button (with confirm) reseeds the demo building.

## How to run

No build step. Serve the folder statically (or just open the file):

```bash
cd pollinations-towers
python3 -m http.server 8080   # then open http://localhost:8080
```

The tower renders with the 7 seeded companies even without a key. To rent a floor or run a standup, press **Connect** (top-right `<polli-connect>`) and bring your own Pollen (BYOP) key — generation is billed to your key.

## Endpoints (all on the user's BYOP key via `polli-connect`)

| Endpoint | Used for | Model | Calls |
| --- | --- | --- | --- |
| `POST /v1/chat/completions` | Company profile (JSON: tagline, story, 3 products, target customer) | `openai/gpt-5.4-nano` | 1 per rental |
| `POST /v1/chat/completions` | Launch post, 80 words, founder's voice | `openai/gpt-5.4-nano` | 1 per rental |
| `GET /image/{prompt}` | Logo emblem for the floor icon (512×512, flat vector style) | `black-forest-labs/flux.1-schnell` | 1 per rental |
| `POST /v1/chat/completions` | Standup: Researcher 🔍 today's insight + recommendation | `openai/gpt-5.4-nano` | 1 per standup |
| `POST /v1/chat/completions` | Standup: Marketer 📣 social post from the insight | `openai/gpt-5.4-nano` | 1 per standup |
| `POST /v1/chat/completions` | Standup: Ops ⚙️ changelog + decision card for the owner | `openai/gpt-5.4-nano` | 1 per standup |

## BYOP note

This app uses **Bring Your Own Pollen**: no keys are embedded or proxied. The `<polli-connect>` component (app key `pk_HoExZJIrsjeK3i46`) lets each user attach their own Pollen key; the key lives in their browser session and every generation call — chat and image — is made directly from the browser against `gen.pollinations.ai` with that key. Without a key the app is fully browsable: the tower, seeded companies and directory all render from local state.

## Files

- `index.html` — page shell, tower CSS, script order: `pollinations.js` → `polli-common.js` → `app.js`
- `app.js` — app logic (3D tower, rent/founder flow, standup loop, directory, localStorage state)
- `pollinations.js`, `polli-common.js`, `polli.css` — shared Pollinations quest libraries (unmodified)

Credit Pollinations — Made with pollinations.ai

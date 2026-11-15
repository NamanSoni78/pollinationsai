[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

# WorldSim Terminal

A fake CRT terminal with no real shell, where a Pollinations AI model plays the
part of an entire computer — and the world around it. Every command you type is
answered *as terminal output*: the model maintains a consistent invented
filesystem, remembers files you created, returns plausible machine errors for
nonsense, and hides four secrets per machine.

## What it does

- **CRT terminal UI** — dark screen, green/amber phosphor text per machine,
  blinking block cursor, scanline + vignette overlay, click-to-focus, typing
  input line at the bottom, command history with ↑/↓.
- **Four boot images** (machine personalities), each with its own system-prompt
  persona and boot sequence animation:
  - `linux` — a Linux server in a strange world (fog eats backups, bees deliver mail)
  - `haunted-vax` — an old haunted VAX mainframe in a university basement
  - `nes-console` — an 8-bit game console cartridge (2 KB RAM, strong opinions)
  - `alien-mainframe` — the ship computer ZRX-9 of an alien survey vessel orbiting Earth
- **Consistent world state** — the full command history (last 30 turns) is sent
  with every request, so files and facts stay consistent across commands.
- **Local cache layer** — file listings (`ls`, `dir`, `find`, ...) and file
  contents (`cat`, `less`, ...) are parsed into local JS state keyed by
  machine + path/command; repeating `cat samefile` replays the cached output
  with a subtle `[cached]` marker — consistency plus pollen savings.
- **Secret hunt** — 4 hardcoded secrets per persona (e.g. `/etc/shadow`
  contains a love letter, `matrix` does something, the user `ghost` exists,
  `sudo make-me-a-sandwich` works). Model output is matched against keyword
  patterns; unlocks show a banner and a "Discoveries: n/4" panel with hints.
  All four triggers a celebration.
- **Local commands** — `help`, `clear`, `boot <persona>`, `model <id>`
  (default `openai/gpt-5.4-nano` for speed, switchable to `openai/gpt-5.4`),
  `secrets`. Everything else goes to the model.

## How to run

No build step. Either open `index.html` directly in a browser, or serve the
folder (recommended, so the connect component loads cleanly):

```bash
cd pollinations-worldsim
python3 -m http.server 8000
# open http://localhost:8000
```

Files: `index.html` (page + CRT skin) · `app.js` (terminal, personas, cache,
secret hunt) · `pollinations.js` / `polli-common.js` / `polli.css` (shared
Pollinations helpers) · this README.

## Endpoints used

| Endpoint | Method | Auth | Used for |
| --- | --- | --- | --- |
| `https://gen.pollinations.ai/v1/chat/completions` | POST | Bearer `sk_…` (BYOP) | Every command is answered by the model as terminal output |
| `https://gen.pollinations.ai/v1/models` | GET | public | Model catalogue (PolliClient helper) |
| `https://gen.pollinations.ai/account/balance` | GET | Bearer `sk_…` | Pollen balance check |
| `https://enter.pollinations.ai` (polli-connect component) | — | app key `pk_…` | BYOP connect / buy-pollen flow in the header |

## BYOP (Bring Your Own Pollen)

This app ships without any embedded user key. Press **Connect** in the header
to link your Pollen (an `sk_` key); it is kept in `sessionStorage` only, for
this tab, this session. The app key (`pk_…`) only identifies the app for the
connect flow and its default pollen budget. If no key is connected, commands
print a friendly "not connected" message instead of calling the API.

Credit Pollinations — Made with pollinations.ai

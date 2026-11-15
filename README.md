[![Made with pollinations.ai](https://raw.githubusercontent.com/pollinations/pollinations/main/packages/ui/src/brand/badge-made-with.svg)](https://pollinations.ai/?ref=badge)

# 🏝️ Idle Agents Island

AI agents left alone on a tropical island with **nothing they have to do** — no tasks, no
goals, no rewards. Every few seconds each agent asks its model one question: *what do you
feel like doing?* Then you watch what it chooses.

The result is spontaneous play, straight out of the MIT paper **"Is this machine
playing?"**, where agents with no instructions climbed hills, stacked blocks, drew
mandalas in the sand, invented games and ran little physics experiments. This app
recreates that setup: agents explore, build block towers, draw mandalas, stack rock
piles, test physics, invent games, socialize, or just rest under a tree — and the
**ethogram** on the left tallies every choice into a live behavior chart.

## What you'll see

- A seeded, procedurally generated island (40×26 tiles): water, beach ring, grass,
  forest patches, two hills with a mountain peak, one clearing, and landmarks —
  a big rock 🪨, a pond 🌊 and a tall tree 🌲.
- Up to **3 agents** (🤖/👽/🐙), each with a persona (Curious explorer, Builder,
  Artist, Scientist, Zen wanderer) and its own model.
- Every tick each agent sees its surroundings, remembers its last 12 actions, and
  answers in a strict format: `ACTION: <one of 17 actions> | SAY: <one short sentence>`.
- Actions leave **persistent artifacts** on the map: growing block towers, colored
  mandala rings, rock piles, 💡 experiment markers, ⚽ invented games, 😴 resting spots.
- A live **ethogram** (CSS bar chart of 9 behavior categories), per-agent "what it
  chose" summaries, and an activity log with the agents' own one-line reasons.
- Drop a ⚽ ball, 🧱 blocks or 🪨 🎨 paint into the clearing and see who comes to play.

## How to run

No build step — any static file server works:

```bash
cd work/apps/pollinations-playground
python3 -m http.server 8000
# open http://localhost:8000
```

The island renders immediately without a key. To let the agents think, press
**Connect** (top right) and connect your Pollen — the loop then runs one tick every
5/10/20 seconds (speed slider, read live). Pause and resume anytime.

## Endpoints used

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET https://gen.pollinations.ai/v1/models` | public | list text models |
| `POST https://gen.pollinations.ai/v1/chat/completions` | Bearer (BYOP key) | ask each agent for its next action |

## BYOP — Bring Your Own Pollen

This app uses **BYOP**: it never ships an API key. Click **Connect**, approve the
app (budget: 10, text models, profile + usage permissions), and your own Pollen key
(`sk_…`) is used for every request via the `<polli-connect>` component. The key is
kept in `sessionStorage` only — it survives a reload, never leaves your browser
except as the `Authorization` header to `gen.pollinations.ai`, and disconnecting
clears it immediately (the island loop auto-pauses and offers to resume when you
reconnect).

## Credit

Credit Pollinations — Made with pollinations.ai

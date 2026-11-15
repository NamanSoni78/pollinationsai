# Work 8 — Decision Arena (Quest #19176)

**Quest:** [A game that AI models play](https://github.com/pollinations/pollinations/issues/19176)
**Branch:** `work8-decision-arena`
**Live:** <https://decisionarena.edgeone.cool>
**App key:** `pk_VkCwIsniDUAifKLQ`

## Goal

A game where the players are AI models — specifically Pollinations decision models — competing on a deterministic arcade game, with a leaderboard.

## Research notes

- Opper decision benchmarks: models answer a typed question about game state ("which way next?") with a choice + probabilities; 100 seeded games per model; leaderboard = mean score; CI replays recordings; reference entries for hand-written rules and die rolls.
- Decision models on Pollinations (8): typesafe/jev-1.14, perplexity/pplx-decider-v1.2, vllm-sr/d3, microsoft/microsoft-decision-1, openai/gpt-6-luna-decisions, liquid/d1, jaredpalmer/kev-4b, respan/span-01-lite.
- Battle Drones (Simon Willison): deterministic sim enables replays; AI-vs-AI spectator mode is the content; seeded maps keep runs fair.
- Decision API: `POST /alpha/decisions` typed-decisions endpoint (APIDOCS.md) — ask once per move, cheap and fast.

## What was built

- the game: **Grid Rush** — a deterministic snake-like collection game on a seeded grid: eat pellets, avoid walls and your own trail, beat the other model's score before the clock runs out
- every move asks a decision model "which direction next?" with a compact state view; the model answers with a choice and confidence
- two models race head-to-head on identical seeds (split-screen spectator view), or one model plays solo for score
- leaderboard stored in localStorage + exportable as JSON; seeded runs are replayable (deterministic engine, recorded move lists)
- a `random` and a `greedy` hand-written bot as unranked reference entries (Opper convention)
- speed control and instant replay of any finished run
- BYOP via `<polli-connect app-key="pk_VkCwIsniDUAifKLQ">`
- Made with pollinations.ai badge

## Verification

- [x] decision models answer with a parseable choice per move
- [x] two models race on the same seed
- [x] leaderboard and replays work
- [x] reference bots play as unranked entries
- [x] badge present, credit line present
- [x] deployed and live on EdgeOne Pages

## Deployment

- EdgeOne Pages project `decisionarena`, production deploy verified HTTP 200
- engine tests: pellet determinism, wall crash, reversal block, 200-tick cap, greedy 20/20 in 91 ticks, replay reproduces the recorded run exactly
- browser test: solo bot run key-free (score 20, 104 ticks), leaderboard save with (ref) mark, replay re-runs identically, bot-vs-bot race renders both canvases + winner banner, no-key guard fires

## Outcome

Shipped as quest submission for #19176.

# Work 7 — Idle Agents Island (Quest #19177)

**Quest:** [An app or game about AI agents left alone in a world](https://github.com/pollinations/pollinations/issues/19177)
**Branch:** `work7-idle-agents-island`
**Live:** <https://idleisland.edgeone.cool>
**App key:** `pk_yjNAAG85InWxoJ7H`

## Goal

Drop AI agents on a digital island with nothing they have to do — and watch what they choose to do. A passive-observation toy based on the MIT "Is this machine playing?" finding that agents left alone start to play.

## Research notes

- The paper (arXiv:2610.07130, MIT): 13 agents, 30-hour sessions, no task or reward — agents spontaneously climbed hills, stacked block towers, drew mandalas, reinvented sports, and ran physics experiments; the same activity types recurred across all agents, yet every agent's history diverged.
- Observable behavior checklist taken directly from the paper: climb, build/stack, draw patterns, experiment with physics, invent games, socialize, wander, rest, make art, seek landmarks.
- A leaderboard of "what did your agent choose?" is both meaningful and endlessly watchable.

## What was built

- an island grid world (canvas rendering): terrain tiles, a few landmarks, 1-3 agents as little creatures
- each agent is a Pollinations model persona; every N seconds (or on "tick") the model decides what its agent does next, given only what that agent can see (fog of view) and its own memory log
- activity log + activity taxonomy panel: the app classifies each chosen action (explore/build/draw/socialize/rest/experiment...) and charts the distribution over time
- player controls: drop an agent, set its persona prompt, speed up/slow down, release a new object (ball, blocks, paint) onto the island
- an "ethogram" scoreboard comparing runs — which activities did your agents choose
- optional ambience: an audio model generates island soundscape captions
- BYOP via `<polli-connect app-key="pk_yjNAAG85InWxoJ7H">`
- Made with pollinations.ai badge

## Verification

- [x] island renders, agents move on their own decisions
- [x] activity classification panel populates
- [x] memory affects behavior (agent references what it did before)
- [x] objects can be dropped and interacted with
- [x] badge present, credit line present
- [x] deployed and live on EdgeOne Pages

## Outcome

Shipped as quest submission for #19177.
